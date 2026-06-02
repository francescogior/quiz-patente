const { authenticateRequest, destroySession, publicError, sendJson } = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { token } = await authenticateRequest(req);
    await destroySession(token);
    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const response = publicError(error, "Logout non riuscito.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
