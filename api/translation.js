const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { authenticateRequest, publicError, readJson, sendJson } = require("../lib/user-store");

const PROMPT_VERSION = "quiz-patente-translation-v1";
const BUCKET = "question-translations";
const ORIGINAL_LANGUAGE = "it";

let questionMap;
let bucketReady = false;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    await authenticateRequest(req);
    const body = await readJson(req);
    const questionId = Number(body.questionId);
    const question = getQuestion(questionId);
    if (!question) return sendJson(res, 404, { error: "Domanda non trovata." });

    const language = normalizeLanguage(body.language);
    const explanation = String(body.explanation || "").trim().slice(0, 1400);

    if (language.code === ORIGINAL_LANGUAGE) {
      return sendJson(res, 200, {
        source: "original",
        translation: {
          questionId: question.id,
          language,
          topic: question.topic,
          questionText: question.text,
          explanation,
          promptVersion: PROMPT_VERSION,
        },
      });
    }

    const cachePath = buildCachePath(question, language, explanation);
    const cached = await findCachedTranslation(cachePath);
    if (cached) {
      return sendJson(res, 200, { source: "cache", translation: cached });
    }

    const generated = await generateTranslation(question, language, explanation);
    const translation = {
      questionId: question.id,
      language,
      topic: generated.translated_topic || question.topic,
      questionText: generated.translated_question || question.text,
      explanation: generated.translated_explanation || "",
      model: openaiModel(),
      promptVersion: PROMPT_VERSION,
      updatedAt: new Date().toISOString(),
    };

    await saveCachedTranslation(cachePath, translation);
    return sendJson(res, 200, { source: "generated", translation });
  } catch (error) {
    const response = publicError(error, "Traduzione non disponibile ora.");
    return sendJson(res, response.statusCode, response.payload);
  }
};

function getQuestion(id) {
  if (!Number.isInteger(id)) return null;
  if (!questionMap) {
    const datasetPath = path.join(process.cwd(), "data", "questions.js");
    const source = fs.readFileSync(datasetPath, "utf8").trim();
    const prefix = "window.PATENTE_QUESTION_BANK = ";
    if (!source.startsWith(prefix)) throw new Error("Dataset non valido.");
    const json = source.slice(prefix.length).replace(/;$/, "");
    const bank = JSON.parse(json);
    questionMap = new Map(bank.questions.map((question) => [question.id, question]));
  }
  return questionMap.get(id) || null;
}

function normalizeLanguage(value) {
  const raw = typeof value === "object" && value ? value : {};
  const code = String(raw.code || "").trim().slice(0, 32);
  const label = String(raw.label || "").trim().slice(0, 80);
  const isCustom = Boolean(raw.custom);

  if (!code || code === ORIGINAL_LANGUAGE) {
    return { code: ORIGINAL_LANGUAGE, label: "Italiano originale", custom: false };
  }

  if (!label) {
    const error = new Error("Lingua mancante.");
    error.publicMessage = "Seleziona una lingua valida.";
    error.statusCode = 400;
    throw error;
  }

  return { code, label, custom: isCustom };
}

function buildCachePath(question, language, explanation) {
  const languageKey = slugLanguage(language);
  const sourceHash = hashText(
    [PROMPT_VERSION, question.id, question.text, question.topic, explanation].join("\n"),
  ).slice(0, 18);
  return `${question.id}/${languageKey}-${sourceHash}.json`;
}

function slugLanguage(language) {
  const base = `${language.code}-${language.label}`
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 56);
  return base || hashText(language.label).slice(0, 16);
}

function hashText(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

async function findCachedTranslation(cachePath) {
  try {
    await ensureBucket();
    const response = await fetch(storageObjectUrl(cachePath), {
      headers: supabaseHeaders(),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  } catch (error) {
    console.error("Translation cache read failed", { message: error.message });
    return null;
  }
}

async function saveCachedTranslation(cachePath, translation) {
  try {
    await ensureBucket();
    const response = await fetch(storageObjectUrl(cachePath), {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        "Content-Type": "application/json",
        "x-upsert": "true",
      },
      body: JSON.stringify(translation),
    });
    if (!response.ok) throw new Error(await response.text());
  } catch (error) {
    console.error("Translation cache write failed", { message: error.message });
  }
}

async function ensureBucket() {
  if (bucketReady) return;

  const existing = await fetch(`${supabaseUrl()}/storage/v1/bucket/${BUCKET}`, {
    headers: supabaseHeaders(),
  });
  if (existing.ok) {
    bucketReady = true;
    return;
  }
  const existingBody = await existing.text();
  const missingBucket = existing.status === 404 || existingBody.includes("Bucket not found");
  if (!missingBucket) throw new Error(existingBody);

  const created = await fetch(`${supabaseUrl()}/storage/v1/bucket`, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      id: BUCKET,
      name: BUCKET,
      public: false,
      file_size_limit: 200000,
      allowed_mime_types: ["application/json"],
    }),
  });
  if (!created.ok && created.status !== 409) throw new Error(await created.text());
  bucketReady = true;
}

function storageObjectUrl(cachePath) {
  const encodedPath = cachePath.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl()}/storage/v1/object/${BUCKET}/${encodedPath}`;
}

async function generateTranslation(question, language, explanation) {
  requireEnv("OPENAI_API_KEY");

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel(),
      instructions: [
        "Traduci contenuti per una app di quiz patente AB.",
        `Lingua target: ${language.label}.`,
        "Sii fedele al testo italiano, senza aggiungere spiegazioni o informazioni non presenti.",
        "Mantieni il senso tecnico dei segnali stradali, delle precedenze e delle norme.",
        "Se la lingua target e scritta con un alfabeto diverso, usa naturalmente quell'alfabeto.",
      ].join(" "),
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: [
                `Argomento: ${question.topic}`,
                `Domanda: ${question.text}`,
                explanation ? `Spiegazione: ${explanation}` : "Spiegazione: ",
              ].join("\n"),
            },
          ],
        },
      ],
      max_output_tokens: 1300,
      reasoning: { effort: "minimal" },
      text: {
        format: {
          type: "json_schema",
          name: "quiz_patente_translation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["translated_topic", "translated_question", "translated_explanation"],
            properties: {
              translated_topic: { type: "string", maxLength: 180 },
              translated_question: { type: "string", minLength: 1, maxLength: 1200 },
              translated_explanation: { type: "string", maxLength: 1600 },
            },
          },
        },
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.error?.message || "OpenAI non disponibile.");
    error.publicMessage = "Traduzione non disponibile ora.";
    error.statusCode = 502;
    throw error;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error("Risposta traduzione vuota.");
  return JSON.parse(outputText);
}

function extractOutputText(payload) {
  if (payload?.output_text) return payload.output_text;
  const content = payload?.output?.flatMap((item) => item.content || []) || [];
  return content.find((item) => item.type === "output_text")?.text || null;
}

function supabaseUrl() {
  return requireEnv("SUPABASE_URL").replace(/\/$/, "");
}

function supabaseHeaders() {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
  };
}

function openaiModel() {
  return process.env.OPENAI_MODEL || "gpt-5-nano";
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`${name} mancante.`);
    error.publicMessage = "Configurazione server incompleta.";
    error.statusCode = 500;
    throw error;
  }
  return value;
}
