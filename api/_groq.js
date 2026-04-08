import Groq from "groq-sdk";

let groqClient = null;

export function getGroqClient() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  if (!groqClient) {
    groqClient = new Groq({ apiKey });
  }

  return groqClient;
}
