import { getGroqClient } from "./_groq.js";

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { profile, date } = req.body;

  const systemPrompt = `Generate daily speech training content. Return ONLY valid JSON, no markdown fences.

${profile?.topics?.length ? `User interests: ${profile.topics.join(", ")}` : ""}
${profile?.goal ? `User goal: improving ${profile.goal}` : ""}

Return EXACTLY this JSON (no markdown):
{"word":"<powerful useful vocabulary word>","definition":"<concise definition>","example":"<sentence using the word>","fact":"<surprising communication fact, under 30 words>","challenge":"<specific measurable speaking challenge>"}

Use date "${date}" to vary content daily.`;

  try {
    const client = getGroqClient();
    if (!client) throw new Error("Missing GROQ_API_KEY");

    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 400,
      temperature: 0.7,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Generate daily content for ${date}.` },
      ],
    });

    const raw = completion.choices[0].message.content;
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      throw new Error("No JSON");
    }
  } catch (error) {
    console.error("Daily error:", error.message);
    res.json({
      word: "Eloquent",
      definition: "Fluent or persuasive in speaking or writing.",
      example: "His eloquent argument convinced the entire room.",
      fact: "Public speaking is the number one fear for most people, ahead of death.",
      challenge: "Record a 90-second response with fewer than 5 filler words.",
    });
  }
}
