import Groq from "groq-sdk";

const client = new Groq({ apiKey: process.env.GROQ_API_KEY });

const TONE_MAP = {
  gentle: "Be warm, patient, and encouraging. Praise good points before suggesting improvements.",
  direct: "Be straightforward and honest. Give clear, no-fluff responses.",
  harsh: "Be blunt and aggressive. Challenge everything. Call out weak answers immediately. 'That's not good enough. Try again.' energy.",
};

const DIFF_PROMPTS = {
  easy: `Casual, friendly conversation coach.
- Simple vocabulary, short sentences. Very supportive and patient.
- Topics: daily life, hobbies, favorites, simple opinions. Keep it light and fun.
- When user stutters: gently encourage ("Take your time, no rush")`,

  medium: `Professional speech coach in a structured session.
- Moderate vocabulary, varied sentences. Push for more detail and structure.
- Topics: current events, workplace scenarios, storytelling.
- When user stutters: note it briefly and suggest slowing down`,

  hard: `Demanding coach running intensive training.
- Advanced vocabulary, complex structures. Direct and expects high-quality responses.
- Topics: persuasive arguments, technical explanations, ethical dilemmas.
- When user stutters: call it out directly ("You stumbled there. Restate that clearly.")`,

  veryhard: `Elite, aggressive debate coach and rhetoric expert.
- Sophisticated vocabulary, challenges every point. Blunt and confrontational.
- Interrupt weak arguments: "Stop. That made no sense. Try again."
- Play devil's advocate aggressively. Push back, demand specifics.
- When user stutters: "You're stumbling. If you can't say it cleanly, you don't know it well enough. Again."`,
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, difficulty, profile, mode, speechErrors } = req.body;
  const tone = TONE_MAP[profile?.tone] || TONE_MAP.direct;
  const diffPrompt = DIFF_PROMPTS[difficulty] || DIFF_PROMPTS.easy;

  let errorContext = "";
  if (speechErrors) {
    errorContext = `\n\nSPEECH ERROR ALERT FOR THIS TURN:\n${speechErrors}\nYou MUST acknowledge these errors naturally. React to stutters, repeated words, and filler sounds as a real speech coach would.`;
  }

  const systemPrompt = `You are an AI speech training partner in CONVERSATION MODE. Real-time back-and-forth dialogue to help users improve speaking.

Your responses will be read aloud, so write naturally as if speaking.

FEEDBACK TONE: ${tone}
DIFFICULTY: ${difficulty?.toUpperCase()}
${diffPrompt}

${profile?.goal ? `USER'S GOAL: Improving ${profile.goal}` : ""}
${profile?.topics?.length ? `USER'S INTERESTS: ${profile.topics.join(", ")}` : ""}
${profile?.purpose ? `USER'S PURPOSE: ${profile.purpose}` : ""}

RULES:
1. Keep responses to 2-4 sentences max. Conversation, not lecture.
2. Ask follow-up questions to keep dialogue flowing.
3. React to stuttering, filler sounds, self-corrections, rambling, and short lazy answers.
4. Occasionally (every 3-4 turns) give a brief inline observation about their speaking.
5. NEVER break character.
${errorContext}`;

  try {
    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 512,
      messages: [
        { role: "system", content: systemPrompt },
        ...messages,
      ],
    });

    res.json({ response: completion.choices[0].message.content });
  } catch (error) {
    console.error("Chat Error:", error.message);
    res.status(500).json({ error: "Failed to get response" });
  }
}
