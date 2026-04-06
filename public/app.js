const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

// ===== STORAGE =====
function store(key, val) { localStorage.setItem("su_" + key, JSON.stringify(val)); }
function load(key, fallback) { try { return JSON.parse(localStorage.getItem("su_" + key)) || fallback; } catch { return fallback; } }

// ===== STATE =====
let profile = load("profile", null);
let sessions = load("sessions", []);
let difficulty = load("difficulty", "easy");
let currentMode = null;
let messages = [];
let turnCount = 0;
let openTranscript = "";
let timerInterval = null;
let timerSeconds = 0;
let isRecording = false;
let recognition = null;
let sessionStartTime = null;
let lastSessionMode = load("lastMode", null);

const today = new Date().toISOString().slice(0, 10);
let dailyContent = load("daily_" + today, null);

// ===== SPEECH ERROR DETECTION =====
// Detects stutters, repetitions, false starts, self-corrections
function analyzeSpeechErrors(text) {
  const errors = {
    stutters: [],       // "I I I think" → repeated words
    repetitions: [],    // "the the thing"
    falseStarts: [],    // "I was go— I was going"
    fillerSounds: [],   // "uh", "um", "er", "ah"
    selfCorrections: [],// "I mean", "wait no", "sorry I meant"
    totalErrors: 0,
  };

  if (!text || text.trim().length === 0) return errors;

  const words = text.toLowerCase().split(/\s+/);

  // Detect repeated words (stutters): "I I I", "the the the"
  let i = 0;
  while (i < words.length) {
    let repeatCount = 1;
    while (i + repeatCount < words.length && words[i + repeatCount] === words[i]) {
      repeatCount++;
    }
    if (repeatCount >= 2) {
      errors.stutters.push({ word: words[i], count: repeatCount, position: i });
    }
    i += repeatCount;
  }

  // Detect filler sounds
  const fillerSounds = ["uh", "um", "er", "ah", "uhh", "umm", "hmm", "hm", "ehh"];
  words.forEach((w, idx) => {
    const clean = w.replace(/[^a-z]/g, "");
    if (fillerSounds.includes(clean)) {
      errors.fillerSounds.push({ sound: clean, position: idx });
    }
  });

  // Detect self-correction phrases
  const correctionPhrases = ["i mean", "wait no", "sorry i meant", "let me rephrase", "what i meant", "no wait", "actually no", "hold on", "scratch that"];
  const lowerText = text.toLowerCase();
  correctionPhrases.forEach((phrase) => {
    let pos = 0;
    while ((pos = lowerText.indexOf(phrase, pos)) !== -1) {
      errors.selfCorrections.push({ phrase, position: pos });
      pos += phrase.length;
    }
  });

  // Detect repeated short phrases (2-3 word repetitions)
  for (let j = 0; j < words.length - 3; j++) {
    const twoWord = words[j] + " " + words[j + 1];
    const nextTwo = words[j + 2] + " " + (words[j + 3] || "");
    if (twoWord === nextTwo && twoWord.length > 3) {
      errors.repetitions.push({ phrase: twoWord, position: j });
    }
  }

  errors.totalErrors = errors.stutters.length + errors.fillerSounds.length +
    errors.selfCorrections.length + errors.repetitions.length;

  return errors;
}

// Build a summary string to pass to AI
function speechErrorSummary(errors) {
  if (errors.totalErrors === 0) return "";

  let summary = "\nSPEECH ERROR DETECTION (detected from audio transcription):";

  if (errors.stutters.length > 0) {
    summary += `\n- STUTTERS (${errors.stutters.length}): ` +
      errors.stutters.map((s) => `"${s.word}" repeated ${s.count}x`).join(", ");
  }
  if (errors.fillerSounds.length > 0) {
    const counts = {};
    errors.fillerSounds.forEach((f) => { counts[f.sound] = (counts[f.sound] || 0) + 1; });
    summary += `\n- FILLER SOUNDS (${errors.fillerSounds.length}): ` +
      Object.entries(counts).map(([s, c]) => `"${s}" x${c}`).join(", ");
  }
  if (errors.selfCorrections.length > 0) {
    summary += `\n- SELF-CORRECTIONS (${errors.selfCorrections.length}): ` +
      errors.selfCorrections.map((s) => `"${s.phrase}"`).join(", ");
  }
  if (errors.repetitions.length > 0) {
    summary += `\n- PHRASE REPETITIONS (${errors.repetitions.length}): ` +
      errors.repetitions.map((r) => `"${r.phrase}"`).join(", ");
  }

  return summary;
}

// ===== VOICE METRICS + TONE ANALYSIS (Web Audio API) =====
let audioContext = null;
let audioAnalyser = null;
let audioStream = null;
let volumeSamples = [];
let pitchSamples = [];
let energyOverTime = []; // energy snapshots every ~0.5s for contour
let silenceSegments = 0;
let lastWasSilent = false;
let toneAnalysisBuffer = null; // Float32 time-domain buffer for pitch
const SILENCE_THRESHOLD = 15;

function initAudioAnalysis(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioAnalyser = audioContext.createAnalyser();
  audioAnalyser.fftSize = 2048; // Larger FFT for pitch detection
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioAnalyser);
  audioStream = stream;
  volumeSamples = [];
  pitchSamples = [];
  energyOverTime = [];
  silenceSegments = 0;
  lastWasSilent = false;
  toneAnalysisBuffer = new Float32Array(audioAnalyser.fftSize);
  collectAudioData();
}

function collectAudioData() {
  if (!audioAnalyser || !isRecording) return;

  // Volume analysis (frequency domain)
  const freqData = new Uint8Array(audioAnalyser.frequencyBinCount);
  audioAnalyser.getByteFrequencyData(freqData);
  const avg = freqData.reduce((a, b) => a + b, 0) / freqData.length;
  volumeSamples.push(avg);

  // Silence detection
  if (avg < SILENCE_THRESHOLD) {
    if (!lastWasSilent) silenceSegments++;
    lastWasSilent = true;
  } else {
    lastWasSilent = false;
  }

  // Pitch detection using autocorrelation (only when there's voice)
  if (avg >= SILENCE_THRESHOLD) {
    audioAnalyser.getFloatTimeDomainData(toneAnalysisBuffer);
    const pitch = detectPitch(toneAnalysisBuffer, audioContext.sampleRate);
    if (pitch > 50 && pitch < 500) { // Human voice range
      pitchSamples.push(pitch);
    }
  }

  // Energy contour snapshot (every ~30 frames ≈ 0.5s at 60fps)
  if (volumeSamples.length % 30 === 0) {
    energyOverTime.push(avg);
  }

  if (isRecording) requestAnimationFrame(collectAudioData);
}

// Autocorrelation pitch detection
function detectPitch(buffer, sampleRate) {
  const SIZE = buffer.length;
  // Check if there's enough signal
  let rms = 0;
  for (let i = 0; i < SIZE; i++) rms += buffer[i] * buffer[i];
  rms = Math.sqrt(rms / SIZE);
  if (rms < 0.01) return -1; // Too quiet

  // Autocorrelation
  const correlations = new Array(SIZE).fill(0);
  for (let lag = 0; lag < SIZE; lag++) {
    let sum = 0;
    for (let i = 0; i < SIZE - lag; i++) {
      sum += buffer[i] * buffer[i + lag];
    }
    correlations[lag] = sum;
  }

  // Find first dip then first peak after it
  let d = 0;
  while (d < SIZE && correlations[d] > 0) d++;
  if (d >= SIZE) return -1;

  let maxVal = -1;
  let maxPos = -1;
  for (let i = d; i < SIZE; i++) {
    if (correlations[i] > maxVal) {
      maxVal = correlations[i];
      maxPos = i;
    }
  }
  if (maxPos === -1) return -1;

  return sampleRate / maxPos;
}

// Analyze tone characteristics from collected pitch/volume data
function analyzeTone() {
  if (pitchSamples.length < 5) return null;

  const avgPitch = pitchSamples.reduce((a, b) => a + b, 0) / pitchSamples.length;
  const minPitch = Math.min(...pitchSamples);
  const maxPitch = Math.max(...pitchSamples);
  const pitchRange = maxPitch - minPitch;

  // Pitch standard deviation (measures monotone vs expressive)
  const pitchMean = avgPitch;
  const pitchVariance = pitchSamples.reduce((sum, p) => sum + (p - pitchMean) ** 2, 0) / pitchSamples.length;
  const pitchStdDev = Math.sqrt(pitchVariance);

  // Pitch trend: rising, falling, or steady (compare first vs last third)
  const third = Math.floor(pitchSamples.length / 3);
  const firstThirdAvg = pitchSamples.slice(0, third).reduce((a, b) => a + b, 0) / third;
  const lastThirdAvg = pitchSamples.slice(-third).reduce((a, b) => a + b, 0) / third;
  const pitchTrendHz = lastThirdAvg - firstThirdAvg;
  let pitchTrend = "steady";
  if (pitchTrendHz > 15) pitchTrend = "rising";
  else if (pitchTrendHz < -15) pitchTrend = "falling";

  // Energy contour: does voice trail off or stay strong?
  let energyTrend = "steady";
  if (energyOverTime.length >= 4) {
    const eThird = Math.floor(energyOverTime.length / 3);
    const eFirst = energyOverTime.slice(0, eThird).reduce((a, b) => a + b, 0) / eThird;
    const eLast = energyOverTime.slice(-eThird).reduce((a, b) => a + b, 0) / eThird;
    if (eLast < eFirst * 0.6) energyTrend = "trailing off";
    else if (eLast > eFirst * 1.3) energyTrend = "building up";
    else energyTrend = "consistent";
  }

  // Classify expressiveness
  let expressiveness = "monotone";
  if (pitchStdDev > 40) expressiveness = "very expressive";
  else if (pitchStdDev > 25) expressiveness = "expressive";
  else if (pitchStdDev > 15) expressiveness = "moderate variation";
  else expressiveness = "monotone/flat";

  // Estimate emotional tone from pitch characteristics
  let estimatedTone = [];
  if (avgPitch > 200 && pitchStdDev > 30) estimatedTone.push("excited/enthusiastic");
  if (avgPitch > 180 && pitchTrend === "rising") estimatedTone.push("nervous/uncertain");
  if (avgPitch < 150 && pitchStdDev < 20) estimatedTone.push("calm/confident");
  if (avgPitch < 140 && energyTrend === "consistent") estimatedTone.push("authoritative");
  if (pitchStdDev < 12) estimatedTone.push("flat/disengaged");
  if (energyTrend === "trailing off") estimatedTone.push("losing confidence");
  if (energyTrend === "building up") estimatedTone.push("gaining momentum");
  if (estimatedTone.length === 0) estimatedTone.push("neutral");

  return {
    avgPitchHz: Math.round(avgPitch),
    pitchRangeHz: Math.round(pitchRange),
    pitchStdDev: Math.round(pitchStdDev),
    pitchTrend,
    expressiveness,
    energyTrend,
    estimatedTone: estimatedTone.join(", "),
    sampleCount: pitchSamples.length,
  };
}

