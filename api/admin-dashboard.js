const {
  authenticateAdminRequest,
  getAdminDashboard,
  publicError,
  sendJson,
} = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    await authenticateAdminRequest(req);
    const admin = await getAdminDashboard();
    return sendJson(res, 200, { admin });
  } catch (error) {
    const response = publicError(error, "Dashboard admin non disponibile.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
