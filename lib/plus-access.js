const crypto = require("node:crypto");

const PRODUCT_SLUG = "quizpatente-plus";
const PRODUCT_TITLE = "Quiz Patente Plus — 30 giorni";
const PRICE_CENTS = 399;
const CURRENCY = "eur";
const ACCESS_DAYS = 30;
const TOKEN_VERSION = 1;

function plusSecret() {
  const value = process.env.APP_SECRET;
  if (!value) {
    const error = new Error("APP_SECRET mancante.");
    error.publicMessage = "Configurazione server incompleta.";
    error.statusCode = 500;
    throw error;
  }
  return value;
}

function encode(value) {
  return Buffer.from(value).toString("base64url");
}

function sign(payloadPart) {
  return crypto
    .createHmac("sha256", plusSecret())
    .update(payloadPart)
    .digest("base64url");
}

function issuePlusToken({ user, checkoutId, paidAt }) {
  const paidAtMs = new Date(paidAt || "").getTime();
  if (!Number.isFinite(paidAtMs)) {
    const error = new Error("Data pagamento mancante.");
    error.publicMessage = "Non riesco a verificare la durata del pass.";
    error.statusCode = 502;
    throw error;
  }
  const paidAtSeconds = Math.floor(paidAtMs / 1000);
  const payload = {
    v: TOKEN_VERSION,
    iss: "quizpatente.realb.it",
    product: PRODUCT_SLUG,
    sub: String(user.id),
    email: String(user.email || "")
      .trim()
      .toLowerCase(),
    checkoutId: String(checkoutId || "").slice(0, 128),
    paidAt: new Date(paidAtMs).toISOString(),
    iat: paidAtSeconds,
    exp: paidAtSeconds + ACCESS_DAYS * 24 * 60 * 60,
  };
  const payloadPart = encode(JSON.stringify(payload));
  return `${payloadPart}.${sign(payloadPart)}`;
}

function verifyPlusToken(token, user) {
  const [payloadPart, signature, extra] = String(token || "")
    .trim()
    .split(".");
  if (!payloadPart || !signature || extra) return invalidAccess();

  const expected = sign(payloadPart);
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    return invalidAccess();
  }

  let payload;
  try {
    payload = JSON.parse(
      Buffer.from(payloadPart, "base64url").toString("utf8"),
    );
  } catch {
    return invalidAccess();
  }

  const normalizedEmail = String(user?.email || "")
    .trim()
    .toLowerCase();
  const valid =
    payload?.v === TOKEN_VERSION &&
    payload?.iss === "quizpatente.realb.it" &&
    payload?.product === PRODUCT_SLUG &&
    payload?.sub === String(user?.id || "") &&
    payload?.email === normalizedEmail &&
    Number.isFinite(payload?.exp) &&
    payload.exp > Math.floor(Date.now() / 1000);
  if (!valid) return invalidAccess(payload?.exp);

  return {
    active: true,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    paidAt: payload.paidAt || null,
    checkoutId: payload.checkoutId || null,
    product: PRODUCT_SLUG,
  };
}

function plusTokenFromRequest(req) {
  return String(req.headers["x-quizpatente-plus"] || "").trim();
}

function requirePlusAccess(req, user) {
  const access = verifyPlusToken(plusTokenFromRequest(req), user);
  if (!access.active) {
    const error = new Error("Quiz Patente Plus richiesto.");
    error.publicMessage =
      "Spiegazioni e traduzioni sono disponibili con Quiz Patente Plus.";
    error.statusCode = 402;
    throw error;
  }
  return access;
}

function invalidAccess(exp) {
  return {
    active: false,
    expiresAt: Number.isFinite(exp) ? new Date(exp * 1000).toISOString() : null,
    product: PRODUCT_SLUG,
  };
}

module.exports = {
  ACCESS_DAYS,
  CURRENCY,
  PRICE_CENTS,
  PRODUCT_SLUG,
  PRODUCT_TITLE,
  issuePlusToken,
  plusTokenFromRequest,
  requirePlusAccess,
  verifyPlusToken,
};
