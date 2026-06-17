import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_MODEL = "gemini-2.5-flash";

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

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
    msg.includes("retry") ||
    msg.includes("temporarily") ||
    msg.includes("unavailable")
  );
}

function cleanGeminiText(text) {
  return String(text || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .replace(/^\s*json\s*/i, "")
    .trim();
}

function extractJsonArray(text) {
  const cleaned = cleanGeminiText(text);

  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed)) return parsed;
  } catch {}

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Risposta Gemini non valida");
  }

  const jsonText = cleaned.slice(start, end + 1);
  return JSON.parse(jsonText);
}

function normalizeGift(gift, index) {
  return {
    name: String(gift.name || `Idea regalo ${index + 1}`),
    description: String(gift.description || "Idea regalo personalizzata in base alle preferenze indicate."),
    price: String(gift.price || "Prezzo variabile"),
    category: String(gift.category || "varie"),
    searchQuery: String(gift.searchQuery || gift.name || `regalo ${index + 1}`)
  };
}

function validateGifts(gifts) {
  if (!Array.isArray(gifts)) {
    throw new Error("La risposta Gemini non è una lista");
  }

  return gifts.slice(0, 10).map(normalizeGift);
}

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Idee Regalo backend attivo",
    model: GEMINI_MODEL
  });
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
      return res.json({
        gifts: cache.get(cacheKey),
        fromCache: true
      });
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

    const finalOccasion =
      occasion === "✨ Altro" ? customOccasion : occasion;

    const prompt = `
Sei un esperto di regali personalizzati.

Genera esattamente 10 idee regalo per questa persona:

Occasione: ${finalOccasion}
Rapporto: ${relationship}
Età: ${age} anni
Personalità: ${(personality || []).join(", ")}
Hobby/interessi: ${hobbies || "non specificati"}
Tipo regalo preferito: ${giftType || "non specificato"}
Budget: ${budget}

REGOLE OBBLIGATORIE:
- Rispondi SOLO con JSON valido.
- Nessun markdown.
- Nessuna spiegazione.
- Nessun testo prima o dopo.
- Il primo carattere deve essere [
- L'ultimo carattere deve essere ]
- Usa solo doppi apici.
- Ogni oggetto deve avere: name, description, price, category, searchQuery.
- searchQuery deve essere una ricerca Amazon in italiano.

Formato esatto:
[
  {
    "name": "Nome breve",
    "description": "Descrizione breve del perché è adatto",
    "price": "€XX-YY",
    "category": "tecnologia",
    "searchQuery": "query Amazon in italiano"
  }
]
`;

    let data;
    let lastRetrySeconds = 16;

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
              temperature: 0.6,
              maxOutputTokens: 4096,
              responseMimeType: "application/json"
            }
          })
        });

        data = await geminiResponse.json();

        if (data.error) {
          const msg = data.error.message || "Errore Gemini";

          if (isTemporaryGeminiError(msg)) {
            lastRetrySeconds = getRetrySeconds(msg);
            throw new Error(msg);
          }

          return res.status(500).json({
            error: msg
          });
        }

        break;

      } catch (e) {
        console.error(`Tentativo Gemini ${i + 1} fallito:`, e.message);

        lastRetrySeconds = Math.max(getRetrySeconds(e.message), 16);

        if (i === 2) {
          return res.status(503).json({
            error:
              "Gemini è momentaneamente occupato o hai raggiunto il limite temporaneo di richieste. Attendi qualche secondo e riprova.",
            retryAfter: lastRetrySeconds
          });
        }

        console.log(`Attendo ${lastRetrySeconds} secondi prima di riprovare...`);
        await wait(lastRetrySeconds * 1000);
      }
    }

    if (!data) {
      return res.status(500).json({
        error: "Nessuna risposta ricevuta da Gemini"
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    console.log("========== RISPOSTA GEMINI ==========");
    console.log(text);
    console.log("=====================================");

    let gifts;

    try {
      gifts = extractJsonArray(text);
      gifts = validateGifts(gifts);
    } catch (e) {
      console.error("Errore parsing JSON Gemini:", e.message);

      return res.status(500).json({
        error: "Risposta Gemini non valida",
        raw: cleanGeminiText(text).slice(0, 500)
      });
    }

    cache.set(cacheKey, gifts);
    console.log("💾 Risposta salvata in cache");

    return res.json({
      gifts,
      fromCache: false
    });

  } catch (e) {
    console.error(e);

    return res.status(500).json({
      error: e.message || "Errore backend"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend attivo sulla porta ${PORT}`);
});