const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ===== Supabase Setup =====
// To connect Supabase: set these in Vercel env vars or replace below
const SUPABASE_URL = window.__SUPABASE_URL__ || "";
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY__ || "";

let supabaseClient = null;
let useSupabase = false;

if (SUPABASE_URL && SUPABASE_ANON_KEY && window.supabase) {
  supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  useSupabase = true;
  console.log("Supabase connected");
}

// Fallback: localStorage for session history
function getLocalSessions() {
  try {
    return JSON.parse(localStorage.getItem("speakup_sessions") || "[]");
  } catch {
    return [];
  }
}

function saveLocalSession(session) {
  const sessions = getLocalSessions();
  sessions.unshift(session);
  if (sessions.length > 50) sessions.length = 50;
  localStorage.setItem("speakup_sessions", JSON.stringify(sessions));
}

async function saveSession(sessionData) {
  if (useSupabase) {
    try {
      await supabaseClient.from("sessions").insert(sessionData);
    } catch (err) {
      console.error("Supabase save error:", err);
      saveLocalSession(sessionData);
    }
  } else {
    saveLocalSession(sessionData);
  }
}

async function loadSessions() {
  if (useSupabase) {
    try {
      const { data, error } = await supabaseClient
        .from("sessions")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data || [];
    } catch (err) {
      console.error("Supabase load error:", err);
      return getLocalSessions();
    }
  }
  return getLocalSessions();
}

// State
let difficulty = "easy";
let messages = [];
let turnCount = 0;
let latestScores = null;
let allRatings = [];
let isRecording = false;
let recognition = null;
let sessionStartTime = null;

// Elements
const landingScreen = $("#landing-screen");
const chatScreen = $("#chat-screen");
const historyScreen = $("#history-screen");
const chatMessages = $("#chat-messages");
const textInput = $("#text-input");
const sendBtn = $("#send-btn");
const micBtn = $("#mic-btn");
const backBtn = $("#back-btn");
const diffBadge = $("#difficulty-badge");
const liveScore = $("#live-score");
const turnCountEl = $("#turn-count");
const speechStatus = $("#speech-status");
const ratingPanel = $("#rating-panel");
const closeRatingBtn = $("#close-rating");
const ratingTip = $("#rating-tip");
const historyBtn = $("#history-btn");
const historyBackBtn = $("#history-back-btn");
const historyList = $("#history-list");

// ===== Init Speech Recognition =====
function initSpeechRecognition() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;

  const rec = new SpeechRecognition();
  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = "en-US";

  let finalTranscript = "";

  rec.onresult = (event) => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + " ";
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    textInput.value = finalTranscript + interim;
  };

  rec.onend = () => {
    if (isRecording) {
      const text = textInput.value.trim();
      if (text) {
        sendMessage(text, "voice");
        textInput.value = "";
      }
      stopRecording();
    }
  };

  rec.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    stopRecording();
  };

  rec._resetTranscript = () => {
    finalTranscript = "";
  };

  return rec;
}

function startRecording() {
  if (!recognition) {
    recognition = initSpeechRecognition();
    if (!recognition) {
      addSystemMessage(
        "Speech recognition is not supported in your browser. Please type instead."
      );
      return;
    }
  }

  isRecording = true;
  recognition._resetTranscript();
  textInput.value = "";
  micBtn.classList.add("recording");
  speechStatus.classList.remove("hidden");

  try {
    recognition.start();
  } catch (e) {}
}

function stopRecording() {
  isRecording = false;
  micBtn.classList.remove("recording");
  speechStatus.classList.add("hidden");

  try {
    recognition?.stop();
  } catch (e) {}
}

// ===== Screen Navigation =====
function showScreen(screen) {
  [landingScreen, chatScreen, historyScreen].forEach((s) =>
    s.classList.remove("active")
  );
  screen.classList.add("active");
}

// ===== Difficulty Selection =====
$$(".diff-card").forEach((card) => {
  card.addEventListener("click", () => {
    difficulty = card.dataset.difficulty;
    startSession();
  });
});

