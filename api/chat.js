import { getGroqClient } from "./_groq.js";

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

function buildFallbackChatReply({ difficulty, speechErrors, voiceTone }) {
  const challengeByDiff = {
    easy: "Nice effort. Give me one simple, concrete example to support your point.",
    medium: "Good start. Tighten your structure into one clear point, one reason, and one example.",
    hard: "Your point needs more precision. Restate it with stronger wording and one concrete proof.",
    veryhard: "You need sharper delivery. Rebuild your argument with a clear claim, evidence, and impact.",
  };

  const tips = [];

  if (speechErrors) {
    tips.push("I caught a few speech slips, so slow down and finish each sentence before starting the next.");
  }
  if (voiceTone?.expressiveness && /mono|flat/i.test(voiceTone.expressiveness)) {
    tips.push("Your tone sounded flat, so stress one key word per sentence to sound more engaging.");
  }
  if (voiceTone?.estimatedTone && /nervous|uncertain/i.test(voiceTone.estimatedTone)) {
    tips.push("You sounded a bit tense, so take one short pause before your main point.");
  }

  const first = tips[0] || challengeByDiff[difficulty] || challengeByDiff.easy;
  const second = "Now say it again in 2-3 sentences with one specific example. What is your revised answer?";
  return `${first} ${second}`;
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const { messages, difficulty, profile, mode, speechErrors, voiceTone } = req.body;
  const client = getGroqClient();
  if (!client) {
    return res.json({ response: buildFallbackChatReply({ difficulty, speechErrors, voiceTone }) });
  }

  const safeMessages = Array.isArray(messages) ? messages : [];
  const tone = TONE_MAP[profile?.tone] || TONE_MAP.direct;
  const diffPrompt = DIFF_PROMPTS[difficulty] || DIFF_PROMPTS.easy;

  let errorContext = "";
  if (speechErrors) {
    errorContext = `\n\nSPEECH ERROR ALERT FOR THIS TURN:\n${speechErrors}\nYou MUST acknowledge these errors naturally. React to stutters, repeated words, and filler sounds as a real speech coach would.`;
  }

  let toneContext = "";
  if (voiceTone) {
    toneContext = `\n\nVOCAL TONE THIS TURN (from real-time pitch analysis):
- Pitch: ${voiceTone.avgPitchHz} Hz, Range: ${voiceTone.pitchRangeHz} Hz
- Expressiveness: ${voiceTone.expressiveness}
- Pitch trend: ${voiceTone.pitchTrend}
- Energy: ${voiceTone.energyTrend}
- Detected tone: ${voiceTone.estimatedTone}
React to their TONE naturally. If monotone, encourage more expression. If nervous-sounding, reassure. If confident, acknowledge it. Weave tone observations into your response every 2-3 turns.`;
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
${errorContext}${toneContext}`;

  try {
    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 512,
      messages: [
        { role: "system", content: systemPrompt },
        ...safeMessages,
      ],
    });

    res.json({ response: completion.choices[0].message.content });
  } catch (error) {
    console.error("Chat Error:", error.message);
    res.json({ response: buildFallbackChatReply({ difficulty, speechErrors, voiceTone }) });
  }
}
