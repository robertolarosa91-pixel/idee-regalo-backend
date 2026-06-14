import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const app = express();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${GEMINI_API_KEY}`;

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

    const geminiResponse = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: prompt }
            ]
          }
        ],
        generationConfig: {
          temperature: 0.7,
          maxOutputTokens: 4096,
          responseMimeType: "application/json"
        }
      })
    });

    const data = await geminiResponse.json();

    if (data.error) {
      return res.status(500).json({
        error: data.error.message
      });
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";

    let cleaned = text
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

    const gifts = JSON.parse(cleaned.slice(start, end + 1));

    if (!Array.isArray(gifts)) {
      return res.status(500).json({
        error: "La risposta Gemini non è una lista"
      });
    }

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
