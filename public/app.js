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

// ===== VOICE METRICS (Web Audio API) =====
let audioContext = null;
let audioAnalyser = null;
let audioStream = null;
let volumeSamples = [];
let silenceSegments = 0;
let lastWasSilent = false;
const SILENCE_THRESHOLD = 15;

function initAudioAnalysis(stream) {
  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  audioAnalyser = audioContext.createAnalyser();
  audioAnalyser.fftSize = 256;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(audioAnalyser);
  audioStream = stream;
  volumeSamples = [];
  silenceSegments = 0;
  lastWasSilent = false;
  collectAudioData();
}

function collectAudioData() {
  if (!audioAnalyser || !isRecording) return;
  const data = new Uint8Array(audioAnalyser.frequencyBinCount);
  audioAnalyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;
  volumeSamples.push(avg);

  if (avg < SILENCE_THRESHOLD) {
    if (!lastWasSilent) silenceSegments++;
    lastWasSilent = true;
  } else {
    lastWasSilent = false;
  }

  if (isRecording) requestAnimationFrame(collectAudioData);
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

  return {
    avgVolume: Math.round(avgVolume),
    volumeVariation: Math.round(volumeVariation),
    wpm,
    silenceRatio: Math.round(silenceRatio * 100),
    pauseCount: silenceSegments,
    durationSec,
    wordCount,
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
      stopAudioAnalysis();
      stopSpeaking();
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

// ===== CONVERSATION MODE =====
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

$("#mode-convo").addEventListener("click", () => startConvoMode());

function startConvoMode() {
  currentMode = "convo";
  lastSessionMode = "convo";
  store("lastMode", "convo");
  sessionStartTime = Date.now();
  convoMessages = [];
  convoTurnCount = 0;
  convoTranscript = "";
  convoVoiceMetrics = { totalVolume: [], totalPauses: 0, totalWords: 0, totalDuration: 0 };

  const labels = { easy: "Easy", medium: "Medium", hard: "Hard", veryhard: "Brutal" };
  $("#convo-diff-badge").textContent = labels[difficulty];
  $("#convo-diff-badge").className = `badge ${difficulty}`;
  $("#convo-turns").textContent = "0";
  $("#convo-messages").innerHTML = "";

  const opener = convoOpeners[difficulty] || convoOpeners.easy;
  convoMessages.push({ role: "assistant", content: opener });
  addChatMsg("ai", opener);

  showScreen("convo");

  // AI speaks the opener
  speak(opener).then(() => {
    $("#convo-input").focus();
  });
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

async function sendConvoMessage(text, method = "typed") {
  if (!text.trim()) return;

  // Capture voice metrics for this turn if recording
  if (method === "voice" && volumeSamples.length > 0) {
    convoVoiceMetrics.totalVolume.push(...volumeSamples);
    convoVoiceMetrics.totalPauses += silenceSegments;
    convoVoiceMetrics.totalWords += text.split(/\s+/).length;
  }
  stopAudioAnalysis();

  // Detect speech errors in this turn
  const turnErrors = analyzeSpeechErrors(text);
  const errorContext = speechErrorSummary(turnErrors);

  addChatMsg("user", text, method);
  // Send the raw text as the user message, but include error context as a system hint
  convoMessages.push({ role: "user", content: text });
  convoTurnCount++;
  convoTranscript += text + " ";
  $("#convo-turns").textContent = convoTurnCount;
  $("#convo-input").value = "";
  $("#convo-input").disabled = true;

  showTyping();
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: convoMessages,
        difficulty, profile, mode: "conversation",
        speechErrors: turnErrors.totalErrors > 0 ? errorContext : null,
      }),
    });
    const data = await res.json();
    hideTyping();
    if (data.response) {
      convoMessages.push({ role: "assistant", content: data.response });
      addChatMsg("ai", data.response);
      // AI speaks its response
      speak(data.response);
    }
  } catch {
    hideTyping();
    addChatMsg("ai", "Connection error. Try again.");
  }
  $("#convo-input").disabled = false;
  $("#convo-input").focus();
}

$("#convo-send-btn").addEventListener("click", () => sendConvoMessage($("#convo-input").value));
$("#convo-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendConvoMessage($("#convo-input").value); }
});

// Mic for conversation
let convoRecording = false;
$("#convo-mic-btn").addEventListener("mousedown", (e) => { e.preventDefault(); startConvoRecording(); });
$("#convo-mic-btn").addEventListener("mouseup", () => stopConvoRecording());
$("#convo-mic-btn").addEventListener("mouseleave", () => { if (convoRecording) stopConvoRecording(); });
$("#convo-mic-btn").addEventListener("touchstart", (e) => { e.preventDefault(); startConvoRecording(); });
$("#convo-mic-btn").addEventListener("touchend", (e) => { e.preventDefault(); stopConvoRecording(); });

function startConvoRecording() {
  stopSpeaking(); // Stop AI voice when user starts talking
  convoRecording = true;
  startRecordingWithAudio(
    (final, interim) => { $("#convo-input").value = final + interim; },
    null,
    $("#convo-speech-status"),
    $("#convo-mic-btn")
  );
}
function stopConvoRecording() {
  if (!convoRecording) return;
  convoRecording = false;
  stopRecordingUI($("#convo-speech-status"), $("#convo-mic-btn"));
  setTimeout(() => {
    const text = $("#convo-input").value.trim();
    if (text) { sendConvoMessage(text, "voice"); $("#convo-input").value = ""; }
  }, 300);
}

// End conversation session
$("#convo-end-btn").addEventListener("click", async () => {
  stopRecording();
  stopSpeaking();
  stopAudioAnalysis();
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

// ===== INIT =====
init();