function getVoiceMetrics(durationSec, wordCount) {
  if (volumeSamples.length === 0) return null;
  const avgVolume = volumeSamples.reduce((a, b) => a + b, 0) / volumeSamples.length;
  const maxVolume = Math.max(...volumeSamples);
  const minVolume = Math.min(...volumeSamples.filter((v) => v > SILENCE_THRESHOLD));
  const volumeVariation = maxVolume - (minVolume || 0);

  // Words per minute
  const wpm = durationSec > 0 ? Math.round((wordCount / durationSec) * 60) : 0;

  // Silence ratio
  const silentFrames = volumeSamples.filter((v) => v < SILENCE_THRESHOLD).length;
  const silenceRatio = silentFrames / volumeSamples.length;

  // Tone analysis
  const tone = analyzeTone();

  return {
    avgVolume: Math.round(avgVolume),
    volumeVariation: Math.round(volumeVariation),
    wpm,
    silenceRatio: Math.round(silenceRatio * 100),
    pauseCount: silenceSegments,
    durationSec,
    wordCount,
    tone, // NEW: pitch and tone data
  };
}

function stopAudioAnalysis() {
  if (audioStream) {
    audioStream.getTracks().forEach((t) => t.stop());
    audioStream = null;
  }
  if (audioContext && audioContext.state !== "closed") {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
  audioAnalyser = null;
  toneAnalysisBuffer = null;
}

// ===== TEXT-TO-SPEECH (AI Voice) =====
let ttsEnabled = true;
let ttsVoice = null;

function initTTS() {
  const synth = window.speechSynthesis;
  if (!synth) { ttsEnabled = false; return; }

  function pickVoice() {
    const voices = synth.getVoices();
    // Prefer a natural English voice
    ttsVoice = voices.find((v) => v.name.includes("Samantha")) ||
               voices.find((v) => v.name.includes("Google") && v.lang.startsWith("en")) ||
               voices.find((v) => v.name.includes("Daniel")) ||
               voices.find((v) => v.lang.startsWith("en") && v.localService) ||
               voices.find((v) => v.lang.startsWith("en")) ||
               voices[0];
  }

  pickVoice();
  synth.onvoiceschanged = pickVoice;
}

function speak(text) {
  if (!ttsEnabled || !window.speechSynthesis) return Promise.resolve();
  return new Promise((resolve) => {
    // Cancel any ongoing speech
    window.speechSynthesis.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    if (ttsVoice) utterance.voice = ttsVoice;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
}

function stopSpeaking() {
  if (window.speechSynthesis) window.speechSynthesis.cancel();
}

initTTS();

// ===== SCREENS =====
const screens = {
  onboard: $("#onboard-screen"),
  home: $("#home-screen"),
  open: $("#open-screen"),
  convo: $("#convo-screen"),
  results: $("#results-screen"),
  progress: $("#progress-screen"),
  vocab: $("#vocab-screen"),
};

function showScreen(name) {
  stopSpeaking();
  Object.values(screens).forEach((s) => s.classList.remove("active"));
  screens[name].classList.add("active");
}

// ===== INIT =====
function init() {
  if (!profile) {
    showScreen("onboard");
  } else {
    loadHome();
    showScreen("home");
  }
  setupDiffPills();
  setupBackButtons();
}

// ===== ONBOARDING =====
let obData = { goal: "", topics: [], tone: "", purpose: "" };
let obStep = 1;

$$(".ob-opt").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.key;
    const val = btn.dataset.val;
    const step = btn.closest(".ob-step");
    const isMulti = step.querySelector(".ob-options").classList.contains("multi");

    if (isMulti) {
      btn.classList.toggle("selected");
      if (!obData.topics) obData.topics = [];
      if (btn.classList.contains("selected")) obData.topics.push(val);
      else obData.topics = obData.topics.filter((t) => t !== val);
      const nextBtn = $("#ob-topics-next");
      if (obData.topics.length > 0) nextBtn.classList.remove("hidden");
      else nextBtn.classList.add("hidden");
    } else {
      step.querySelectorAll(".ob-opt").forEach((o) => o.classList.remove("selected"));
      btn.classList.add("selected");
      obData[key] = val;
      setTimeout(() => advanceOnboarding(), 300);
    }
  });
});

$("#ob-topics-next").addEventListener("click", () => advanceOnboarding());

function advanceOnboarding() {
  obStep++;
  if (obStep > 4) {
    profile = { ...obData, created: today };
    store("profile", profile);
    loadHome();
    showScreen("home");
    return;
  }
  $$(".ob-step").forEach((s) => s.classList.remove("active"));
  $(`.ob-step[data-step="${obStep}"]`).classList.add("active");
  $("#ob-fill").style.width = `${obStep * 25}%`;
  $("#ob-step-label").textContent = `${obStep} of 4`;
}

// ===== HOME =====
async function loadHome() {
  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  $("#home-greeting").textContent = greet;

  const streak = calcStreak();
  $("#home-streak").textContent = streak;

  if (!dailyContent) {
    dailyContent = await fetchDailyContent();
    store("daily_" + today, dailyContent);
  }
  if (dailyContent) {
    $("#daily-word").textContent = dailyContent.word || "—";
    $("#daily-word-def").textContent = dailyContent.definition || "—";
    $("#daily-word-use").textContent = dailyContent.example ? `"${dailyContent.example}"` : "";
    $("#daily-fact").textContent = dailyContent.fact || "—";
    $("#challenge-desc").textContent = dailyContent.challenge || "Complete one speaking session today.";
  }

  if (lastSessionMode) {
    $("#continue-btn").classList.remove("hidden");
    $("#cont-detail").textContent = lastSessionMode === "open" ? "Open-Ended" : "Conversation";
  }
}

async function fetchDailyContent() {
  try {
    const res = await fetch("/api/daily", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ profile, date: today }),
    });
    return await res.json();
  } catch {
    return {
      word: "Articulate", definition: "Having the ability to speak fluently and express oneself clearly.",
      example: "She gave an articulate presentation that captivated the audience.",
      fact: "The average person speaks about 16,000 words per day.",
      challenge: "Use zero filler words in your next 60-second response.",
    };
  }
}

function calcStreak() {
  if (sessions.length === 0) return 0;
  let streak = 0;
  const d = new Date();
  for (let i = 0; i < 365; i++) {
    const dateStr = d.toISOString().slice(0, 10);
    if (sessions.some((s) => s.date === dateStr)) streak++;
    else if (i > 0) break;
    d.setDate(d.getDate() - 1);
  }
  return streak;
}

