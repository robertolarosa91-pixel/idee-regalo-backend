import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

const cache = new Map();

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildCacheKey(data) {
  return JSON.stringify({
    occasion: data.occasion,
    customOccasion: data.customOccasion,
    relationship: data.relationship,
    age: data.age,
    personality: data.personality,
    hobbies: data.hobbies,
    giftType: data.giftType,
    budget: data.budget
  });
}

function getRetrySeconds(message) {
  const match = String(message || "").match(/retry in ([\d.]+)s/i);
  if (match) return Math.ceil(Number(match[1]));
  return 16;
}

function isTemporaryGeminiError(message) {
  const msg = String(message || "").toLowerCase();

  return (
    msg.includes("high demand") ||
    msg.includes("resource_exhausted") ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("rate") ||
    msg.includes("retry")
  );
}

app.get("/", (req, res) => {
  res.json({ ok: true, message: "Idee Regalo backend attivo" });
});

app.post("/generate-gifts", async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({
        error: "GEMINI_API_KEY non configurata sul server"
      });
    }

    const cacheKey = buildCacheKey(req.body);

    if (cache.has(cacheKey)) {
      console.log("⚡ Risposta servita dalla cache");
      return res.json({ gifts: cache.get(cacheKey) });
    }

    const {
      occasion,
      customOccasion,
      relationship,
      age,
      personality,
      hobbies,
      giftType,
      budget
    } = req.body;

    const prompt = `Sei un esperto di regali personalizzati. Suggerisci 10 idee regalo creative e specifiche per:
- Occasione: ${occasion === "✨ Altro" ? customOccasion : occasion}
- Rapporto: ${relationship}
- Età: ${age} anni
- Personalità: ${(personality || []).join(", ")}
- Hobby/interessi: ${hobbies || "non specificati"}
- Tipo di regalo preferito: ${giftType || "non specificato"}
- Budget: ${budget}

Rispondi esclusivamente con un array JSON valido.
Il primo carattere della risposta deve essere [
L'ultimo carattere della risposta deve essere ]
Non scrivere spiegazioni, titoli, markdown, testo prima o dopo.
Usa solo doppi apici per stringhe e proprietà.
Genera esattamente 10 oggetti.
[{"name":"Nome breve","description":"2 righe perché è perfetto","price":"€XX-YY","category":"tecnologia|sport|cucina|libri|viaggi|natura|arte|musica|benessere|casa","searchQuery":"query Amazon in italiano"}]`;

    let data;

    for (let i = 0; i < 3; i++) {
      try {
        const geminiResponse = await fetch(GEMINI_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                parts: [{ text: prompt }]
              }
            ],
            generationConfig: {
              temperature: 0.7,
              maxOutputTokens: 4096,
              responseMimeType: "application/json"
            }
          })
        });

        data = await geminiResponse.json();

        if (data.error) {
          const msg = data.error.message || "Errore Gemini";

          if (isTemporaryGeminiError(msg)) {
            throw new Error(msg);
          }

          return res.status(500).json({
            error: msg
          });
        }

        break;

      } catch (e) {
        console.error(`Tentativo Gemini ${i + 1} fallito:`, e.message);

        if (i === 2) {
          return res.status(503).json({
            error:
              "Gemini è momentaneamente occupato o hai raggiunto il limite temporaneo di richieste. Attendi qualche secondo e riprova."
          });
        }

        const retrySeconds = Math.max(getRetrySeconds(e.message), (i + 1) * 5);
        console.log(`Attendo ${retrySeconds} secondi prima di riprovare...`);

        await wait(retrySeconds * 1000);
      }
    }

    if (!data) {
      return res.status(500).json({
        error: "Nessuna risposta ricevuta da Gemini"
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    const cleaned = text
      .replace(/```json/gi, "")
      .replace(/```/g, "")
      .trim();

    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");

    if (start === -1 || end === -1 || end <= start) {
      return res.status(500).json({
        error: "Risposta Gemini non valida",
        raw: cleaned.slice(0, 200)
      });
    }

    let gifts;

    try {
      gifts = JSON.parse(cleaned.slice(start, end + 1));
    } catch (e) {
      console.error("Errore parsing JSON Gemini:", e.message);

      return res.status(500).json({
        error: "Risposta Gemini non valida. Riprova tra qualche secondo.",
        raw: cleaned.slice(0, 200)
      });
    }

    if (!Array.isArray(gifts)) {
      return res.status(500).json({
        error: "La risposta Gemini non è una lista"
      });
    }

    if (gifts.length !== 10) {
      console.warn(`Gemini ha generato ${gifts.length} regali invece di 10`);
    }

    cache.set(cacheKey, gifts);
    console.log("💾 Risposta salvata in cache");

    res.json({ gifts });

  } catch (e) {
    console.error(e);

    res.status(500).json({
      error: e.message || "Errore backend"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend attivo sulla porta ${PORT}`);
});