import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { profile, date } = req.body;

  const systemPrompt = `Generate daily speech training content. Return ONLY valid JSON.

${profile?.topics?.length ? `User interests: ${profile.topics.join(", ")}` : ""}
${profile?.goal ? `User goal: improving ${profile.goal}` : ""}
${profile?.purpose ? `User purpose: ${profile.purpose}` : ""}

Return this exact JSON format:
{
  "word": "<a powerful, useful vocabulary word>",
  "definition": "<clear, concise definition>",
  "example": "<one sentence using the word naturally in speech>",
  "fact": "<an interesting, surprising fact related to communication, psychology, or the user's interests - keep it under 30 words>",
  "challenge": "<a specific, measurable speaking challenge for today, e.g. 'Use zero filler words in a 60-second response' or 'Ask 3 strong follow-up questions in conversation mode'>"
}

Pick a word that would genuinely improve someone's speaking. Not obscure - practical and impressive.
Make the fact genuinely surprising and memorable.
Make the challenge specific and achievable in one session.
Use the date seed "${date}" to vary content daily.`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 400,
      system: systemPrompt,
      messages: [{ role: "user", content: `Generate daily content for ${date}.` }],
    });

    const raw = response.content[0].text;
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      res.json(JSON.parse(jsonMatch[0]));
    } else {
      res.json({
        word: "Articulate",
        definition: "Having the ability to speak fluently and express oneself clearly.",
        example: "She gave an articulate presentation that captivated everyone.",
        fact: "The average person speaks about 16,000 words per day.",
        challenge: "Complete one speaking session with fewer than 5 filler words.",
      });
    }
  } catch (error) {
    console.error("Daily content error:", error.message);
    res.json({
      word: "Eloquent",
      definition: "Fluent or persuasive in speaking or writing.",
      example: "His eloquent argument convinced the entire room.",
      fact: "Public speaking is the #1 fear for most people, ahead of death.",
      challenge: "Record a 90-second open-ended response and score above 6.",
    });
  }
}
