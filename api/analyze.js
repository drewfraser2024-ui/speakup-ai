import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { text, difficulty } = req.body;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 512,
      system:
        "You are a speech analyst. Analyze the given text for speech quality. Respond ONLY with valid JSON.",
      messages: [
        {
          role: "user",
          content: `Analyze this speech sample (difficulty: ${difficulty}):
"${text}"

Return JSON with these scores (1-10):
{"clarity": X, "vocabulary": X, "confidence": X, "structure": X, "fillerWords": X, "overall": X, "tip": "one specific improvement tip"}`
        }
      ]
    });

    const analysisText = response.content[0].text;
    const jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      res.status(500).json({ error: "Failed to parse analysis" });
    }
  } catch (error) {
    console.error("Analysis Error:", error.message);
    res.status(500).json({ error: "Failed to analyze speech" });
  }
}
