import { getGroqClient } from "./_groq.js";
import { rateLimit } from "./_rateLimit.js";

const checkRate = rateLimit({ maxRequests: 10, windowMs: 60_000 });

const TONE_MAP = {
  gentle: "Be encouraging and supportive. Frame weaknesses as growth opportunities.",
  direct: "Be honest and specific. Don't sugarcoat, but be fair.",
  harsh: "Be brutally honest. No sugar-coating. Call out every weakness directly.",
};

const DIFF_STRICTNESS = {
  easy: "Rate generously. This user is building confidence.",
  medium: "Rate fairly. Balance encouragement with honest criticism.",
  hard: "Rate strictly. Only genuinely good speech gets above 7.",
  veryhard: "Rate extremely strictly. A 7 means excellent. Average gets 4-5. Be ruthless.",
};

const FILLER_PATTERNS = [
  "um",
  "uh",
  "like",
  "you know",
  "basically",
  "literally",
  "actually",
  "right",
  "i mean",
];

function clampScore(value) {
  return Math.max(1, Math.min(10, Math.round(value)));
}

function getFillerBreakdown(text) {
  const breakdown = {};
  const lower = (text || "").toLowerCase();

  FILLER_PATTERNS.forEach((pattern) => {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "g");
    const matches = lower.match(regex);
    if (matches?.length) breakdown[pattern] = matches.length;
  });

  const sentenceStartSo = lower.match(/(^|[.!?]\s+)so\b/g);
  if (sentenceStartSo?.length) {
    breakdown.so = (breakdown.so || 0) + sentenceStartSo.length;
  }

  return breakdown;
}

function getWeakPhraseSuggestion(text) {
  const lower = (text || "").toLowerCase();
  if (lower.includes("i think")) {
    return { original: "I think", better: "My position is" };
  }
  if (lower.includes("kind of")) {
    return { original: "kind of", better: "partially" };
  }
  if (lower.includes("a lot")) {
    return { original: "a lot", better: "substantially" };
  }
  return { original: "very good", better: "effective" };
}

function getPaceNote(wpm) {
  if (!wpm) return null;
  if (wpm < 120) return "You spoke slowly; target roughly 130-170 WPM for stronger energy.";
  if (wpm > 185) return "You spoke quickly; slow slightly so key points land clearly.";
  return "Your speaking pace was in a useful range.";
}

function getPauseNote(pauseCount) {
  if (typeof pauseCount !== "number") return null;
  if (pauseCount > 20) return "Frequent pauses disrupted flow; plan shorter sentence chunks.";
  if (pauseCount < 3) return "Add intentional pauses to separate key ideas.";
  return "Pause usage looked balanced.";
}

function getVolumeNote(avgVolume) {
  if (typeof avgVolume !== "number") return null;
  if (avgVolume < 22) return "Volume was low at times; project from your diaphragm.";
  if (avgVolume > 80) return "Volume was high; keep intensity but soften peaks.";
  return "Volume level was generally steady.";
}

