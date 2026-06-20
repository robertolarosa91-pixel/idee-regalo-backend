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
    budget: data.budget,
    refreshKey: data.refreshKey || 0
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

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractJsonArray(text) {
  const cleaned = cleanGeminiText(text);

  const direct = tryParseJson(cleaned);
  if (Array.isArray(direct)) return direct;

  if (direct && Array.isArray(direct.gifts)) return direct.gifts;
  if (direct && Array.isArray(direct.ideas)) return direct.ideas;
  if (direct && Array.isArray(direct.regali)) return direct.regali;

  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");

  if (start === -1 || end === -1 || end <= start) {
    throw new Error("Risposta Gemini non valida");
  }

  const jsonText = cleaned.slice(start, end + 1);
  const parsed = JSON.parse(jsonText);

  if (!Array.isArray(parsed)) {
    throw new Error("La risposta Gemini non è una lista");
  }

  return parsed;
}

function normalizeGift(gift, index, fallbackData = {}) {
  const safeGift = gift && typeof gift === "object" ? gift : {};

  const name = String(
    safeGift.name ||
    safeGift.nome ||
    `Idea regalo ${index + 1}`
  );

  const description = String(
    safeGift.description ||
    safeGift.descrizione ||
    "Idea regalo personalizzata in base alle preferenze indicate."
  );

  const price = String(
    safeGift.price ||
    safeGift.prezzo ||
    fallbackData.budget ||
    "Prezzo variabile"
  );

  const category = String(
    safeGift.category ||
    safeGift.categoria ||
    "varie"
  );

  const searchQuery = String(
    safeGift.searchQuery ||
    safeGift.query ||
    safeGift.amazonQuery ||
    name
  );

  return {
    name,
    description,
    price,
    category,
    searchQuery
  };
}

function validateGifts(gifts, fallbackData = {}) {
  if (!Array.isArray(gifts)) {
    throw new Error("La risposta Gemini non è una lista");
  }

  const normalized = gifts
    .slice(0, 10)
    .map((gift, index) => normalizeGift(gift, index, fallbackData));

  if (normalized.length === 0) {
    throw new Error("Lista regali vuota");
  }

  while (normalized.length < 10) {
    normalized.push(
      normalizeGift(
        {
          name: `Idea regalo alternativa ${normalized.length + 1}`,
          description: "Alternativa coerente con il profilo indicato.",
          price: fallbackData.budget || "Prezzo variabile",
          category: "varie",
          searchQuery: `regalo ${fallbackData.relationship || ""} ${fallbackData.hobbies || ""}`.trim()
        },
        normalized.length,
        fallbackData
      )
    );
  }

  return normalized;
}

function generateFallbackGifts(data) {
  const {
    occasion,
    customOccasion,
    relationship,
    age,
    personality,
    hobbies,
    giftType,
    budget
  } = data;

  const finalOccasion = occasion === "✨ Altro" ? customOccasion : occasion;

  const personalityText =
    Array.isArray(personality) && personality.length
      ? personality.join(", ")
      : "personalità non specificata";

  const interestText = hobbies || "interessi generici";
  const typeText = giftType || "regalo utile e piacevole";
  const budgetText = budget || "budget variabile";

  const base = [
    {
      name: "Kit regalo personalizzato",
      category: "casa",
      searchQuery: `kit regalo personalizzato ${interestText}`
    },
    {
      name: "Esperienza da vivere insieme",
      category: "esperienza",
      searchQuery: `esperienza regalo ${relationship} ${finalOccasion}`
    },
    {
      name: "Accessorio utile premium",
      category: "varie",
      searchQuery: `accessorio utile regalo ${interestText}`
    },
    {
      name: "Set relax e benessere",
      category: "benessere",
      searchQuery: "set relax benessere regalo"
    },
    {
      name: "Gadget tecnologico pratico",
      category: "tecnologia",
      searchQuery: "gadget tecnologico utile regalo"
    },
    {
      name: "Libro o guida tematica",
      category: "libri",
      searchQuery: `libro regalo ${interestText}`
    },
    {
      name: "Oggetto decorativo elegante",
      category: "casa",
      searchQuery: "oggetto decorativo elegante regalo"
    },
    {
      name: "Box gourmet selezionato",
      category: "cucina",
      searchQuery: "box gourmet regalo"
    },
    {
      name: "Accessorio per hobby",
      category: "hobby",
      searchQuery: `accessorio hobby ${interestText} regalo`
    },
    {
      name: "Regalo sorpresa creativo",
      category: "arte",
      searchQuery: `regalo creativo originale ${interestText}`
    }
  ];

  return base.map(item => ({
    name: item.name,
    description:
      `Adatto per ${finalOccasion || "questa occasione"}: pensato per ${relationship || "questa persona"}, età ${age || "non specificata"}, con profilo ${personalityText}. È un ${typeText} compatibile con ${budgetText}.`,
    price: budgetText,
    category: item.category,
    searchQuery: item.searchQuery
  }));
}

