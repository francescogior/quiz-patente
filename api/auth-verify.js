const {
  getProgress,
  isValidEmail,
  normalizeEmail,
  publicError,
  readJson,
  sendJson,
  verifyLoginCode,
  withAdminFlag,
} = require("../lib/user-store");
const { enforceAuthVerifyLimit } = require("../lib/request-limits");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    const code = String(body.code || "").slice(0, 32).replace(/\D/g, "");
    if (!isValidEmail(email) || code.length !== 6) {
      return sendJson(res, 400, { error: "Email o codice non validi." });
    }

    await enforceAuthVerifyLimit(req, email);
    const { token, user } = await verifyLoginCode(email, code);
    const progress = await getProgress(user.id);

    return sendJson(res, 200, { token, user: withAdminFlag(user), progress });
  } catch (error) {
    const response = publicError(error, "Codice non valido.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
