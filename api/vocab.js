import { getGroqClient } from "./_groq.js";
import { rateLimit } from "./_rateLimit.js";

const checkRate = rateLimit({ maxRequests: 20, windowMs: 60_000 });

const DIFF_DESCRIPTIONS = {
  easy: "common everyday English words that most people use daily (e.g. generous, fragile, cozy, genuine). These should be simple but still worth learning definitions for.",
  medium: "intermediate vocabulary words used in professional or academic settings (e.g. pragmatic, ambiguous, meticulous, resilient). Challenging but not obscure.",
  hard: "advanced, sophisticated vocabulary words used in literature, academia, or formal writing (e.g. ephemeral, sycophant, ubiquitous, pernicious). These should genuinely challenge educated adults.",
};

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (checkRate(req, res)) return;

  try {
    const { difficulty = "easy", exclude = [] } = req.body;
    const diffDesc = DIFF_DESCRIPTIONS[difficulty] || DIFF_DESCRIPTIONS.easy;
    const client = getGroqClient();
    if (!client) throw new Error("Missing GROQ_API_KEY");

    const excludeContext = exclude.length > 0
      ? `\nDo NOT use any of these words (already used): ${exclude.join(", ")}`
      : "";

    const completion = await client.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      max_tokens: 800,
      temperature: 0.9,
      messages: [
        {
          role: "system",
          content: `You are a vocabulary quiz generator. Generate exactly 4 vocabulary words with their definitions and short explanations.

Difficulty level: ${diffDesc}${excludeContext}

Return ONLY valid JSON, no markdown, no explanation. Use this exact structure:
{"words":[{"word":"example","definition":"a short clear definition (5-10 words)","explanation":"A 1-2 sentence explanation of the word with a usage example."},{"word":"...","definition":"...","explanation":"..."},{"word":"...","definition":"...","explanation":"..."},{"word":"...","definition":"...","explanation":"..."}]}

Rules:
- Each definition must be concise (5-10 words max)
- Each explanation should be 1-2 sentences with a real-world usage example
- All 4 words must be different from each other
- Words should be single words (no phrases)
- Definitions should be clearly distinguishable from each other`
        },
        {
          role: "user",
          content: "Generate 4 vocabulary words for the matching game."
        }
      ],
    });

    const raw = completion.choices[0]?.message?.content?.trim() || "";
    const cleaned = raw.replace(/```json\n?/gi, "").replace(/```\n?/g, "").trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in vocab response");

    const data = JSON.parse(jsonMatch[0]);

    if (!data.words || data.words.length !== 4) {
      throw new Error("Invalid response structure");
    }

    res.status(200).json(data);
  } catch (err) {
    console.error("Vocab API error:", err);
    // Fallback words by difficulty
    const fallbacks = {
      easy: {
        words: [
          { word: "generous", definition: "willing to give more than expected", explanation: "A generous person freely shares what they have. Example: She was generous with her time, helping everyone." },
          { word: "fragile", definition: "easily broken or damaged", explanation: "Something fragile needs careful handling. Example: The fragile vase shattered when it fell." },
          { word: "vivid", definition: "producing strong, clear mental images", explanation: "Vivid describes something intensely bright or detailed. Example: She painted a vivid picture of her childhood." },
          { word: "reluctant", definition: "unwilling and hesitant to do something", explanation: "A reluctant person does something without enthusiasm. Example: He was reluctant to speak in front of the crowd." },
        ]
      },
      medium: {
        words: [
          { word: "pragmatic", definition: "dealing with things in a practical way", explanation: "A pragmatic approach focuses on real-world results. Example: The manager took a pragmatic approach to solving the budget crisis." },
          { word: "ambiguous", definition: "open to more than one interpretation", explanation: "Something ambiguous is unclear and can be understood differently. Example: The contract language was ambiguous, leading to a dispute." },
          { word: "resilient", definition: "able to recover quickly from difficulties", explanation: "Resilient people bounce back from setbacks. Example: The resilient community rebuilt after the hurricane." },
          { word: "meticulous", definition: "showing great attention to detail", explanation: "A meticulous person is extremely careful and precise. Example: Her meticulous notes helped the entire team." },
        ]
      },
      hard: {
        words: [
          { word: "ephemeral", definition: "lasting for a very short time", explanation: "Ephemeral things are fleeting and temporary. Example: The ephemeral beauty of cherry blossoms draws millions of visitors." },
          { word: "sycophant", definition: "a person who flatters to gain advantage", explanation: "A sycophant praises powerful people for personal benefit. Example: The CEO was surrounded by sycophants who never challenged her ideas." },
          { word: "pernicious", definition: "having a harmful effect, especially gradually", explanation: "Pernicious harm happens slowly and is hard to notice. Example: The pernicious effects of misinformation erode public trust over time." },
          { word: "ubiquitous", definition: "present, appearing, or found everywhere", explanation: "Something ubiquitous is so common it seems inescapable. Example: Smartphones have become ubiquitous in modern life." },
        ]
      },
    };
    res.status(200).json(fallbacks[req.body?.difficulty] || fallbacks.easy);
  }
}