async function callGemini(prompt) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  try {
    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      signal: controller.signal,
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
          temperature: 0.4,
          maxOutputTokens: 4096,
          responseMimeType: "application/json"
        }
      })
    });

    const data = await geminiResponse.json();

    if (!geminiResponse.ok) {
      const msg =
        data?.error?.message ||
        `Errore Gemini HTTP ${geminiResponse.status}`;

      throw new Error(msg);
    }

    if (data.error) {
      throw new Error(data.error.message || "Errore Gemini");
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

/* ─────────────────────────────────────────────
   PAGINA PRINCIPALE BACKEND
───────────────────────────────────────────── */

app.get("/", (req, res) => {
  res.json({
    ok: true,
    message: "Idee Regalo backend attivo",
    model: GEMINI_MODEL
  });
});

/* ─────────────────────────────────────────────
   PAGINA PUBBLICA ELIMINAZIONE ACCOUNT
   Da inserire nella Google Play Console
───────────────────────────────────────────── */

app.get("/delete-account", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");

  res.send(`
<!DOCTYPE html>
<html lang="it">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Eliminazione account - Idee Regalo</title>

  <style>
    body {
      font-family: Arial, sans-serif;
      max-width: 760px;
      margin: 0 auto;
      padding: 32px 20px;
      line-height: 1.6;
      color: #1a1a1a;
      background: #f7f7fb;
    }

    .card {
      background: #ffffff;
      border-radius: 16px;
      padding: 28px;
      box-shadow: 0 8px 30px rgba(0, 0, 0, 0.08);
    }

    h1 {
      color: #e94560;
      margin-top: 0;
    }

    h2 {
      margin-top: 28px;
    }

    ul,
    ol {
      padding-left: 22px;
    }

    .note {
      background: #fff3f5;
      border-left: 4px solid #e94560;
      padding: 12px 16px;
      border-radius: 8px;
      margin-top: 20px;
    }
  </style>
</head>

<body>
  <div class="card">
    <h1>Eliminazione account - Idee Regalo</h1>

    <p>
      Questa pagina spiega come eliminare il proprio account nell'app
      <strong>Idee Regalo</strong>.
    </p>

    <h2>Come eliminare l'account</h2>

    <ol>
      <li>Apri l'app <strong>Idee Regalo</strong>.</li>
      <li>Accedi con il tuo account.</li>
      <li>Apri la sezione <strong>Account</strong>.</li>
      <li>Seleziona <strong>Elimina account</strong>.</li>
      <li>Inserisci la password e conferma scrivendo <strong>ELIMINA</strong>.</li>
    </ol>

    <h2>Dati eliminati</h2>

    <p>Quando elimini l'account, vengono eliminati:</p>

    <ul>
      <li>Account Firebase Authentication;</li>
      <li>Email associata all'account;</li>
      <li>Nome profilo;</li>
      <li>Cronologia delle ricerche salvate;</li>
      <li>Regali salvati nei preferiti;</li>
      <li>Dati personali salvati nel database dell'app.</li>
    </ul>

    <h2>Tempi di eliminazione</h2>

    <p>
      L'eliminazione viene avviata immediatamente dopo la conferma nell'app.
      I dati associati all'account vengono rimossi definitivamente entro un massimo di 90 giorni,
      salvo eventuali obblighi legali o tecnici di conservazione.
    </p>

    <h2>Dati eventualmente conservati</h2>

    <p>
      Alcuni dati tecnici, di sicurezza, diagnostica o prevenzione frodi possono essere trattati
      temporaneamente da servizi di terze parti come Google Firebase, Google Play e Google AdMob,
      secondo le rispettive informative sulla privacy.
    </p>

    <h2>Assistenza</h2>

    <p>
      Se non riesci ad accedere all'app o hai bisogno di assistenza per eliminare l'account,
      puoi contattare lo sviluppatore tramite la pagina dell'app su Google Play.
    </p>

    <div class="note">
      L'eliminazione dell'account è definitiva e non può essere annullata.
    </div>
  </div>
</body>
</html>
  `);
});

