const fs = require("node:fs");
const path = require("node:path");

const REPORT_TABLE = "explanation_reports";

let questionMap;

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const body = await readJson(req);
    const questionId = Number(body.questionId);
    const question = getQuestion(questionId);
    if (!question) return sendJson(res, 404, { error: "Domanda non trovata." });

    const report = {
      question_id: question.id,
      reason: normalizeReason(body.reason),
      message: String(body.message || "").slice(0, 600),
      page_url: String(body.pageUrl || "").slice(0, 500),
      explanation_meta: body.explanation || {},
      created_at: new Date().toISOString(),
    };

    const tasks = [];
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      tasks.push(saveReport(report));
    }
    if (process.env.RESEND_API_KEY && process.env.REPORT_EMAIL_TO && process.env.EMAIL_FROM) {
      tasks.push(sendReportEmail(question, report));
    }
    if (tasks.length === 0) throw configError();

    const outcomes = await Promise.allSettled(tasks);
    if (outcomes.every((outcome) => outcome.status === "rejected")) {
      throw new Error("Nessun canale di segnalazione disponibile.");
    }

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    return sendJson(res, error.statusCode || 500, {
      error: error.publicMessage || "Non riesco a inviare la segnalazione ora.",
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

async function saveReport(report) {
  const url = `${process.env.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/${REPORT_TABLE}`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(report),
  });
  if (!response.ok) throw new Error(await response.text());
}

async function sendReportEmail(question, report) {
  const reasonLabels = {
    wrong: "Spiegazione sbagliata",
    incomplete: "Spiegazione incompleta",
    unclear: "Spiegazione non chiara",
  };

  const text = [
    "Nuova segnalazione spiegazione Quiz Patente",
    "",
    `Domanda: ${question.id}`,
    `Argomento: ${question.topic}`,
    `Testo: ${question.text}`,
    `Risposta corretta: ${question.correct ? "Vero" : "Falso"}`,
    `Motivo: ${reasonLabels[report.reason] || report.reason}`,
    report.message ? `Messaggio: ${report.message}` : null,
    report.page_url ? `Pagina: ${report.page_url}` : null,
    `Meta: ${JSON.stringify(report.explanation_meta)}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: process.env.REPORT_EMAIL_TO,
      subject: `Quiz Patente: segnalazione domanda ${question.id}`,
      text,
    }),
  });
  if (!response.ok) throw new Error(await response.text());
}

function normalizeReason(reason) {
  return ["wrong", "incomplete", "unclear"].includes(reason) ? reason : "unclear";
}

function configError() {
  const error = new Error("Configurazione segnalazioni incompleta.");
  error.publicMessage = "Configurazione server incompleta.";
  error.statusCode = 500;
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
