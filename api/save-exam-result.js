const {
  authenticateRequest,
  getProgress,
  publicError,
  readJson,
  saveExamResult,
  sendJson,
} = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    const body = await readJson(req);
    await saveExamResult(user.id, body);
    const progress = await getProgress(user.id);
    return sendJson(res, 200, { ok: true, progress });
  } catch (error) {
    const response = publicError(error, "Non riesco a salvare la simulazione ora.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