function startSession() {
  messages = [];
  turnCount = 0;
  latestScores = null;
  allRatings = [];
  sessionStartTime = new Date();
  liveScore.textContent = "--";
  turnCountEl.textContent = "0";
  chatMessages.innerHTML = "";
  ratingPanel.classList.add("hidden");

  const labels = {
    easy: "Easy",
    medium: "Medium",
    hard: "Hard",
    veryhard: "Very Hard"
  };
  diffBadge.textContent = labels[difficulty];
  diffBadge.className = `badge ${difficulty}`;

  showScreen(chatScreen);

  const openers = {
    easy: "Hey there! I'm your speech buddy. Let's have a nice chat to practice your speaking skills. No pressure at all - just talk naturally. So, what's something fun you did recently?",
    medium:
      "Welcome to your speech training session. I'll be guiding you through some engaging topics to sharpen your communication skills. Let's start with this: What's a topic you feel strongly about, and why?",
    hard: "Training session initiated. I expect articulate, well-structured responses from you. No filler words, no rambling. Let's begin: Present a compelling argument for or against remote work. You have one response. Make it count.",
    veryhard:
      "Listen up. This is elite-level speech training. I will challenge every word you say. I will not be nice about it. Weak answers get called out immediately. Ready? Convince me right now why your biggest life decision was the right call. Go."
  };

  addMessage("ai", openers[difficulty]);
  messages.push({ role: "assistant", content: openers[difficulty] });

  addSystemMessage(
    `Difficulty: ${labels[difficulty]} | Speak or type to respond`
  );
  textInput.focus();
}

async function endSession() {
  if (turnCount === 0) return;

  // Calculate average scores from all ratings
  const avgScores = {};
  if (allRatings.length > 0) {
    const keys = [
      "clarity",
      "vocabulary",
      "confidence",
      "structure",
      "fillerWords",
      "overall"
    ];
    keys.forEach((key) => {
      const sum = allRatings.reduce((a, r) => a + (r[key] || 0), 0);
      avgScores[key] = Math.round((sum / allRatings.length) * 10) / 10;
    });
  }

  const sessionData = {
    difficulty,
    turns: turnCount,
    scores: avgScores,
    duration_seconds: Math.round((Date.now() - sessionStartTime) / 1000),
    created_at: new Date().toISOString()
  };

  await saveSession(sessionData);
}

// ===== Messages =====
function addMessage(role, text, method) {
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const cleanText = text.replace(/\[RATING\][\s\S]*?\[\/RATING\]/g, "").trim();

  if (method) {
    const methodSpan = document.createElement("span");
    methodSpan.className = "msg-method";
    methodSpan.textContent = method === "voice" ? "Voice" : "Typed";
    div.appendChild(methodSpan);
  }

  const content = document.createElement("span");
  content.textContent = cleanText;
  div.appendChild(content);

  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addSystemMessage(text) {
  const div = document.createElement("div");
  div.className = "system-msg";
  div.innerHTML = `<p>${text}</p>`;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function showTyping() {
  const div = document.createElement("div");
  div.className = "typing-indicator";
  div.id = "typing";
  div.innerHTML = "<span></span><span></span><span></span>";
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function hideTyping() {
  const el = $("#typing");
  if (el) el.remove();
}

// ===== Rating =====
function parseRating(text) {
  const match = text.match(/\[RATING\]([\s\S]*?)\[\/RATING\]/);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function showRating(scores) {
  latestScores = scores;
  allRatings.push(scores);

  const categories = [
    "clarity",
    "vocabulary",
    "confidence",
    "structure",
    "fillerWords",
    "overall"
  ];

  categories.forEach((cat) => {
    const score = scores[cat] || 0;
    const bar = $(`#bar-${cat}`);
    const num = $(`#score-${cat}`);

    if (bar && num) {
      setTimeout(() => {
        bar.style.width = `${score * 10}%`;

        if (score >= 8)
          bar.style.background = `linear-gradient(90deg, var(--success), #22d3ee)`;
        else if (score >= 5)
          bar.style.background = `linear-gradient(90deg, var(--primary), var(--accent))`;
        else
          bar.style.background = `linear-gradient(90deg, var(--danger), var(--warning))`;
      }, 100);

      num.textContent = score;
    }
  });

  if (scores.tip) {
    ratingTip.textContent = scores.tip;
  }

  liveScore.textContent = scores.overall || "--";
  ratingPanel.classList.remove("hidden");
}

// ===== Send Message =====
async function sendMessage(text, method = "typed") {
  if (!text.trim()) return;

  addMessage("user", text, method);
  messages.push({ role: "user", content: text });
  turnCount++;
  turnCountEl.textContent = turnCount;

  textInput.value = "";
  textInput.disabled = true;
  sendBtn.disabled = true;

  showTyping();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages, difficulty })
    });

    const data = await res.json();
    hideTyping();

    if (data.error) {
      addSystemMessage("Error: " + data.error);
    } else {
      const aiText = data.response;
      messages.push({ role: "assistant", content: aiText });
      addMessage("ai", aiText);

      const rating = parseRating(aiText);
      if (rating) {
        showRating(rating);
      }
    }
  } catch (err) {
    hideTyping();
    addSystemMessage("Connection error. Please try again.");
    console.error(err);
  }

  textInput.disabled = false;
  sendBtn.disabled = false;
  textInput.focus();
}