// ===== DIFFICULTY =====
function setupDiffPills() {
  $$(".diff-pill").forEach((pill) => {
    if (pill.dataset.diff === difficulty) pill.classList.add("active");
    else pill.classList.remove("active");
    pill.addEventListener("click", () => {
      difficulty = pill.dataset.diff;
      store("difficulty", difficulty);
      $$(".diff-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  });
}

// ===== BACK BUTTONS =====
function setupBackButtons() {
  $$(".back-to-home").forEach((btn) => {
    btn.addEventListener("click", () => {
      stopTimer();
      stopRecording();
      stopAutoListening();
      stopAudioAnalysis();
      stopSpeaking();
      convoState = "idle";
      clearTimeout(silenceTimer);
      loadHome();
      showScreen("home");
    });
  });
}

// ===== SPEECH RECOGNITION + AUDIO ANALYSIS =====
function createRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";
  return rec;
}

async function startRecordingWithAudio(onResult, onEnd, statusEl, micEl) {
  if (!recognition) recognition = createRecognition();
  if (!recognition) return false;

  // Start audio analysis
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    initAudioAnalysis(stream);
  } catch (e) {
    console.warn("Could not access microphone for audio analysis:", e);
  }

  let finalTranscript = "";
  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript + " ";
      else interim += e.results[i][0].transcript;
    }
    onResult(finalTranscript, interim);
  };
  recognition.onend = () => {
    if (isRecording) { try { recognition.start(); } catch {} }
    else if (onEnd) onEnd(finalTranscript);
  };
  recognition.onerror = () => { stopRecordingUI(statusEl, micEl); };

  isRecording = true;
  if (micEl) micEl.classList.add("recording");
  if (statusEl) statusEl.classList.remove("hidden");
  try { recognition.start(); } catch {}
  return true;
}

function stopRecording() {
  isRecording = false;
  try { recognition?.stop(); } catch {}
}

function stopRecordingUI(statusEl, micEl) {
  isRecording = false;
  if (micEl) micEl.classList.remove("recording");
  if (statusEl) statusEl.classList.add("hidden");
  try { recognition?.stop(); } catch {}
}

// ===== TIMER =====
function startTimer() {
  timerSeconds = 0;
  updateTimerDisplay();
  timerInterval = setInterval(() => { timerSeconds++; updateTimerDisplay(); }, 1000);
}
function stopTimer() { clearInterval(timerInterval); }
function updateTimerDisplay() {
  const m = Math.floor(timerSeconds / 60);
  const s = timerSeconds % 60;
  const el = $("#open-timer");
  if (el) el.textContent = `${m}:${s.toString().padStart(2, "0")}`;
}

// ===== OPEN-ENDED MODE =====
const openPrompts = {
  easy: [
    "Describe your perfect day from morning to night.",
    "Talk about a hobby you enjoy and why you started it.",
    "What is your favorite meal and what makes it special?",
    "Describe your best friend without saying their name.",
    "What would you do with an unexpected day off?",
  ],
  medium: [
    "Describe a skill you want to improve and your plan to do it.",
    "What is something you strongly believe and why?",
    "Talk about a mistake that taught you an important lesson.",
    "Explain a concept from your work or studies to someone unfamiliar.",
    "If you could change one thing about your city, what would it be?",
  ],
  hard: [
    "Make a compelling argument for or against social media in schools.",
    "Explain your dream life in two minutes with specific details.",
    "Present a business idea and convince me to invest.",
    "Describe a complex problem you solved and walk me through your process.",
    "Argue the opposite of a position you actually hold.",
  ],
  veryhard: [
    "You have 90 seconds to convince me your biggest life decision was right.",
    "Defend an unpopular opinion with structured evidence.",
    "Give an impromptu eulogy for a stranger based only on their job title: teacher.",
    "Pitch yourself for your dream job in under 2 minutes. No filler words allowed.",
    "Explain why your generation is misunderstood. Be specific, be sharp.",
  ],
};

function getRandomPrompt() {
  const list = openPrompts[difficulty] || openPrompts.easy;
  return list[Math.floor(Math.random() * list.length)];
}

$("#mode-open").addEventListener("click", () => startOpenMode());
$("#open-skip-btn").addEventListener("click", () => {
  const prompt = getRandomPrompt();
  $("#open-prompt-text").textContent = prompt;
  speak(prompt); // AI reads the new prompt aloud
});

function startOpenMode() {
  currentMode = "open";
  lastSessionMode = "open";
  store("lastMode", "open");
  sessionStartTime = Date.now();
  openTranscript = "";

  const labels = { easy: "Easy", medium: "Medium", hard: "Hard", veryhard: "Brutal" };
  $("#open-diff-badge").textContent = labels[difficulty];
  $("#open-diff-badge").className = `badge ${difficulty}`;
  const prompt = getRandomPrompt();
  $("#open-prompt-text").textContent = prompt;
  $("#open-transcript").innerHTML = '<p class="transcript-placeholder">Your words will appear here as you speak...</p>';
  $("#open-done-btn").classList.add("hidden");
  $("#open-mic-label").textContent = "Tap to Start";
  $("#open-timer").textContent = "0:00";

  showScreen("open");

  // AI reads the prompt aloud
  speak(prompt);
}

let openRecording = false;
$("#open-mic-btn").addEventListener("click", () => {
  if (!openRecording) {
    stopSpeaking(); // Stop AI voice before user speaks
    openRecording = true;
    $("#open-mic-label").textContent = "Recording...";
    $("#open-done-btn").classList.remove("hidden");
    startTimer();

    startRecordingWithAudio(
      (final, interim) => {
        openTranscript = final;
        $("#open-transcript").innerHTML =
          `<p>${final}<span style="color:var(--text2)">${interim}</span></p>`;
      },
      null, null,
      $("#open-mic-btn")
    );
  } else {
    openRecording = false;
    $("#open-mic-label").textContent = "Tap to Start";
    stopRecordingUI(null, $("#open-mic-btn"));
    stopTimer();
  }
});

$("#open-done-btn").addEventListener("click", async () => {
  openRecording = false;
  stopRecordingUI(null, $("#open-mic-btn"));
  stopTimer();
  const text = openTranscript.trim();
  if (!text) return;

  // Capture voice metrics before stopping audio
  const wordCount = text.split(/\s+/).length;
  const voiceMetrics = getVoiceMetrics(timerSeconds, wordCount);
  stopAudioAnalysis();

  const prompt = $("#open-prompt-text").textContent;
  const speechErrors = analyzeSpeechErrors(text);
  await analyzeAndShowResults(text, "open", prompt, voiceMetrics, speechErrors);
});

// ===== CONVERSATION MODE (hands-free, like talking to a human) =====
const convoOpeners = {
  easy: "Hey! Let's just chat. Tell me about something that made you smile recently.",
  medium: "Welcome to your training session. Let's dig into a real topic. What's something happening in the world that you have an opinion on?",
  hard: "Session started. I expect structured, clear answers. No rambling. Here's your first challenge: What's the most overrated piece of advice people give, and why is it wrong?",
  veryhard: "This is elite training. I will push back on everything you say. Weak answers get called out. Ready? Tell me — what makes you think you're good at communicating? Prove it.",
};

let convoMessages = [];
let convoTurnCount = 0;
let convoTranscript = "";
let convoVoiceMetrics = { totalVolume: [], totalPauses: 0, totalWords: 0, totalDuration: 0 };
let convoState = "idle"; // "idle" | "ai-speaking" | "listening" | "processing"
let silenceTimer = null;
let lastSpeechTime = 0;
const SILENCE_TIMEOUT = 2000; // 2 seconds of silence = done talking
let convoFinalTranscript = "";
let convoInterimTranscript = "";

$("#mode-convo").addEventListener("click", () => startConvoMode());

function updateConvoStatus(state) {
  convoState = state;
  const statusEl = $("#convo-live-status");
  const indicator = $("#convo-state-indicator");
  const label = $("#convo-state-label");

  if (!statusEl) return;
  statusEl.classList.remove("hidden");

  switch (state) {
    case "ai-speaking":
      indicator.className = "state-dot speaking";
      label.textContent = "AI is speaking...";
      break;
    case "listening":
      indicator.className = "state-dot listening";
      label.textContent = "Your turn — speak naturally";
      break;
    case "processing":
      indicator.className = "state-dot processing";
      label.textContent = "Thinking...";
      break;
    default:
      indicator.className = "state-dot";
      label.textContent = "Tap mic to start";
  }
}

function startConvoMode() {
  currentMode = "convo";
  lastSessionMode = "convo";
  store("lastMode", "convo");
  sessionStartTime = Date.now();
  convoMessages = [];
  convoTurnCount = 0;
  convoTranscript = "";
  convoFinalTranscript = "";
  convoInterimTranscript = "";
  convoVoiceMetrics = { totalVolume: [], totalPauses: 0, totalWords: 0, totalDuration: 0 };

  const labels = { easy: "Easy", medium: "Medium", hard: "Hard", veryhard: "Brutal" };
  $("#convo-diff-badge").textContent = labels[difficulty];
  $("#convo-diff-badge").className = `badge ${difficulty}`;
  $("#convo-turns").textContent = "0";
  $("#convo-messages").innerHTML = "";
  $("#convo-input").value = "";

  const opener = convoOpeners[difficulty] || convoOpeners.easy;
  convoMessages.push({ role: "assistant", content: opener });
  addChatMsg("ai", opener);

  showScreen("convo");

  // AI speaks the opener, then auto-listens
  updateConvoStatus("ai-speaking");
  speak(opener).then(() => {
    startAutoListening();
  });
}

// Auto-listen: starts recording and auto-sends when user stops talking
async function startAutoListening() {
  updateConvoStatus("listening");
  convoFinalTranscript = "";
  convoInterimTranscript = "";
  $("#convo-input").value = "";
  lastSpeechTime = Date.now();

  if (!recognition) recognition = createRecognition();
  if (!recognition) {
    updateConvoStatus("idle");
    return;
  }

  // Start audio analysis for voice metrics
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    initAudioAnalysis(stream);
  } catch (e) {
    console.warn("Mic access error:", e);
  }

  recognition.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) {
        convoFinalTranscript += e.results[i][0].transcript + " ";
      } else {
        interim += e.results[i][0].transcript;
      }
    }
    convoInterimTranscript = interim;
    lastSpeechTime = Date.now();

    // Show live transcript in input
    $("#convo-input").value = convoFinalTranscript + interim;

    // Reset silence timer every time we get speech
    clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      // User stopped talking — auto-send
      const text = (convoFinalTranscript + convoInterimTranscript).trim();
      if (text.length > 0) {
        finishUserTurn(text);
      }
    }, SILENCE_TIMEOUT);
  };

  recognition.onend = () => {
    if (isRecording && convoState === "listening") {
      // Keep listening if still in listening state
      try { recognition.start(); } catch {}
    }
  };

  recognition.onerror = (e) => {
    if (e.error === "no-speech") {
      // No speech detected, restart
      if (convoState === "listening") {
        try { recognition.start(); } catch {}
      }
    } else {
      console.error("Recognition error:", e.error);
    }
  };

  isRecording = true;
  try { recognition.start(); } catch {}
}

