const fs = require("node:fs");
const path = require("node:path");

const PROMPT_VERSION = "quiz-patente-explanation-v2";
const TABLE = "question_explanations";

let questionMap;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const body = await readJson(req);
    const questionId = Number(body.questionId);
    const question = getQuestion(questionId);
    if (!question) return sendJson(res, 404, { error: "Domanda non trovata." });

    const cached = await findCachedExplanation(question.id);
    if (cached) {
      return sendJson(res, 200, {
        source: "cache",
        explanation: normalizeExplanation(cached),
      });
    }

    const generated = await generateExplanation(question, req);
    const row = await saveExplanation(question, generated);

    return sendJson(res, 200, {
      source: "generated",
      explanation: normalizeExplanation(row || { ...generated, question_id: question.id }),
    });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.publicMessage || "Non riesco a generare la spiegazione ora.",
    });
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

async function findCachedExplanation(questionId) {
  const url = new URL(`${supabaseUrl()}/rest/v1/${TABLE}`);
  url.searchParams.set("question_id", `eq.${questionId}`);
  url.searchParams.set("prompt_version", `eq.${PROMPT_VERSION}`);
  url.searchParams.set(
    "select",
    "question_id,true_explanation,false_explanation,key_point,confidence,model,prompt_version,updated_at",
  );

  const response = await fetch(url, { headers: supabaseHeaders() });
  if (!response.ok) {
    const message = await response.text();
    throw setupError(message);
  }

  const rows = await response.json();
  return rows[0] || null;
}

async function saveExplanation(question, explanation) {
  const url = new URL(`${supabaseUrl()}/rest/v1/${TABLE}`);
  url.searchParams.set("on_conflict", "question_id");

  const row = {
    question_id: question.id,
    question_text: question.text,
    topic: question.topic,
    correct_answer: question.correct,
    image_path: question.image || null,
    true_explanation: explanation.true_explanation,
    false_explanation: explanation.false_explanation,
    key_point: explanation.key_point,
    confidence: explanation.confidence,
    model: openaiModel(),
    prompt_version: PROMPT_VERSION,
    updated_at: new Date().toISOString(),
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      ...supabaseHeaders(),
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    const message = await response.text();
    throw setupError(message);
  }

  const rows = await response.json();
  return rows[0] || row;
}

async function generateExplanation(question, req) {
  requireEnv("OPENAI_API_KEY");

  const content = [
    {
      type: "input_text",
      text: [
        `Domanda ministeriale patente AB: ${question.text}`,
        `Argomento: ${question.topic}`,
        `Risposta corretta: ${question.correct ? "Vero" : "Falso"}`,
        "Produci due spiegazioni: una per chi sceglie Vero e una per chi sceglie Falso.",
      ].join("\n"),
    },
  ];

  const imageUrl = publicImageUrl(question.image, req);
  if (imageUrl) {
    content.push({ type: "input_image", image_url: imageUrl, detail: "low" });
  }

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: openaiModel(),
      instructions:
        "Sei un istruttore di teoria patente AB. Spiega in italiano in modo breve, preciso e didattico. Ogni spiegazione deve essere completa, non tronca, e in 2 frasi al massimo. Non inventare numeri di articoli o riferimenti normativi se non sei certo. Se una domanda usa una figura, interpreta l'immagine quando fornita. Non dire che la spiegazione e ufficiale.",
      input: [{ role: "user", content }],
      max_output_tokens: 1100,
      reasoning: { effort: "minimal" },
      text: {
        format: {
          type: "json_schema",
          name: "quiz_patente_explanation",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["true_explanation", "false_explanation", "key_point", "confidence"],
            properties: {
              true_explanation: {
                type: "string",
                minLength: 30,
                maxLength: 520,
              },
              false_explanation: {
                type: "string",
                minLength: 30,
                maxLength: 520,
              },
              key_point: {
                type: "string",
                minLength: 20,
                maxLength: 180,
              },
              confidence: {
                type: "string",
                enum: ["alta", "media", "bassa"],
              },
            },
          },
        },
      },
    }),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message = payload?.error?.message || "OpenAI non disponibile.";
    const error = new Error(message);
    error.publicMessage = "Non riesco a generare la spiegazione ora.";
    throw error;
  }

  const outputText = extractOutputText(payload);
  if (!outputText) throw new Error("Risposta AI vuota.");
  return JSON.parse(outputText);
}

function publicImageUrl(imagePath, req) {
  if (!imagePath) return null;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  if (!host || String(host).startsWith("localhost")) return null;
  const protocol = req.headers["x-forwarded-proto"] || "https";
  return `${protocol}://${host}/${imagePath.replace(/^\.\//, "")}`;
}

function normalizeExplanation(row) {
  return {
    questionId: row.question_id,
    trueExplanation: row.true_explanation,
    falseExplanation: row.false_explanation,
    keyPoint: row.key_point,
    confidence: row.confidence,
    model: row.model || openaiModel(),
    promptVersion: row.prompt_version || PROMPT_VERSION,
    updatedAt: row.updated_at || null,
  };
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

function setupError(details) {
  const error = new Error(details);
  error.publicMessage =
    "Database non pronto: crea le tabelle Supabase indicate in supabase/schema.sql.";
  error.statusCode = 503;
  return error;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