// ===== History =====
async function showHistory() {
  const sessions = await loadSessions();

  if (sessions.length === 0) {
    historyList.innerHTML =
      '<div class="system-msg"><p>No sessions yet. Start a conversation to build your history.</p></div>';
  } else {
    const labels = {
      easy: "Easy",
      medium: "Medium",
      hard: "Hard",
      veryhard: "Very Hard"
    };

    historyList.innerHTML = sessions
      .map((s) => {
        const date = new Date(s.created_at).toLocaleDateString("en-US", {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        });
        const mins = Math.round((s.duration_seconds || 0) / 60);
        const scores = s.scores || {};

        return `
        <div class="history-card">
          <div class="history-card-header">
            <h3>${mins} min session</h3>
            <span class="badge ${s.difficulty}">${labels[s.difficulty] || s.difficulty}</span>
          </div>
          <div class="history-date">${date} &middot; ${s.turns} turns</div>
          <div class="history-scores">
            ${scores.overall ? `<span class="history-score-item">Overall: <strong>${scores.overall}</strong>/10</span>` : ""}
            ${scores.clarity ? `<span class="history-score-item">Clarity: <strong>${scores.clarity}</strong></span>` : ""}
            ${scores.vocabulary ? `<span class="history-score-item">Vocab: <strong>${scores.vocabulary}</strong></span>` : ""}
            ${scores.confidence ? `<span class="history-score-item">Confidence: <strong>${scores.confidence}</strong></span>` : ""}
          </div>
        </div>`;
      })
      .join("");
  }

  showScreen(historyScreen);
}

// ===== Event Listeners =====
sendBtn.addEventListener("click", () => {
  sendMessage(textInput.value, "typed");
});

textInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage(textInput.value, "typed");
  }
});

micBtn.addEventListener("mousedown", (e) => {
  e.preventDefault();
  startRecording();
});

micBtn.addEventListener("mouseup", () => {
  if (isRecording) {
    stopRecording();
    setTimeout(() => {
      const text = textInput.value.trim();
      if (text) {
        sendMessage(text, "voice");
        textInput.value = "";
      }
    }, 300);
  }
});

micBtn.addEventListener("mouseleave", () => {
  if (isRecording) {
    stopRecording();
    setTimeout(() => {
      const text = textInput.value.trim();
      if (text) {
        sendMessage(text, "voice");
        textInput.value = "";
      }
    }, 300);
  }
});

micBtn.addEventListener("touchstart", (e) => {
  e.preventDefault();
  startRecording();
});

micBtn.addEventListener("touchend", (e) => {
  e.preventDefault();
  if (isRecording) {
    stopRecording();
    setTimeout(() => {
      const text = textInput.value.trim();
      if (text) {
        sendMessage(text, "voice");
        textInput.value = "";
      }
    }, 300);
  }
});

backBtn.addEventListener("click", async () => {
  stopRecording();
  await endSession();
  ratingPanel.classList.add("hidden");
  showScreen(landingScreen);
});

closeRatingBtn.addEventListener("click", () => {
  ratingPanel.classList.add("hidden");
});

historyBtn.addEventListener("click", () => {
  showHistory();
});

historyBackBtn.addEventListener("click", () => {
  showScreen(landingScreen);
});