function stopAutoListening() {
  isRecording = false;
  clearTimeout(silenceTimer);
  try { recognition?.stop(); } catch {}
}

async function finishUserTurn(text) {
  // Capture tone BEFORE stopping audio analysis
  const turnTone = analyzeTone();

  stopAutoListening();
  stopAudioAnalysis();

  if (!text.trim()) {
    startAutoListening();
    return;
  }

  // Capture voice metrics
  if (volumeSamples.length > 0) {
    convoVoiceMetrics.totalVolume.push(...volumeSamples);
    convoVoiceMetrics.totalPauses += silenceSegments;
    convoVoiceMetrics.totalWords += text.split(/\s+/).length;
  }

  // Detect speech errors
  const turnErrors = analyzeSpeechErrors(text);
  const errorContext = speechErrorSummary(turnErrors);

  addChatMsg("user", text, "voice");
  convoMessages.push({ role: "user", content: text });
  convoTurnCount++;
  convoTranscript += text + " ";
  $("#convo-turns").textContent = convoTurnCount;
  $("#convo-input").value = "";

  // AI thinks
  updateConvoStatus("processing");
  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: convoMessages,
        difficulty, profile, mode: "conversation",
        speechErrors: turnErrors.totalErrors > 0 ? errorContext : null,
        voiceTone: turnTone, // Send real-time tone analysis
      }),
    });
    const data = await res.json();
    hideTyping();

    if (data.response) {
      convoMessages.push({ role: "assistant", content: data.response });
      addChatMsg("ai", data.response);

      // AI speaks, then auto-listens again
      updateConvoStatus("ai-speaking");
      speak(data.response).then(() => {
        if (convoState !== "idle") {
          startAutoListening();
        }
      });
    }
  } catch {
    hideTyping();
    addChatMsg("ai", "Connection error. Let me try that again.");
    updateConvoStatus("listening");
    startAutoListening();
  }
}

function addChatMsg(role, text, method) {
  const div = document.createElement("div");
  div.className = `message ${role}`;
  const clean = text.replace(/\[RATING\][\s\S]*?\[\/RATING\]/g, "").trim();
  if (method) {
    const m = document.createElement("span");
    m.className = "msg-method";
    m.textContent = method === "voice" ? "Voice" : "Typed";
    div.appendChild(m);
  }
  const c = document.createElement("span");
  c.textContent = clean;
  div.appendChild(c);
  $("#convo-messages").appendChild(div);
  $("#convo-messages").scrollTop = $("#convo-messages").scrollHeight;
}

function showTyping() {
  const d = document.createElement("div");
  d.className = "typing-indicator";
  d.id = "typing";
  d.innerHTML = "<span></span><span></span><span></span>";
  $("#convo-messages").appendChild(d);
  $("#convo-messages").scrollTop = $("#convo-messages").scrollHeight;
}
function hideTyping() { const e = $("#typing"); if (e) e.remove(); }

// Manual send still works (typing fallback)
$("#convo-send-btn").addEventListener("click", () => {
  const text = $("#convo-input").value.trim();
  if (text) {
    stopAutoListening();
    stopSpeaking();
    finishUserTurn(text);
  }
});
$("#convo-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    const text = $("#convo-input").value.trim();
    if (text) {
      stopAutoListening();
      stopSpeaking();
      finishUserTurn(text);
    }
  }
});

// Manual mic toggle (tap to mute/unmute during conversation)
$("#convo-mic-btn").addEventListener("click", () => {
  if (convoState === "listening") {
    stopAutoListening();
    updateConvoStatus("idle");
    $("#convo-mic-btn").classList.add("muted");
  } else if (convoState === "idle") {
    $("#convo-mic-btn").classList.remove("muted");
    stopSpeaking();
    startAutoListening();
  } else if (convoState === "ai-speaking") {
    // Interrupt the AI
    stopSpeaking();
    $("#convo-mic-btn").classList.remove("muted");
    startAutoListening();
  }
});

// End conversation session
$("#convo-end-btn").addEventListener("click", async () => {
  stopAutoListening();
  stopSpeaking();
  stopAudioAnalysis();
  convoState = "idle";
  if (convoTurnCount === 0) return;

  const totalDuration = Math.round((Date.now() - sessionStartTime) / 1000);
  const wordCount = convoTranscript.split(/\s+/).length;
  const voiceMetrics = convoVoiceMetrics.totalVolume.length > 0 ? {
    avgVolume: Math.round(convoVoiceMetrics.totalVolume.reduce((a, b) => a + b, 0) / convoVoiceMetrics.totalVolume.length),
    wpm: totalDuration > 0 ? Math.round((wordCount / totalDuration) * 60) : 0,
    pauseCount: convoVoiceMetrics.totalPauses,
    durationSec: totalDuration,
    wordCount,
  } : null;

  const speechErrors = analyzeSpeechErrors(convoTranscript);
  await analyzeAndShowResults(convoTranscript, "conversation", null, voiceMetrics, speechErrors);
});

// Continue button
$("#continue-btn").addEventListener("click", () => {
  if (lastSessionMode === "open") startOpenMode();
  else startConvoMode();
});

// ===== ANALYSIS & RESULTS =====
async function analyzeAndShowResults(text, mode, prompt, voiceMetrics, speechErrors) {
  showScreen("results");
  $("#overall-num").textContent = "...";
  $("#overall-label").textContent = "Analyzing your speech...";

  // Reset bars
  $$(".sb-fill").forEach((f) => { f.style.width = "0%"; });
  $$(".sb-num").forEach((n) => { n.textContent = "-"; });
  $("#score-ring").style.transition = "none";
  $("#score-ring").style.strokeDashoffset = 326.73;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text, difficulty, mode, prompt, profile, voiceMetrics,
        speechErrors: speechErrors ? speechErrorSummary(speechErrors) : null,
        speechErrorData: speechErrors || null,
      }),
    });
    const data = await res.json();

    if (data.error) {
      $("#overall-label").textContent = "Analysis failed: " + data.error;
      return;
    }

    displayResults(data, text, mode);

    // AI reads the summary feedback
    const topFix = data.fixes?.[0];
    if (topFix) {
      speak(`Your overall score is ${data.overall} out of 10. ${topFix}`);
    }

    // Save session
    const session = {
      date: today, mode, difficulty, scores: data,
      duration: Math.round((Date.now() - sessionStartTime) / 1000),
      overall: data.overall || 0,
    };
    sessions.unshift(session);
    if (sessions.length > 100) sessions.length = 100;
    store("sessions", sessions);
  } catch (err) {
    console.error("Analysis error:", err);
    $("#overall-label").textContent = "Analysis failed. Check your connection.";
  }
}

