import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { profile, date } = req.body;

  const systemPrompt = `Generate daily speech training content. Return ONLY valid JSON, no markdown.

${profile?.topics?.length ? `User interests: ${profile.topics.join(", ")}` : ""}
${profile?.goal ? `User goal: improving ${profile.goal}` : ""}
${profile?.purpose ? `User purpose: ${profile.purpose}` : ""}

Return this exact JSON format:
{
  "word": "<a powerful, useful vocabulary word>",
  "definition": "<clear, concise definition>",
  "example": "<one sentence using the word naturally>",
  "fact": "<surprising fact about communication or user's interests, under 30 words>",
  "challenge": "<specific, measurable speaking challenge for today>"
}

Pick a practical, impressive word. Make the fact genuinely surprising. Make the challenge achievable in one session. Use date "${date}" to vary content.`;

  try {
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

    const result = await model.generateContent({
      contents: [{ role: "user", parts: [{ text: `Generate daily content for ${date}.` }] }],
      systemInstruction: systemPrompt,
    });

    const raw = result.response.text();
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      throw new Error("No JSON found");
    }
  } catch (error) {
    console.error("Daily content error:", error.message);
    res.json({
      word: "Eloquent",
      definition: "Fluent or persuasive in speaking or writing.",
      example: "His eloquent argument convinced the entire room.",
      fact: "Public speaking is the number one fear for most people, ahead of death.",
      challenge: "Record a 90-second open-ended response and score above 6.",
    });
  }
}
