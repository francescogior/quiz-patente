const { authenticateRequest, getProgress, publicError, sendJson } = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    const progress = await getProgress(user.id);
    return sendJson(res, 200, { progress });
  } catch (error) {
    const response = publicError(error, "Progressi non disponibili.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
