const { grantManualPlus } = require("../lib/plus-admin-grants");
const { loadPlusEntitlement } = require("../lib/plus-entitlements");
const {
  authenticateAdminRequest,
  findUserById,
  publicError,
  sendJson,
} = require("../lib/user-store");

const MAX_BODY_BYTES = 2_048;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "private, no-store");
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Metodo non supportato." });
  }

  try {
    requireSameOrigin(req);
    const { user: adminUser } = await authenticateAdminRequest(req);
    const body = await readBoundedJson(req);
    validateBody(body);

    const targetUser = await findUserById(body.userId);
    if (!targetUser) throw requestError("Utente non trovato.", 404);

    const result = await grantManualPlus({
      targetUser,
      adminUser,
      requestId: body.requestId,
      loadCurrentEntitlement: () => loadPlusEntitlement(targetUser),
    });
    return sendJson(res, 200, {
      grant: {
        granted: Boolean(result.granted),
        replayed: Boolean(result.replayed),
        reason: result.reason,
        userId: String(targetUser.id),
        access: publicAccess(result.entitlement),
      },
    });
  } catch (error) {
    const response = publicError(error, "Attivazione Plus non riuscita.");
    return sendJson(res, response.statusCode, response.payload);
  }
};

function validateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw requestError("Richiesta non valida.");
  }
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "requestId,userId") {
    throw requestError("Richiesta non valida.");
  }
  if (!isUuid(body.userId) || !isUuid(body.requestId)) {
    throw requestError("Richiesta non valida.");
  }
}

function requireSameOrigin(req) {
  const origin = String(req.headers?.origin || "").trim();
  const forwardedHost = String(req.headers?.["x-forwarded-host"] || "")
    .split(",")[0]
    .trim();
  const host = forwardedHost || String(req.headers?.host || "").trim();
  const forwardedProto = String(req.headers?.["x-forwarded-proto"] || "")
    .split(",")[0]
    .trim();
  const protocol =
    forwardedProto || (host.startsWith("localhost") ? "http" : "https");
  let normalizedOrigin = "";
  try {
    normalizedOrigin = new URL(origin).origin;
  } catch {
    // The generic error below keeps malformed and missing origins equivalent.
  }
  if (!host || normalizedOrigin !== `${protocol}://${host}`) {
    throw requestError("Origine richiesta non valida.", 403);
  }
}

async function readBoundedJson(req) {
  const declaredLength = Number(req.headers?.["content-length"] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw requestError("Richiesta troppo grande.", 413);
  }

  if (req.body && typeof req.body === "object") {
    const serialized = JSON.stringify(req.body);
    if (Buffer.byteLength(serialized) > MAX_BODY_BYTES) {
      throw requestError("Richiesta troppo grande.", 413);
    }
    return req.body;
  }

  let raw = typeof req.body === "string" ? req.body : "";
  if (!raw && req[Symbol.asyncIterator]) {
    const chunks = [];
    let total = 0;
    for await (const chunk of req) {
      const value = Buffer.from(chunk);
      total += value.length;
      if (total > MAX_BODY_BYTES) {
        throw requestError("Richiesta troppo grande.", 413);
      }
      chunks.push(value);
    }
    raw = Buffer.concat(chunks).toString("utf8");
  }
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) {
    throw requestError("Richiesta troppo grande.", 413);
  }
  try {
    return JSON.parse(raw || "{}");
  } catch {
    throw requestError("JSON non valido.");
  }
}

function publicAccess(entitlement) {
  return {
    active: Boolean(entitlement?.active),
    source: entitlement?.source || null,
    expiresAt: entitlement?.expiresAt || null,
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function requestError(message, statusCode = 400) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}
