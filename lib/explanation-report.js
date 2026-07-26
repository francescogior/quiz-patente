function buildExplanationReport(question, body) {
  if (!question || !Number.isInteger(Number(question.id))) {
    throw validationError("Domanda non valida.");
  }

  const reason = String(body?.reason || "");
  if (!["wrong", "incomplete", "unclear"].includes(reason)) {
    throw validationError("Motivo della segnalazione non valido.");
  }

  return {
    question_id: Number(question.id),
    reason,
    message: normalizeMessage(body?.message),
    page_url: normalizePageUrl(body?.pageUrl),
    explanation_meta: normalizeExplanationMeta(body?.explanation),
    created_at: new Date().toISOString(),
  };
}

function normalizeMessage(value) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, 600);
}

function normalizePageUrl(value) {
  if (!value) return "";
  try {
    const url = new URL(String(value), "https://quizpatente.realb.it/");
    if (url.protocol !== "https:" || url.hostname !== "quizpatente.realb.it") return "";
    return `${url.origin}${url.pathname}`.slice(0, 300);
  } catch {
    return "";
  }
}

function normalizeExplanationMeta(value) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const result = {};
  const model = safeIdentifier(input.model, 80);
  const promptVersion = safeIdentifier(input.promptVersion, 80);
  const confidence = String(input.confidence || "").toLowerCase();
  if (model) result.model = model;
  if (promptVersion) result.promptVersion = promptVersion;
  if (["alta", "media", "bassa"].includes(confidence)) result.confidence = confidence;
  return result;
}

function safeIdentifier(value, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !/^[a-z0-9._:/-]+$/i.test(text)) return "";
  return text;
}

function validationError(publicMessage) {
  const error = new Error(publicMessage);
  error.publicMessage = publicMessage;
  error.statusCode = 400;
  return error;
}

module.exports = {
  buildExplanationReport,
};