function buildFallbackAnalysis(text, speechErrorData, voiceMetrics) {
  const transcript = (text || "").trim();
  const words = transcript ? transcript.split(/\s+/) : [];
  const wordCount = words.length;
  const uniqueRatio = wordCount > 0
    ? new Set(words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ""))).size / wordCount
    : 0;

  const fillerBreakdown = getFillerBreakdown(transcript);
  const fillerCount = Object.values(fillerBreakdown).reduce((sum, count) => sum + count, 0);
  const stutterCount = speechErrorData?.stutters?.length || 0;
  const totalSpeechErrors = speechErrorData?.totalErrors || stutterCount;

  const sentenceCount = Math.max(1, transcript.split(/[.!?]+/).filter((s) => s.trim()).length);
  const avgSentenceLen = wordCount / sentenceCount;

  const clarity = clampScore(8.5 - fillerCount * 0.35 - stutterCount * 0.4 - Math.max(0, avgSentenceLen - 22) * 0.08);
  const confidence = clampScore(7.5 - totalSpeechErrors * 0.25 - (voiceMetrics?.wpm && voiceMetrics.wpm > 190 ? 1 : 0));
  const flow = clampScore(8 - totalSpeechErrors * 0.3 - (voiceMetrics?.pauseCount || 0) * 0.03);
  const conciseness = clampScore(8 - Math.max(0, wordCount - 130) / 20 + (wordCount > 0 && wordCount < 25 ? -1 : 0));
  const vocabulary = clampScore(4 + uniqueRatio * 7);
  const engagement = clampScore(6.5 + ((voiceMetrics?.volumeVariation || 0) > 20 ? 1 : 0) + ((voiceMetrics?.tone?.pitchStdDev || 0) > 20 ? 1 : 0));
  const fillerWords = clampScore(10 - fillerCount * 0.6);

  const overall = clampScore(
    clarity * 0.22 +
    confidence * 0.18 +
    flow * 0.16 +
    conciseness * 0.14 +
    vocabulary * 0.14 +
    engagement * 0.1 +
    fillerWords * 0.06
  );

  const paceNote = getPaceNote(voiceMetrics?.wpm);
  const volumeNote = getVolumeNote(voiceMetrics?.avgVolume);
  const pauseNote = getPauseNote(voiceMetrics?.pauseCount);

  const tone = voiceMetrics?.tone;
  const toneFeedback = tone
    ? `Pitch range was about ${tone.pitchRangeHz ?? "unknown"} Hz with ${tone.expressiveness || "moderate"} variation.`
    : "No detailed tone capture this round, so focus on varying pitch on key words.";

  const emotionalRead = tone?.estimatedTone || "neutral";
  const toneScore = tone?.pitchStdDev
    ? clampScore(4 + Math.min(5, tone.pitchStdDev / 10))
    : 6;

  return {
    clarity,
    confidence,
    flow,
    conciseness,
    vocabulary,
    engagement,
    fillerWords,
    overall,
    fixes: [
      fillerCount > 0
        ? `You used filler words ${fillerCount} time${fillerCount === 1 ? "" : "s"}. Replace them with a silent pause.`
        : "Good filler control. Keep short pauses instead of adding extra words.",
      stutterCount > 0
        ? `There were ${stutterCount} repeated-word stutter${stutterCount === 1 ? "" : "s"}. Pause and restart the phrase cleanly.`
        : "Keep your sentence openings deliberate so your first clause sounds confident.",
      "Use a simple structure: claim, reason, and one concrete example in each response.",
    ],
    fillerBreakdown,
    wordingSuggestions: [getWeakPhraseSuggestion(transcript)],
    nextChallenge: "Record 60 seconds with fewer than 3 filler words and at least one concrete example.",
    voiceAnalysis: {
      paceNote,
      volumeNote,
      pauseNote,
    },
    toneAnalysis: {
      toneFeedback,
      emotionalRead,
      toneScore,
      toneTip: "Emphasize one keyword per sentence by slightly raising pitch and slowing that word.",
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  if (checkRate(req, res)) return;

  const { text, difficulty, mode, prompt, profile, voiceMetrics, speechErrors, speechErrorData } = req.body;
  const parsedSpeechErrors = speechErrorData && typeof speechErrorData === "object" ? speechErrorData : null;
  const client = getGroqClient();
  if (!client) {
    return res.json(buildFallbackAnalysis(text, parsedSpeechErrors, voiceMetrics));
  }

  const tone = TONE_MAP[profile?.tone] || TONE_MAP.direct;
  const strictness = DIFF_STRICTNESS[difficulty] || DIFF_STRICTNESS.easy;

  let voiceContext = "";
  if (voiceMetrics) {
    voiceContext = `\nVOICE METRICS:
- Speaking pace: ${voiceMetrics.wpm} WPM (ideal: 130-170)
- Average volume: ${voiceMetrics.avgVolume}/100
- Pauses: ${voiceMetrics.pauseCount}
- Duration: ${voiceMetrics.durationSec}s, Words: ${voiceMetrics.wordCount}
${voiceMetrics.volumeVariation ? `- Volume variation: ${voiceMetrics.volumeVariation}` : ""}
${voiceMetrics.silenceRatio ? `- Silence ratio: ${voiceMetrics.silenceRatio}%` : ""}`;

    if (voiceMetrics.tone) {
      const t = voiceMetrics.tone;
      voiceContext += `\n\nTONE & PITCH ANALYSIS (from real-time audio):
- Average pitch: ${t.avgPitchHz} Hz (male ~85-180 Hz, female ~165-255 Hz)
- Pitch range: ${t.pitchRangeHz} Hz (higher = more expressive)
- Pitch variation (std dev): ${t.pitchStdDev} Hz
- Pitch trend over time: ${t.pitchTrend} (rising=nervous/questioning, falling=confident/declarative, steady=neutral)
- Expressiveness: ${t.expressiveness}
- Energy trend: ${t.energyTrend} (trailing off=losing confidence, building up=gaining momentum)
- Estimated emotional tone: ${t.estimatedTone}
USE THIS TONE DATA to assess confidence, engagement, and delivery. Reference the speaker's TONE specifically in your feedback. Examples:
- "Your pitch was flat — try varying your tone to sound more engaging"
- "Voice trailed off at the end — finish strong with steady volume"
- "Rising pitch made you sound uncertain — lower your voice at the end of statements"
- "Great energy! Your expressive tone kept it interesting"`;
    }
    voiceContext += `\nUse these to inform confidence, flow, engagement scores.`;
  }

  let errorContext = "";
  if (speechErrors) {
    errorContext = `\n${speechErrors}\nUse these errors in analysis. Stutters affect confidence/flow. Fillers affect fillerWords score.`;
  }

  const systemPrompt = `You are an elite speech analyst. Respond with ONLY valid JSON, no markdown fences.

TONE: ${tone}
STRICTNESS: ${strictness}
MODE: ${mode === "open" ? "Open-ended response" : "Conversation mode"}
${prompt ? `PROMPT: "${prompt}"` : ""}
${profile?.goal ? `GOAL: ${profile.goal}` : ""}
${voiceContext}${errorContext}

Return EXACTLY this JSON structure (no markdown, no explanation, ONLY JSON):
{"clarity":<1-10>,"confidence":<1-10>,"flow":<1-10>,"conciseness":<1-10>,"vocabulary":<1-10>,"engagement":<1-10>,"fillerWords":<1-10 where 10=no fillers>,"overall":<1-10>,"fixes":["<specific fix referencing exact words>","<fix 2>","<fix 3>"],"fillerBreakdown":{"<word>":<count>},"wordingSuggestions":[{"original":"<weak phrase>","better":"<stronger version>"}],"nextChallenge":"<specific measurable challenge>","voiceAnalysis":{"paceNote":"<or null>","volumeNote":"<or null>","pauseNote":"<or null>"},"toneAnalysis":{"toneFeedback":"<specific feedback about their vocal tone, pitch, and expressiveness>","emotionalRead":"<what emotion/attitude their voice conveyed>","toneScore":<1-10 where 10=perfect expressive delivery>,"toneTip":"<one actionable tip to improve vocal tone>"}}

RULES:
- Be SPECIFIC. Reference exact words from transcript.
- Count every "um","uh","like"(filler),"you know","basically","literally","actually","so"(sentence start),"right","I mean"
- Fixes like: "You used 'like' 9 times in 45 seconds. Replace pauses with silence."
- If stutters: "You stuttered on 'I I I think' — pause, collect thought, then speak."
- Challenge must be measurable: "Use fewer than 3 filler words"
- Overall weighted toward clarity, confidence, conciseness`;

  try {
    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 1500,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Analyze this speech transcript:\n\n"${text}"` },
      ],
    });

    const raw = completion.choices[0].message.content;
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      throw new Error("No JSON in analysis response");
    }
  } catch (error) {
    console.error("Analysis Error:", error.message);
    res.json(buildFallbackAnalysis(text, parsedSpeechErrors, voiceMetrics));
  }
}