function displayResults(data, transcript, mode) {
  const overall = data.overall || 0;
  const circumference = 326.73;
  const offset = circumference - (overall / 10) * circumference;
  const ring = $("#score-ring");
  setTimeout(() => { ring.style.transition = "stroke-dashoffset 1.2s ease"; ring.style.strokeDashoffset = offset; }, 100);

  let count = 0;
  const counterAnim = setInterval(() => {
    count += 0.2;
    if (count >= overall) { count = overall; clearInterval(counterAnim); }
    $("#overall-num").textContent = count.toFixed(1);
  }, 30);

  if (overall >= 8) $("#overall-label").textContent = "Excellent work!";
  else if (overall >= 6) $("#overall-label").textContent = "Solid performance. Room to grow.";
  else if (overall >= 4) $("#overall-label").textContent = "Decent start. Keep pushing.";
  else $("#overall-label").textContent = "Rough session. Let's improve.";

  const cats = ["clarity", "confidence", "flow", "conciseness", "vocabulary", "engagement", "fillerWords"];
  cats.forEach((cat) => {
    const row = $(`.score-bar-row[data-cat="${cat}"]`);
    if (!row) return;
    const score = data[cat] || 0;
    const fill = row.querySelector(".sb-fill");
    const num = row.querySelector(".sb-num");
    setTimeout(() => {
      fill.style.width = `${score * 10}%`;
      if (score >= 8) fill.style.background = "linear-gradient(90deg, var(--success), #22d3ee)";
      else if (score >= 5) fill.style.background = "linear-gradient(90deg, var(--primary), var(--accent))";
      else fill.style.background = "linear-gradient(90deg, var(--danger), var(--warning))";
    }, 200);
    num.textContent = score;
  });

  const scoreEntries = cats.map((c) => ({ name: c, score: data[c] || 0 }));
  scoreEntries.sort((a, b) => b.score - a.score);
  const nameMap = { clarity: "Clarity", confidence: "Confidence", flow: "Flow", conciseness: "Conciseness", vocabulary: "Vocabulary", engagement: "Engagement", fillerWords: "Filler Words" };
  $("#strongest-area").textContent = nameMap[scoreEntries[0].name];
  $("#weakest-area").textContent = nameMap[scoreEntries[scoreEntries.length - 1].name];

  const fbList = $("#feedback-list");
  fbList.innerHTML = "";
  (data.fixes || []).forEach((fix) => {
    const li = document.createElement("li");
    li.textContent = fix;
    fbList.appendChild(li);
  });

  const fillerSection = $("#filler-section");
  const fillerDiv = $("#filler-breakdown");
  if (data.fillerBreakdown && Object.keys(data.fillerBreakdown).length > 0) {
    fillerSection.classList.remove("hidden");
    fillerDiv.innerHTML = Object.entries(data.fillerBreakdown)
      .map(([word, count]) => `<span class="filler-chip">"${word}" <strong>&times;${count}</strong></span>`)
      .join("");
  } else {
    fillerSection.classList.add("hidden");
  }

  const wordingSection = $("#wording-section");
  const wordingList = $("#wording-list");
  if (data.wordingSuggestions && data.wordingSuggestions.length > 0) {
    wordingSection.classList.remove("hidden");
    wordingList.innerHTML = data.wordingSuggestions
      .map((w) => `<div class="wording-item"><span class="wi-bad">${w.original}</span><span class="wi-arrow">&rarr;</span><span class="wi-good">${w.better}</span></div>`)
      .join("");
  } else {
    wordingSection.classList.add("hidden");
  }

  // Transcript with highlighted fillers AND stutters
  const fillerWords = ["um", "uh", "like", "you know", "basically", "literally", "actually", "so", "right", "i mean"];
  const stutterSounds = ["uh", "um", "er", "ah", "uhh", "umm", "hmm", "ehh"];
  let highlighted = transcript;

  // Highlight filler words
  fillerWords.forEach((fw) => {
    const regex = new RegExp(`\\b(${fw})\\b`, "gi");
    highlighted = highlighted.replace(regex, '<span class="filler-highlight">$1</span>');
  });

  // Highlight stutters (repeated words like "I I I")
  highlighted = highlighted.replace(/\b(\w+)(\s+\1){1,}\b/gi, (match) => {
    return `<span class="stutter-highlight">${match}</span>`;
  });

  $("#results-transcript").innerHTML = highlighted || "<em>No transcript available.</em>";

  // Stutter/error breakdown section
  const stutterSection = $("#stutter-section");
  const stutterDiv = $("#stutter-breakdown");
  const errors = analyzeSpeechErrors(transcript);
  if (errors.totalErrors > 0) {
    stutterSection.classList.remove("hidden");
    let html = "";
    if (errors.stutters.length > 0) {
      html += errors.stutters.map((s) =>
        `<span class="stutter-chip repeat">"${s.word}" repeated ${s.count}x</span>`
      ).join("");
    }
    if (errors.fillerSounds.length > 0) {
      const counts = {};
      errors.fillerSounds.forEach((f) => { counts[f.sound] = (counts[f.sound] || 0) + 1; });
      html += Object.entries(counts).map(([s, c]) =>
        `<span class="stutter-chip filler">"${s}" &times;${c}</span>`
      ).join("");
    }
    if (errors.selfCorrections.length > 0) {
      html += errors.selfCorrections.map((s) =>
        `<span class="stutter-chip correction">"${s.phrase}"</span>`
      ).join("");
    }
    if (errors.repetitions.length > 0) {
      html += errors.repetitions.map((r) =>
        `<span class="stutter-chip repeat">"${r.phrase}" repeated</span>`
      ).join("");
    }
    stutterDiv.innerHTML = html;
  } else {
    stutterSection.classList.add("hidden");
  }

  // Voice metrics display
  if (data.voiceAnalysis) {
    const va = data.voiceAnalysis;
    let vaHtml = "";
    if (va.paceNote) vaHtml += `<li>${va.paceNote}</li>`;
    if (va.volumeNote) vaHtml += `<li>${va.volumeNote}</li>`;
    if (va.pauseNote) vaHtml += `<li>${va.pauseNote}</li>`;
    if (vaHtml) {
      const existing = fbList.innerHTML;
      fbList.innerHTML = vaHtml + existing;
    }
  }

  // Tone analysis display
  const toneSection = $("#tone-section");
  if (data.toneAnalysis && data.toneAnalysis.toneFeedback) {
    const ta = data.toneAnalysis;
    toneSection.classList.remove("hidden");
    $("#tone-emotion").textContent = ta.emotionalRead || "--";
    $("#tone-express").textContent = ta.toneFeedback ? "See below" : "--";
    $("#tone-score").textContent = ta.toneScore ? `${ta.toneScore}/10` : "--";
    $("#tone-feedback").textContent = ta.toneFeedback || "";
    $("#tone-tip").textContent = ta.toneTip ? `💡 ${ta.toneTip}` : "";

    // Color the score
    const scoreEl = $("#tone-score");
    if (ta.toneScore >= 8) scoreEl.style.color = "var(--success)";
    else if (ta.toneScore >= 5) scoreEl.style.color = "var(--primary)";
    else scoreEl.style.color = "var(--danger)";
  } else {
    toneSection.classList.add("hidden");
  }

  $("#next-challenge-text").textContent = data.nextChallenge || "Complete another session and try to beat this score.";
  ring.style.transition = "none";
}

// Results buttons
$("#results-retry").addEventListener("click", () => {
  $("#score-ring").style.strokeDashoffset = 326.73;
  if (currentMode === "open") startOpenMode();
  else startConvoMode();
});
$("#results-home").addEventListener("click", () => {
  $("#score-ring").style.strokeDashoffset = 326.73;
  loadHome();
  showScreen("home");
});

// ===== PROGRESS =====
$("#progress-btn").addEventListener("click", () => loadProgress());

function loadProgress() {
  const total = sessions.length;
  const avg = total > 0 ? (sessions.reduce((a, s) => a + (s.overall || 0), 0) / total).toFixed(1) : "--";
  const best = total > 0 ? Math.max(...sessions.map((s) => s.overall || 0)).toFixed(1) : "--";
  const streak = calcStreak();

  $("#prog-total").textContent = total;
  $("#prog-avg").textContent = avg;
  $("#prog-best").textContent = best;
  $("#prog-streak").textContent = streak;

  const canvas = $("#trend-chart");
  const empty = $("#trend-empty");
  if (total < 2) {
    canvas.style.display = "none";
    empty.style.display = "block";
  } else {
    canvas.style.display = "block";
    empty.style.display = "none";
    drawTrendChart(canvas, sessions.slice(0, 20).reverse());
  }

  const list = $("#history-list");
  if (total === 0) {
    list.innerHTML = '<p class="empty-msg">No sessions yet.</p>';
  } else {
    const modeLabels = { open: "Open-Ended", conversation: "Conversation" };
    const diffLabels = { easy: "Easy", medium: "Medium", hard: "Hard", veryhard: "Brutal" };
    list.innerHTML = sessions.slice(0, 20).map((s) => `
      <div class="history-card">
        <div class="hc-score">${(s.overall || 0).toFixed(1)}</div>
        <div class="hc-info">
          <div class="hc-mode">${modeLabels[s.mode] || s.mode} &middot; ${diffLabels[s.difficulty] || s.difficulty}</div>
          <div class="hc-meta">${s.date} &middot; ${Math.round((s.duration || 0) / 60)}min</div>
        </div>
      </div>`).join("");
  }

  showScreen("progress");
}

function drawTrendChart(canvas, data) {
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = 200;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  ctx.scale(dpr, dpr);

  const pad = { t: 20, r: 20, b: 30, l: 40 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "#2a2a4a";
  ctx.lineWidth = 0.5;
  for (let i = 0; i <= 10; i += 2) {
    const y = pad.t + ch - (i / 10) * ch;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.fillStyle = "#686888";
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.fillText(i, pad.l - 8, y + 4);
  }

  if (data.length < 2) return;

  const points = data.map((s, i) => ({
    x: pad.l + (i / (data.length - 1)) * cw,
    y: pad.t + ch - ((s.overall || 0) / 10) * ch,
  }));

  const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
  grad.addColorStop(0, "rgba(108, 99, 255, 0.3)");
  grad.addColorStop(1, "rgba(108, 99, 255, 0)");
  ctx.beginPath();
  ctx.moveTo(points[0].x, h - pad.b);
  points.forEach((p) => ctx.lineTo(p.x, p.y));
  ctx.lineTo(points[points.length - 1].x, h - pad.b);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
  ctx.strokeStyle = "#6C63FF";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.stroke();

  points.forEach((p) => {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#6C63FF";
    ctx.fill();
    ctx.strokeStyle = "#0a0a0f";
    ctx.lineWidth = 2;
    ctx.stroke();
  });
}

// ===== SOUND MANAGER =====
const SoundFX = (() => {
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  function ensureContext() {
    if (audioCtx.state === "suspended") audioCtx.resume();
  }

  // Generate success sound: two quick ascending tones
  function playCorrect() {
    ensureContext();
    const now = audioCtx.currentTime;
    // Note 1
    const osc1 = audioCtx.createOscillator();
    const gain1 = audioCtx.createGain();
    osc1.type = "sine";
    osc1.frequency.setValueAtTime(523, now); // C5
    osc1.frequency.setValueAtTime(659, now + 0.08); // E5
    gain1.gain.setValueAtTime(0.25, now);
    gain1.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc1.connect(gain1).connect(audioCtx.destination);
    osc1.start(now);
    osc1.stop(now + 0.2);
    // Note 2 (higher, slightly delayed)
    const osc2 = audioCtx.createOscillator();
    const gain2 = audioCtx.createGain();
    osc2.type = "sine";
    osc2.frequency.setValueAtTime(784, now + 0.1); // G5
    gain2.gain.setValueAtTime(0, now);
    gain2.gain.setValueAtTime(0.2, now + 0.1);
    gain2.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    osc2.connect(gain2).connect(audioCtx.destination);
    osc2.start(now + 0.1);
    osc2.stop(now + 0.35);
  }

  // Generate error sound: quick descending buzz
  function playWrong() {
    ensureContext();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(180, now + 0.15);
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.22);
  }

  // Perfect round fanfare: ascending arpeggio
  function playPerfect() {
    ensureContext();
    const now = audioCtx.currentTime;
    const notes = [523, 659, 784, 1047]; // C5 E5 G5 C6
    notes.forEach((freq, i) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(freq, now + i * 0.1);
      gain.gain.setValueAtTime(0, now);
      gain.gain.setValueAtTime(0.2, now + i * 0.1);
      gain.gain.exponentialRampToValueAtTime(0.01, now + i * 0.1 + 0.3);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + i * 0.1);
      osc.stop(now + i * 0.1 + 0.35);
    });
  }

  // Unlock audio on first user interaction (mobile requirement)
  function unlock() {
    ensureContext();
  }

  return { playCorrect, playWrong, playPerfect, unlock };
})();

