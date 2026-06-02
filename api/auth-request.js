const {
  createLoginCode,
  isValidEmail,
  normalizeEmail,
  publicError,
  readJson,
  sendJson,
  sendLoginCode,
} = require("../lib/user-store");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const body = await readJson(req);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return sendJson(res, 400, { error: "Email non valida." });

    const { code } = await createLoginCode(email);
    await sendLoginCode(email, code);

    return sendJson(res, 200, { ok: true });
  } catch (error) {
    const response = publicError(error, "Non riesco a inviare il codice ora.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
