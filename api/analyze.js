import Groq from "groq-sdk";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

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

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { text, difficulty, mode, prompt, profile, voiceMetrics, speechErrors } = req.body;
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
${voiceMetrics.silenceRatio ? `- Silence ratio: ${voiceMetrics.silenceRatio}%` : ""}
Use these to inform confidence, flow, engagement scores.`;
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
{"clarity":<1-10>,"confidence":<1-10>,"flow":<1-10>,"conciseness":<1-10>,"vocabulary":<1-10>,"engagement":<1-10>,"fillerWords":<1-10 where 10=no fillers>,"overall":<1-10>,"fixes":["<specific fix referencing exact words>","<fix 2>","<fix 3>"],"fillerBreakdown":{"<word>":<count>},"wordingSuggestions":[{"original":"<weak phrase>","better":"<stronger version>"}],"nextChallenge":"<specific measurable challenge>","voiceAnalysis":{"paceNote":"<or null>","volumeNote":"<or null>","pauseNote":"<or null>"}}

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
      console.error("No JSON in:", raw);
      res.status(500).json({ error: "Failed to parse analysis" });
    }
  } catch (error) {
    console.error("Analysis Error:", error.message);
    res.status(500).json({ error: "Analysis failed" });
  }
}