// Unlock audio on first touch/click anywhere
document.addEventListener("click", () => SoundFX.unlock(), { once: true });
document.addEventListener("touchstart", () => SoundFX.unlock(), { once: true });


// ===== VOCABULARY MATCHING GAME (Instant Feedback) =====

// --- Configuration ---
const VOCAB_TOTAL_ROUNDS = 3;
const VOCAB_WORDS_PER_ROUND = 4;
const VOCAB_XP_CORRECT = 25;
const VOCAB_XP_FIRST_TRY_BONUS = 10;
const VOCAB_XP_PERFECT_ROUND = 50;

// --- Per-round state (reset each round) ---
let vocabRound = {
  words: [],              // Word data for this round
  shuffledDefs: [],       // Shuffled definitions
  lockedCorrect: {},      // { wordIdx: defIdx } — correct pairs, locked
  wrongAttempts: {},      // { wordIdx: count } — wrong tries per word
  selectedWord: null,
  selectedDef: null,
  correct: 0,
  wrong: 0,
  isComplete: false,
  isProcessing: false,    // Debounce lock during animations
  isLoading: false,       // Lock during API fetch / transition
};

// --- Session-wide state (reset each game) ---
let vocabSession = {
  round: 1,
  totalRounds: VOCAB_TOTAL_ROUNDS,
  totalCorrect: 0,
  totalWrong: 0,
  totalXP: 0,
  elapsedSec: 0,
  timerInterval: null,
  startTime: null,
  usedWords: [],
  missedWords: [],
  allRoundResults: [],
  isPracticeMissed: false,
  isGameComplete: false,
};

// --- Historical stats (persisted in localStorage) ---
let vocabHistory = load("vocabHistory", {
  accuracy: [],       // Array of accuracy % per game
  times: [],          // Array of completion times in seconds
  missed: {},         // { word: missCount }
  totalPlays: 0,
  bestAccuracy: 0,
  bestTime: null,     // null = no record yet
});

// --- Entry point ---
$("#mode-vocab").addEventListener("click", () => startVocabGame());

function startVocabGame() {
  // Reset session
  vocabSession = {
    round: 1,
    totalRounds: VOCAB_TOTAL_ROUNDS,
    totalCorrect: 0,
    totalWrong: 0,
    totalXP: 0,
    elapsedSec: 0,
    timerInterval: null,
    startTime: Date.now(),
    usedWords: [],
    missedWords: [],
    allRoundResults: [],
    isPracticeMissed: false,
    isGameComplete: false,
  };

  showScreen("vocab");
  const labels = { easy: "Easy", medium: "Medium", hard: "Hard", veryhard: "Hard" };
  $("#vocab-diff-badge").textContent = labels[difficulty] || "Easy";
  $("#vocab-diff-badge").className = `badge ${difficulty}`;
  $("#vocab-results-overlay").classList.add("hidden");

  vocabStartTimer();
  vocabLoadRound();
}

// =============================================
// TIMER
// =============================================
function vocabStartTimer() {
  // Always clear any previous interval first (prevents leaks)
  clearInterval(vocabSession.timerInterval);
  vocabSession.elapsedSec = 0;
  vocabUpdateTimerDisplay();
  vocabSession.timerInterval = setInterval(() => {
    vocabSession.elapsedSec++;
    vocabUpdateTimerDisplay();
  }, 1000);
}

function vocabStopTimer() {
  clearInterval(vocabSession.timerInterval);
  vocabSession.timerInterval = null;
}

function vocabUpdateTimerDisplay() {
  const m = Math.floor(vocabSession.elapsedSec / 60);
  const s = vocabSession.elapsedSec % 60;
  $("#vocab-timer-display").textContent = `${m}:${s.toString().padStart(2, "0")}`;
}

function vocabFormatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// =============================================
// LOAD ROUND
// =============================================
async function vocabLoadRound() {
  // Fully reset per-round state
  vocabRound = {
    words: [],
    shuffledDefs: [],
    lockedCorrect: {},
    wrongAttempts: {},
    selectedWord: null,
    selectedDef: null,
    correct: 0,
    wrong: 0,
    isComplete: false,
    isProcessing: false,
    isLoading: true,
  };

  // Update UI header
  const roundLabel = vocabSession.isPracticeMissed
    ? "Practice Round"
    : `Round ${vocabSession.round} of ${vocabSession.totalRounds}`;
  $("#vocab-round-label").textContent = roundLabel;
  $("#vocab-xp").textContent = vocabSession.totalXP;
  $("#vocab-instruction").textContent = "Loading words...";
  $("#vocab-words-col").innerHTML = '<div class="vocab-loading"><span></span><span></span><span></span></div>';
  $("#vocab-defs-col").innerHTML = "";

  // Hide action buttons
  const nextBtn = $("#vocab-next-btn");
  nextBtn.classList.add("hidden");
  nextBtn.disabled = false;
  nextBtn.textContent = "Next Round →";

  clearVocabLines();
  vocabUpdateLiveScore();

  const vocabDiff = difficulty === "veryhard" ? "hard" : difficulty;

  try {
    const res = await fetch("/api/vocab", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ difficulty: vocabDiff, exclude: vocabSession.usedWords }),
    });
    const data = await res.json();
    if (!data.words || data.words.length !== VOCAB_WORDS_PER_ROUND) throw new Error("Bad data");

    vocabRound.words = data.words;
    vocabSession.usedWords.push(...data.words.map((w) => w.word));

    // Shuffle definitions
    vocabRound.shuffledDefs = [...data.words]
      .map((w, i) => ({ ...w, originalIdx: i }))
      .sort(() => Math.random() - 0.5);

    vocabRenderBoard();
    $("#vocab-instruction").textContent = "Tap a word, then tap its definition.";
    vocabRound.isLoading = false;
  } catch (err) {
    console.error("Vocab load error:", err);
    vocabRound.isLoading = false;
    $("#vocab-instruction").textContent = "Failed to load words. Tap to retry.";
    $("#vocab-words-col").innerHTML = '<button class="ghost-btn" style="margin:20px auto" onclick="vocabLoadRound()">Retry</button>';
  }
}

// Load a practice round with specific words (no API call)
function vocabLoadPracticeRound(words) {
  vocabRound = {
    words: words,
    shuffledDefs: [...words]
      .map((w, i) => ({ ...w, originalIdx: i }))
      .sort(() => Math.random() - 0.5),
    lockedCorrect: {},
    wrongAttempts: {},
    selectedWord: null,
    selectedDef: null,
    correct: 0,
    wrong: 0,
    isComplete: false,
    isProcessing: false,
    isLoading: false,
  };

  $("#vocab-round-label").textContent = "Practice Round";
  $("#vocab-xp").textContent = vocabSession.totalXP;
  $("#vocab-next-btn").classList.add("hidden");
  clearVocabLines();
  vocabUpdateLiveScore();
  vocabRenderBoard();
  $("#vocab-instruction").textContent = "Practice: match the words you missed!";
}

// =============================================
// LIVE SCORE BAR
// =============================================
function vocabUpdateLiveScore() {
  $("#vocab-live-correct").textContent = vocabRound.correct;
  $("#vocab-live-wrong").textContent = vocabRound.wrong;
  const pct = (vocabRound.correct / VOCAB_WORDS_PER_ROUND) * 100;
  $("#vocab-progress-fill").style.width = `${pct}%`;
}

// =============================================
// RENDER BOARD
// =============================================
function vocabRenderBoard() {
  const wordsCol = $("#vocab-words-col");
  const defsCol = $("#vocab-defs-col");
  wordsCol.innerHTML = "";
  defsCol.innerHTML = "";

  vocabRound.words.forEach((w, i) => {
    const el = document.createElement("button");
    el.className = "vocab-item vocab-word";
    el.dataset.idx = i;
    el.innerHTML = `<span class="vi-text">${w.word}</span><span class="vi-num">${i + 1}</span>`;
    el.addEventListener("click", () => vocabSelectWord(i));
    wordsCol.appendChild(el);
  });

  vocabRound.shuffledDefs.forEach((d, i) => {
    const el = document.createElement("button");
    el.className = "vocab-item vocab-def";
    el.dataset.idx = i;
    el.innerHTML = `<span class="vi-text">${d.definition}</span><span class="vi-letter">${String.fromCharCode(65 + i)}</span>`;
    el.addEventListener("click", () => vocabSelectDef(i));
    defsCol.appendChild(el);
  });
}

