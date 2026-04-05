import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const TONE_MAP = {
  gentle: "Be encouraging and supportive. Frame weaknesses as growth opportunities.",
  direct: "Be honest and specific. Don't sugarcoat, but be fair.",
  harsh: "Be brutally honest. No sugar-coating. Call out every weakness directly.",
};

const DIFF_STRICTNESS = {
  easy: "Rate generously. This user is building confidence. Be encouraging but still give real scores.",
  medium: "Rate fairly. Balance encouragement with honest criticism.",
  hard: "Rate strictly. Hold to high standards. Only genuinely good speech gets above 7.",
  veryhard: "Rate extremely strictly. A 7 means excellent. Anything average gets a 4-5. Be ruthless.",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, difficulty, mode, prompt, profile, voiceMetrics, speechErrors } = req.body;
  const tone = TONE_MAP[profile?.tone] || TONE_MAP.direct;
  const strictness = DIFF_STRICTNESS[difficulty] || DIFF_STRICTNESS.easy;

  let voiceContext = "";
  if (voiceMetrics) {
    voiceContext = `\nVOICE METRICS (from real-time audio analysis):
- Speaking pace: ${voiceMetrics.wpm} words per minute (ideal: 130-170 WPM)
- Average volume level: ${voiceMetrics.avgVolume}/100
- Number of pauses/silence gaps: ${voiceMetrics.pauseCount}
- Total duration: ${voiceMetrics.durationSec} seconds
- Total words: ${voiceMetrics.wordCount}
${voiceMetrics.volumeVariation ? `- Volume variation: ${voiceMetrics.volumeVariation}` : ""}
${voiceMetrics.silenceRatio ? `- Silence ratio: ${voiceMetrics.silenceRatio}%` : ""}

USE THESE METRICS to inform your confidence, flow, and engagement scores.`;
  }

  let errorContext = "";
  if (speechErrors) {
    errorContext = `\n${speechErrors}
\nIMPORTANT: Use these detected speech errors in your analysis. Stutters affect confidence and flow. Filler sounds affect fillerWords score. Reference specific errors in your fixes.`;
  }

  const systemPrompt = `You are an elite speech analyst. Analyze the user's speech transcript, voice metrics, and speech errors to give comprehensive feedback.

TONE: ${tone}
STRICTNESS: ${strictness}
MODE: ${mode === "open" ? "Open-ended response to a prompt" : "Conversation mode"}
${prompt ? `PROMPT GIVEN: "${prompt}"` : ""}
${profile?.goal ? `USER'S GOAL: ${profile.goal}` : ""}
${voiceContext}
${errorContext}

You MUST respond with ONLY valid JSON in this exact format:
{
  "clarity": <1-10>,
  "confidence": <1-10>,
  "flow": <1-10>,
  "conciseness": <1-10>,
  "vocabulary": <1-10>,
  "engagement": <1-10>,
  "fillerWords": <1-10 where 10 means NO filler words>,
  "overall": <1-10 weighted average>,
  "fixes": [
    "<specific actionable fix 1 - reference exact words/phrases>",
    "<specific actionable fix 2>",
    "<specific actionable fix 3>"
  ],
  "fillerBreakdown": {
    "<filler word>": <count>
  },
  "wordingSuggestions": [
    {"original": "<weak phrase they used>", "better": "<stronger alternative>"}
  ],
  "nextChallenge": "<one specific, measurable challenge>",
  "voiceAnalysis": {
    "paceNote": "<feedback on speaking pace or null>",
    "volumeNote": "<feedback on volume or null>",
    "pauseNote": "<feedback on pausing or null>"
  }
}

RULES:
- Be SPECIFIC. Reference exact words from their transcript.
- For filler words: count every "um", "uh", "like" (filler), "you know", "basically", "literally", "actually", "so" (sentence start), "right", "I mean"
- For fixes: say "You used 'like' 9 times. Most appeared when searching for your next point. Replace that pause with silence."
- For wording: find weak phrases and suggest stronger alternatives
- Challenge must be measurable: "Use fewer than 3 filler words" not "try to improve"
- If stutters detected, reference them: "You stuttered on 'I I I think' — pause, collect your thought, then speak."
- Overall score weighted toward clarity, confidence, conciseness
- RESPOND WITH ONLY JSON. No markdown, no explanation.`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: `Analyze this speech transcript:\n\n"${text}"` }] }],
      systemInstruction: systemPrompt,
    });

    const raw = result.response.text();
    // Strip markdown code fences if present
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      res.json(parsed);
    } else {
      console.error("Could not parse JSON from:", raw);
      res.status(500).json({ error: "Failed to parse analysis" });
    }
  } catch (error) {
    console.error("Analysis Error:", error.message);
    res.status(500).json({ error: "Analysis failed" });
  }
}
