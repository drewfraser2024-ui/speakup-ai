import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

// Import API handlers
import chatHandler from "./api/chat.js";
import analyzeHandler from "./api/analyze.js";
import dailyHandler from "./api/daily.js";
import vocabHandler from "./api/vocab.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname, "public")));

app.post("/api/chat", chatHandler);
app.post("/api/analyze", analyzeHandler);
app.post("/api/daily", dailyHandler);
app.post("/api/vocab", vocabHandler);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SpeakUp AI running at http://localhost:${PORT}`);
});