// =============================================
// SELECTION LOGIC
// =============================================
function vocabSelectWord(idx) {
  if (vocabRound.isProcessing || vocabRound.isLoading || vocabRound.isComplete) return;
  if (vocabRound.lockedCorrect[idx] !== undefined) return; // Already locked

  // Toggle: if same word tapped again, deselect
  if (vocabRound.selectedWord === idx) {
    vocabRound.selectedWord = null;
    vocabUpdateSelectionUI();
    return;
  }

  vocabRound.selectedWord = idx;

  if (vocabRound.selectedDef !== null) {
    vocabAttemptMatch(idx, vocabRound.selectedDef);
  } else {
    vocabUpdateSelectionUI();
  }
}

function vocabSelectDef(idx) {
  if (vocabRound.isProcessing || vocabRound.isLoading || vocabRound.isComplete) return;
  const isLocked = Object.values(vocabRound.lockedCorrect).includes(idx);
  if (isLocked) return;

  // Toggle: if same def tapped again, deselect
  if (vocabRound.selectedDef === idx) {
    vocabRound.selectedDef = null;
    vocabUpdateSelectionUI();
    return;
  }

  vocabRound.selectedDef = idx;

  if (vocabRound.selectedWord !== null) {
    vocabAttemptMatch(vocabRound.selectedWord, vocabRound.selectedDef);
  } else {
    vocabUpdateSelectionUI();
  }
}

function vocabUpdateSelectionUI() {
  $$(".vocab-word").forEach((el) => {
    const idx = parseInt(el.dataset.idx);
    el.classList.toggle("selected", idx === vocabRound.selectedWord);
  });
  $$(".vocab-def").forEach((el) => {
    const idx = parseInt(el.dataset.idx);
    el.classList.toggle("selected", idx === vocabRound.selectedDef);
  });
}

// =============================================
// CORE: INSTANT MATCH EVALUATION
// =============================================
function vocabAttemptMatch(wordIdx, defIdx) {
  vocabRound.isProcessing = true;

  const wordData = vocabRound.words[wordIdx];
  const defData = vocabRound.shuffledDefs[defIdx];
  const isCorrect = wordData.word === defData.word;

  const wordEl = $(`.vocab-word[data-idx="${wordIdx}"]`);
  const defEl = $(`.vocab-def[data-idx="${defIdx}"]`);

  // Clear selection
  vocabRound.selectedWord = null;
  vocabRound.selectedDef = null;

  if (isCorrect) {
    // === CORRECT ===
    SoundFX.playCorrect();
    vocabRound.correct++;
    vocabSession.totalCorrect++;

    const bonus = (vocabRound.wrongAttempts[wordIdx] || 0) === 0 ? VOCAB_XP_FIRST_TRY_BONUS : 0;
    const xp = VOCAB_XP_CORRECT + bonus;
    vocabSession.totalXP += xp;
    $("#vocab-xp").textContent = vocabSession.totalXP;

    // Lock pair
    vocabRound.lockedCorrect[wordIdx] = defIdx;

    // Visuals
    wordEl.classList.remove("selected");
    defEl.classList.remove("selected");
    wordEl.classList.add("correct", "locked");
    defEl.classList.add("correct", "locked");
    vocabAddBadge(wordEl, "correct");
    vocabAddBadge(defEl, "correct");

    // Explanation
    const expEl = document.createElement("div");
    expEl.className = "vocab-explanation";
    expEl.textContent = wordData.explanation;
    wordEl.appendChild(expEl);

    vocabShowXPPopup(wordEl, `+${xp} XP`);
    vocabDrawLine(wordIdx, defIdx, "correct");
    vocabUpdateLiveScore();

    const remaining = VOCAB_WORDS_PER_ROUND - vocabRound.correct;
    if (remaining > 0) {
      $("#vocab-instruction").innerHTML = `<span style="color:var(--success)">Correct!</span> ${remaining} left`;
    }

    vocabRound.isProcessing = false;

    // Check round complete
    if (vocabRound.correct === VOCAB_WORDS_PER_ROUND) {
      vocabOnRoundComplete();
    }

  } else {
    // === WRONG ===
    SoundFX.playWrong();
    vocabRound.wrong++;
    vocabSession.totalWrong++;
    vocabRound.wrongAttempts[wordIdx] = (vocabRound.wrongAttempts[wordIdx] || 0) + 1;

    // Track as missed (once per word per round)
    if (vocabRound.wrongAttempts[wordIdx] === 1) {
      vocabSession.missedWords.push(wordData);
    }

    vocabUpdateLiveScore();

    wordEl.classList.remove("selected");
    defEl.classList.remove("selected");
    wordEl.classList.add("wrong", "shake");
    defEl.classList.add("wrong", "shake");
    vocabAddBadge(wordEl, "wrong");
    vocabAddBadge(defEl, "wrong");
    vocabDrawLine(wordIdx, defIdx, "wrong");

    $("#vocab-instruction").innerHTML = `<span style="color:var(--danger)">Not quite!</span> Try again.`;

    // Reset after animation
    setTimeout(() => {
      if (!wordEl || !defEl) { vocabRound.isProcessing = false; return; }
      wordEl.classList.remove("wrong", "shake");
      defEl.classList.remove("wrong", "shake");
      vocabRemoveBadge(wordEl);
      vocabRemoveBadge(defEl);
      vocabRemoveLine(wordIdx);
      vocabUpdateSelectionUI();
      vocabRound.isProcessing = false;
    }, 700);
  }
}

// =============================================
// FEEDBACK HELPERS
// =============================================
function vocabAddBadge(el, type) {
  vocabRemoveBadge(el);
  const badge = document.createElement("span");
  badge.className = `vi-badge ${type}`;
  badge.innerHTML = type === "correct"
    ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M20 6L9 17l-5-5"/></svg>'
    : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3"><path d="M18 6L6 18M6 6l12 12"/></svg>';
  el.appendChild(badge);
}

function vocabRemoveBadge(el) {
  const b = el.querySelector(".vi-badge");
  if (b) b.remove();
}

function vocabShowXPPopup(el, text) {
  const popup = document.createElement("span");
  popup.className = "xp-popup";
  popup.textContent = text;
  el.appendChild(popup);
  setTimeout(() => popup.remove(), 1000);
}

// =============================================
// LINE DRAWING
// =============================================
function vocabDrawLine(wordIdx, defIdx, cls) {
  const svg = $("#vocab-lines-svg");
  if (!svg) return;

  const gameArea = $(".vocab-game-area");
  const gaRect = gameArea.getBoundingClientRect();
  const wordEl = $(`.vocab-word[data-idx="${wordIdx}"]`);
  const defEl = $(`.vocab-def[data-idx="${defIdx}"]`);
  if (!wordEl || !defEl) return;

  const wRect = wordEl.getBoundingClientRect();
  const dRect = defEl.getBoundingClientRect();

  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("x1", wRect.right - gaRect.left);
  line.setAttribute("y1", wRect.top + wRect.height / 2 - gaRect.top);
  line.setAttribute("x2", dRect.left - gaRect.left);
  line.setAttribute("y2", dRect.top + dRect.height / 2 - gaRect.top);
  line.setAttribute("class", `vocab-match-line ${cls}`);
  line.dataset.word = wordIdx;
  svg.appendChild(line);
}

function vocabRemoveLine(wordIdx) {
  const line = $(`#vocab-lines-svg line[data-word="${wordIdx}"]`);
  if (line) line.remove();
}

function clearVocabLines() {
  const svg = $("#vocab-lines-svg");
  if (svg) svg.innerHTML = "";
}

function vocabRedrawLockedLines() {
  clearVocabLines();
  Object.entries(vocabRound.lockedCorrect).forEach(([wIdx, dIdx]) => {
    vocabDrawLine(parseInt(wIdx), parseInt(dIdx), "correct");
  });
}

// =============================================
// ROUND COMPLETE
// =============================================
function vocabOnRoundComplete() {
  vocabRound.isComplete = true;

  const perfectRound = vocabRound.wrong === 0;
  if (perfectRound) {
    vocabSession.totalXP += VOCAB_XP_PERFECT_ROUND;
    $("#vocab-xp").textContent = vocabSession.totalXP;
    SoundFX.playPerfect();
    $("#vocab-instruction").innerHTML = `<span style="color:var(--success)">Perfect round! +${VOCAB_XP_PERFECT_ROUND} XP bonus!</span>`;
  } else {
    $("#vocab-instruction").innerHTML = `<span style="color:var(--success)">Round complete!</span> ${vocabRound.wrong} wrong attempt${vocabRound.wrong !== 1 ? "s" : ""}`;
  }

  // Save round result
  vocabSession.allRoundResults.push({
    correct: vocabRound.correct,
    wrong: vocabRound.wrong,
    roundXP: vocabRound.correct * VOCAB_XP_CORRECT + (perfectRound ? VOCAB_XP_PERFECT_ROUND : 0),
  });

  const isFinalRound = vocabSession.round >= vocabSession.totalRounds || vocabSession.isPracticeMissed;
  const nextBtn = $("#vocab-next-btn");

  if (isFinalRound) {
    // Final round — show "Finish" button
    nextBtn.textContent = "Finish";
    nextBtn.classList.remove("hidden");
    nextBtn.disabled = false;
  } else {
    // More rounds — show "Next Round" button
    nextBtn.textContent = `Next Round → (${vocabSession.round + 1}/${vocabSession.totalRounds})`;
    nextBtn.classList.remove("hidden");
    nextBtn.disabled = false;
  }
}

