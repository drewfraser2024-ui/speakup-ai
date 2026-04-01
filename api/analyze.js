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

  const { text, difficulty, mode, prompt, profile } = req.body;
  const tone = TONE_MAP[profile?.tone] || TONE_MAP.direct;
  const strictness = DIFF_STRICTNESS[difficulty] || DIFF_STRICTNESS.easy;

  const systemPrompt = `You are an elite speech analyst. Analyze the user's speech transcript and return detailed, actionable feedback.

TONE: ${tone}
STRICTNESS: ${strictness}
MODE: ${mode === "open" ? "Open-ended response to a prompt" : "Conversation mode (user side of dialogue)"}
${prompt ? `PROMPT GIVEN: "${prompt}"` : ""}
${profile?.goal ? `USER'S GOAL: ${profile.goal}` : ""}

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
  "nextChallenge": "<one specific, measurable challenge for their next session based on their weakest area>"
}

IMPORTANT RULES FOR FEEDBACK:
- Be SPECIFIC. Reference exact words and phrases from their transcript.
- For filler words: count every instance of "um", "uh", "like" (used as filler), "you know", "basically", "literally", "actually", "so" (at start of sentences), "right", "I mean"
- For fixes: don't just say "you used filler words." Say "You used 'like' 9 times in 45 seconds. Most appeared when searching for your next point. Replace that pause with silence."
- For wording suggestions: find weak/vague phrases and suggest specific stronger alternatives
- For the challenge: make it measurable. "Use fewer than 3 filler words" not "try to use fewer filler words"
- The overall score should be a weighted average favoring clarity, confidence, and conciseness`;

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