/* ─────────────────────────────────────────────
   GENERAZIONE IDEE REGALO
───────────────────────────────────────────── */

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
Genera esattamente 10 idee regalo personalizzate.

DATI PERSONA:
Occasione: ${finalOccasion || "non specificata"}
Rapporto: ${relationship || "non specificato"}
Età: ${age || "non specificata"}
Personalità: ${(personality || []).join(", ") || "non specificata"}
Hobby/interessi: ${hobbies || "non specificati"}
Tipo regalo preferito: ${giftType || "non specificato"}
Budget: ${budget || "non specificato"}

REGOLE OBBLIGATORIE:
Rispondi SOLO con un array JSON valido.
Nessun markdown.
Nessun testo prima.
Nessun testo dopo.
Il primo carattere deve essere [
L'ultimo carattere deve essere ]
Usa solo doppi apici.
Genera esattamente 10 oggetti.
Ogni oggetto deve avere esattamente queste proprietà:
"name", "description", "price", "category", "searchQuery".

"searchQuery" deve essere una ricerca Amazon in italiano.

ESEMPIO FORMATO:
[
  {
    "name": "Nome breve",
    "description": "Descrizione breve del perché è adatto",
    "price": "€XX-YY",
    "category": "tecnologia",
    "searchQuery": "query Amazon in italiano"
  }
]
`.trim();

    let data = null;
    let lastRetrySeconds = 16;

    for (let i = 0; i < 3; i++) {
      try {
        data = await callGemini(prompt);
        break;
      } catch (e) {
        const msg = e.message || "Errore Gemini";
        console.error(`Tentativo Gemini ${i + 1} fallito:`, msg);

        lastRetrySeconds = Math.max(getRetrySeconds(msg), 16);

        if (!isTemporaryGeminiError(msg) && i === 0) {
          break;
        }

        if (i === 2) {
          console.warn("Gemini non disponibile. Uso fallback locale.");

          const fallbackGifts = generateFallbackGifts(req.body);
          cache.set(cacheKey, fallbackGifts);

          return res.json({
            gifts: fallbackGifts,
            fromCache: false,
            fallback: true,
            warning:
              "Gemini momentaneamente non disponibile. Sono state generate idee fallback."
          });
        }

        console.log(`Attendo ${lastRetrySeconds} secondi prima di riprovare...`);
        await wait(lastRetrySeconds * 1000);
      }
    }

    if (!data) {
      console.warn("Nessuna risposta Gemini. Uso fallback locale.");

      const fallbackGifts = generateFallbackGifts(req.body);
      cache.set(cacheKey, fallbackGifts);

      return res.json({
        gifts: fallbackGifts,
        fromCache: false,
        fallback: true,
        warning: "Nessuna risposta Gemini. Sono state generate idee fallback."
      });
    }

    const text =
      data.candidates?.[0]?.content?.parts?.[0]?.text ||
      data.candidates?.[0]?.content?.parts?.map(p => p.text).join("\n") ||
      "";

    console.log("========== RISPOSTA GEMINI ==========");
    console.log(text);
    console.log("=====================================");

    let gifts;

    try {
      gifts = extractJsonArray(text);
      gifts = validateGifts(gifts, req.body);
    } catch (e) {
      console.error("Errore parsing JSON Gemini:", e.message);
      console.error("Raw Gemini:", cleanGeminiText(text).slice(0, 500));

      console.warn("Uso fallback locale per evitare errore app.");

      gifts = generateFallbackGifts(req.body);
    }

    cache.set(cacheKey, gifts);
    console.log("💾 Risposta salvata in cache");

    return res.json({
      gifts,
      fromCache: false
    });
  } catch (e) {
    console.error("Errore backend:", e);

    const fallbackGifts = generateFallbackGifts(req.body || {});

    return res.json({
      gifts: fallbackGifts,
      fromCache: false,
      fallback: true,
      warning: e.message || "Errore backend gestito con fallback"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Backend attivo sulla porta ${PORT}`);
});