// =============================================
// NEXT ROUND / FINISH BUTTON
// =============================================
$("#vocab-next-btn").addEventListener("click", () => {
  const nextBtn = $("#vocab-next-btn");

  // Guard: prevent double-clicks and clicks during loading
  if (nextBtn.disabled || vocabRound.isLoading) return;
  nextBtn.disabled = true; // Immediately disable to prevent double-click

  const isFinalRound = vocabSession.round >= vocabSession.totalRounds || vocabSession.isPracticeMissed;

  if (isFinalRound) {
    // Finish → show results
    vocabSession.isGameComplete = true;
    nextBtn.classList.add("hidden");
    vocabShowResults();
  } else {
    // Advance to next round
    vocabSession.round++;
    vocabLoadRound();
  }
});

// =============================================
// FINAL RESULTS
// =============================================
function vocabShowResults() {
  vocabStopTimer();
  vocabSession.isGameComplete = true;

  const totalAttempts = vocabSession.totalCorrect + vocabSession.totalWrong;
  const pct = totalAttempts > 0 ? Math.round((vocabSession.totalCorrect / totalAttempts) * 100) : 0;
  const timeStr = vocabFormatTime(vocabSession.elapsedSec);
  const totalWords = vocabSession.totalCorrect; // Each correct = 1 word matched

  // --- Update historical stats BEFORE displaying ---
  vocabHistory.totalPlays = (vocabHistory.totalPlays || 0) + 1;
  vocabHistory.accuracy.push(pct);
  vocabHistory.times.push(vocabSession.elapsedSec);
  if (pct > (vocabHistory.bestAccuracy || 0)) vocabHistory.bestAccuracy = pct;
  if (vocabHistory.bestTime === null || vocabSession.elapsedSec < vocabHistory.bestTime) {
    vocabHistory.bestTime = vocabSession.elapsedSec;
  }
  vocabSession.missedWords.forEach((w) => {
    vocabHistory.missed[w.word] = (vocabHistory.missed[w.word] || 0) + 1;
  });
  // Cap arrays at 50 entries
  if (vocabHistory.accuracy.length > 50) vocabHistory.accuracy = vocabHistory.accuracy.slice(-50);
  if (vocabHistory.times.length > 50) vocabHistory.times = vocabHistory.times.slice(-50);
  store("vocabHistory", vocabHistory);

  // --- Compute historical averages ---
  const avgAccuracy = vocabHistory.accuracy.length > 0
    ? Math.round(vocabHistory.accuracy.reduce((a, b) => a + b, 0) / vocabHistory.accuracy.length) : 0;

  // --- Show overlay ---
  const overlay = $("#vocab-results-overlay");
  overlay.classList.remove("hidden");

  // Title / subtitle
  if (pct === 100) {
    $("#vr-title").textContent = "Flawless!";
    $("#vr-subtitle").textContent = "You matched every word without a single mistake.";
  } else if (pct >= 80) {
    $("#vr-title").textContent = "Great Job!";
    $("#vr-subtitle").textContent = "Strong performance — keep building that vocabulary.";
  } else if (pct >= 50) {
    $("#vr-title").textContent = "Good Effort!";
    $("#vr-subtitle").textContent = "Solid round. Review the missed words to improve.";
  } else {
    $("#vr-title").textContent = "Keep Practicing!";
    $("#vr-subtitle").textContent = "Every game makes you sharper. Try again!";
  }

  // Score ring animation
  const circumference = 263.89;
  const offset = circumference - (pct / 100) * circumference;
  const ring = $("#vocab-score-ring");
  ring.style.transition = "none";
  ring.style.strokeDashoffset = circumference;
  setTimeout(() => {
    ring.style.transition = "stroke-dashoffset 1s ease";
    ring.style.strokeDashoffset = offset;
  }, 100);

  // Percentage counter
  let count = 0;
  const pctEl = $("#vocab-final-pct");
  pctEl.textContent = "0%";
  const counter = setInterval(() => {
    count += 2;
    if (count >= pct) { count = pct; clearInterval(counter); }
    pctEl.textContent = count + "%";
  }, 20);

  // This session stats
  $("#vr-rounds").textContent = vocabSession.round;
  $("#vr-correct").textContent = vocabSession.totalCorrect;
  $("#vr-wrong").textContent = vocabSession.totalWrong;
  $("#vr-time").textContent = timeStr;
  $("#vr-accuracy").textContent = pct + "%";
  $("#vr-xp").textContent = vocabSession.totalXP;
  $("#vr-words").textContent = totalWords;

  // Personal records
  $("#vr-best-accuracy").textContent = (vocabHistory.bestAccuracy || 0) + "%";
  $("#vr-best-time").textContent = vocabHistory.bestTime !== null ? vocabFormatTime(vocabHistory.bestTime) : "--";
  $("#vr-total-plays").textContent = vocabHistory.totalPlays || 0;
  $("#vr-avg-accuracy").textContent = avgAccuracy + "%";

  // Highlight if new record
  if (pct >= (vocabHistory.bestAccuracy || 0)) {
    $("#vr-best-accuracy").parentElement.classList.add("new-record");
  } else {
    $("#vr-best-accuracy").parentElement.classList.remove("new-record");
  }
  if (vocabSession.elapsedSec <= (vocabHistory.bestTime || Infinity)) {
    $("#vr-best-time").parentElement.classList.add("new-record");
  } else {
    $("#vr-best-time").parentElement.classList.remove("new-record");
  }

  // Round breakdown
  const breakdownEl = $("#vr-round-breakdown");
  if (vocabSession.allRoundResults.length > 0) {
    breakdownEl.innerHTML = "<h3>Round Breakdown</h3>" +
      vocabSession.allRoundResults.map((r, i) => {
        const rPerfect = r.wrong === 0;
        return `<div class="vr-round-row ${rPerfect ? "perfect" : ""}">
          <span class="vr-round-num">R${i + 1}</span>
          <span class="vr-round-detail">${r.correct}/${VOCAB_WORDS_PER_ROUND} correct${r.wrong > 0 ? `, ${r.wrong} wrong` : ""}</span>
          <span class="vr-round-xp">+${r.roundXP} XP${rPerfect ? " ★" : ""}</span>
        </div>`;
      }).join("");
  } else {
    breakdownEl.innerHTML = "";
  }

  // Missed words
  const missedSection = $("#vr-missed-section");
  const missedList = $("#vr-missed-list");
  const seen = new Set();
  const uniqueMissed = vocabSession.missedWords.filter((w) => {
    if (seen.has(w.word)) return false;
    seen.add(w.word);
    return true;
  });

  if (uniqueMissed.length > 0) {
    missedSection.classList.remove("hidden");
    missedList.innerHTML = uniqueMissed.map((w) => `
      <div class="vr-missed-card">
        <div class="vr-missed-word">${w.word}</div>
        <div class="vr-missed-def">${w.definition}</div>
        <div class="vr-missed-exp">${w.explanation}</div>
      </div>
    `).join("");

    if (uniqueMissed.length >= VOCAB_WORDS_PER_ROUND) {
      $("#vocab-practice-missed-btn").classList.remove("hidden");
    } else {
      $("#vocab-practice-missed-btn").classList.add("hidden");
    }
  } else {
    missedSection.classList.add("hidden");
    $("#vocab-practice-missed-btn").classList.add("hidden");
  }
}

// =============================================
// PLAY AGAIN
// =============================================
$("#vocab-play-again").addEventListener("click", () => {
  $("#vocab-results-overlay").classList.add("hidden");
  startVocabGame();
});

// =============================================
// PRACTICE MISSED WORDS
// =============================================
$("#vocab-practice-missed-btn").addEventListener("click", () => {
  const seen = new Set();
  const unique = vocabSession.missedWords.filter((w) => {
    if (seen.has(w.word)) return false;
    seen.add(w.word);
    return true;
  });

  if (unique.length < VOCAB_WORDS_PER_ROUND) {
    // Not enough — just restart
    $("#vocab-results-overlay").classList.add("hidden");
    startVocabGame();
    return;
  }

  // Reset session for practice
  vocabSession.isPracticeMissed = true;
  vocabSession.round = 1;
  vocabSession.totalRounds = 1;
  vocabSession.totalCorrect = 0;
  vocabSession.totalWrong = 0;
  vocabSession.totalXP = 0;
  vocabSession.allRoundResults = [];
  vocabSession.isGameComplete = false;
  const practice = unique.slice(0, VOCAB_WORDS_PER_ROUND);
  vocabSession.missedWords = [];

  $("#vocab-results-overlay").classList.add("hidden");
  vocabStartTimer();
  vocabLoadPracticeRound(practice);
});

// =============================================
// HOME FROM RESULTS
// =============================================
$("#vocab-go-home").addEventListener("click", () => {
  vocabStopTimer();
  $("#vocab-results-overlay").classList.add("hidden");
  loadHome();
  showScreen("home");
});

// =============================================
// RESIZE HANDLER
// =============================================
window.addEventListener("resize", () => {
  if (screens.vocab.classList.contains("active") && !vocabSession.isGameComplete) {
    vocabRedrawLockedLines();
  }
});

// ===== INIT =====
init();
