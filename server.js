import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

const client = new Anthropic();

const DIFFICULTY_PROMPTS = {
  easy: `You are a friendly, encouraging speech coach having a casual conversation.
    - Use simple vocabulary and short sentences
    - Be very patient and supportive
    - Give gentle, constructive feedback
    - Rate generously - focus on encouragement
    - Topics: daily life, hobbies, favorites, simple opinions
    - When rating speech, be lenient on filler words and pauses`,

  medium: `You are a professional speech coach having a structured conversation.
    - Use moderate vocabulary and varied sentence structures
    - Be supportive but push for improvement
    - Give balanced feedback with specific suggestions
    - Rate fairly - acknowledge strengths and areas to improve
    - Topics: current events, workplace scenarios, storytelling, debates
    - When rating speech, note filler words and suggest improvements`,

  hard: `You are a demanding speech coach running an intensive training session.
    - Use advanced vocabulary and complex sentence structures
    - Be direct and expect high-quality responses
    - Give detailed, critical feedback
    - Rate strictly - hold to high standards
    - Topics: persuasive arguments, impromptu speeches, technical explanations, ethical dilemmas
    - When rating speech, strictly count filler words, grammar issues, and weak arguments`,

  veryhard: `You are an elite, no-nonsense debate coach and rhetoric expert.
    - Use sophisticated vocabulary and challenge every point
    - Be blunt and aggressive in your feedback - no sugar-coating
    - Interrupt weak arguments and demand better
    - Rate extremely strictly - only excellence gets high marks
    - Topics: complex debates, defending unpopular positions, rapid-fire Q&A, high-pressure scenarios
    - Push back on everything, play devil's advocate aggressively
    - When rating speech, penalize every filler word, every weak transition, every vague statement
    - Be confrontational - "That's not good enough. Try again." style feedback`
};

const SYSTEM_BASE = `You are an AI speech training partner. Your job is to have conversations with users to help them improve their speaking skills.

IMPORTANT RULES:
1. Keep your responses conversational - 2-4 sentences max for dialogue turns
2. After every 2-3 exchanges, provide a brief speech rating in this exact JSON format embedded in your response:
   [RATING]{"clarity":X,"vocabulary":X,"confidence":X,"structure":X,"fillerWords":X,"overall":X}[/RATING]
   where X is a score from 1-10
3. Along with the rating, give a brief 1-sentence tip
4. Ask follow-up questions to keep the conversation going
5. Adapt your conversation style to the difficulty level
6. Track filler words the user mentions (um, uh, like, you know, basically, literally, actually, so, right)
7. Note if their responses are too short or lack detail`;

app.post("/api/chat", async (req, res) => {
  const { messages, difficulty } = req.body;

  const difficultyPrompt =
    DIFFICULTY_PROMPTS[difficulty] || DIFFICULTY_PROMPTS.easy;
  const systemPrompt = `${SYSTEM_BASE}\n\nDIFFICULTY LEVEL: ${difficulty.toUpperCase()}\n${difficultyPrompt}`;

  try {
    const response = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: systemPrompt,
      messages: messages
    });

    const text = response.content[0].text;
    res.json({ response: text });
  } catch (error) {
    console.error("API Error:", error.message);
    res.status(500).json({ error: "Failed to get AI response" });
  }
});

app.post("/api/analyze", async (req, res) => {
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
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Speech Trainer running at http://localhost:${PORT}`);
});
