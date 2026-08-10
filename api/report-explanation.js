const REPORT_TABLE = "explanation_reports";
const { buildExplanationReport } = require("../lib/explanation-report");
const { getQuestion } = require("../lib/question-bank");
const { enforceExplanationReportLimit } = require("../lib/request-limits");
const { query } = require("../lib/db");
const {
  authenticateRequest,
  publicError,
  readJson,
  sendJson,
} = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    const body = await readJson(req);
    const questionId = Number(body.questionId);
    const question = getQuestion(questionId);
    if (!question) return sendJson(res, 404, { error: "Domanda non trovata." });

    const report = buildExplanationReport(question, body);
    await enforceExplanationReportLimit(user, question.id, report.reason);

    const tasks = [];
    if (process.env.DATABASE_URL) {
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
    const response = publicError(error, "Non riesco a inviare la segnalazione ora.");
    return sendJson(res, response.statusCode, response.payload);
  }
};

async function saveReport(report) {
  await query(
    `insert into ${REPORT_TABLE}
       (question_id, reason, message, page_url, explanation_meta)
     values ($1, $2, $3, $4, $5::jsonb)`,
    [
      report.question_id,
      report.reason,
      report.message,
      report.page_url,
      JSON.stringify(report.explanation_meta || {}),
    ],
  );
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

function configError() {
  const error = new Error("Configurazione segnalazioni incompleta.");
  error.publicMessage = "Configurazione server incompleta.";
  error.statusCode = 500;
  return error;
}
