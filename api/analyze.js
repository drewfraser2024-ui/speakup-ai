import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

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

  // Build voice metrics context
  let voiceContext = "";
  if (voiceMetrics) {
    voiceContext = `\nVOICE METRICS (from real-time audio analysis):
- Speaking pace: ${voiceMetrics.wpm} words per minute (ideal: 130-170 WPM for conversation, 120-150 for presentations)
- Average volume level: ${voiceMetrics.avgVolume}/100 (higher = louder/more projected)
- Number of pauses/silence gaps: ${voiceMetrics.pauseCount}
- Total duration: ${voiceMetrics.durationSec} seconds
- Total words: ${voiceMetrics.wordCount}
${voiceMetrics.volumeVariation ? `- Volume variation: ${voiceMetrics.volumeVariation} (higher = more expressive, lower = monotone)` : ""}
${voiceMetrics.silenceRatio ? `- Silence ratio: ${voiceMetrics.silenceRatio}% of time was silent` : ""}

USE THESE METRICS to inform your confidence, flow, and engagement scores. Include voice-specific feedback in fixes.`;
  }

  // Speech error context
  let errorContext = "";
  if (speechErrors) {
    errorContext = `\n${speechErrors}
\nIMPORTANT: Use these detected speech errors in your analysis. Stutters and repeated words should heavily affect the confidence and flow scores. Filler sounds affect the fillerWords score. Self-corrections indicate lack of preparation and affect clarity. Reference specific stutters and errors in your fixes.`;
  }

  const systemPrompt = `You are an elite speech analyst. Analyze the user's speech transcript, voice metrics (if provided), AND speech errors (stutters, repetitions, filler sounds) to give comprehensive feedback.

TONE: ${tone}
STRICTNESS: ${strictness}
MODE: ${mode === "open" ? "Open-ended response to a prompt" : "Conversation mode (user side of dialogue)"}
${prompt ? `PROMPT GIVEN: "${prompt}"` : ""}
${profile?.goal ? `USER'S GOAL: ${profile.goal}` : ""}
${voiceContext}

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
    "<specific actionable fix 1 - reference exact words/phrases from their speech>",
    "<specific actionable fix 2>",
    "<specific actionable fix 3>"
  ],
  "fillerBreakdown": {
    "<filler word>": <count>,
    ...
  },
  "wordingSuggestions": [
    {"original": "<weak phrase they used>", "better": "<stronger alternative>"},
    ...up to 3
  ],
  "nextChallenge": "<one specific, measurable challenge for their next session based on their weakest area>",
  "voiceAnalysis": {
    "paceNote": "<feedback on their speaking pace based on WPM, or null if no voice metrics>",
    "volumeNote": "<feedback on their volume/projection, or null>",
    "pauseNote": "<feedback on their pausing patterns, or null>"
  }
}

IMPORTANT RULES FOR FEEDBACK:
- Be SPECIFIC. Reference exact words and phrases from their transcript.
- For filler words: count every instance of "um", "uh", "like" (used as filler), "you know", "basically", "literally", "actually", "so" (at start of sentences), "right", "I mean"
- For fixes: don't just say "you used filler words." Say "You used 'like' 9 times in 45 seconds. Most appeared when searching for your next point. Replace that pause with silence."
- For wording suggestions: find weak/vague phrases and suggest specific stronger alternatives
- For the challenge: make it measurable. "Use fewer than 3 filler words" not "try to use fewer filler words"
- The overall score should be a weighted average favoring clarity, confidence, and conciseness
- If speech errors (stutters, repetitions) are detected, ALWAYS reference them specifically: "You stuttered on 'I I I think' — this suggests uncertainty. Pause, collect your thought, then speak."
- Stutters should significantly lower confidence and flow scores
- Distinguish between intentional repetition for emphasis vs involuntary stuttering${errorContext}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: `Analyze this speech transcript:\n\n"${text}"` }],
    });

    const raw = response.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      res.json(parsed);
    } else {
      res.status(500).json({ error: "Failed to parse analysis" });
    }
  } catch (error) {
    console.error("Analysis Error:", error.message);
    res.status(500).json({ error: "Analysis failed" });
  }
}
