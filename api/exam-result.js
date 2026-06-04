const { authenticateRequest, getExamResult, publicError, sendJson } = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    const url = new URL(req.url, "https://quizpatente.realb.it");
    const examId = url.searchParams.get("examId");
    const exam = await getExamResult(user.id, examId);
    return sendJson(res, 200, { exam });
  } catch (error) {
    const response = publicError(error, "Test non disponibile.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
