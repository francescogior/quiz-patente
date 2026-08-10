const crypto = require("node:crypto");
const { readJson, writeJson } = require("./db-kv");

const BUCKET = "quizpatente-plus-entitlements";
async function loadPlusEntitlement(user) {
  try {
    return normalizeEntitlement(await readJson(BUCKET, entitlementPath(user)));
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function savePlusEntitlement(user, access) {
  const current = await loadPlusEntitlement(user);
  const nextExpiry = new Date(access.expiresAt || "").getTime();
  const currentExpiry = new Date(current?.expiresAt || "").getTime();
  const shouldReplace =
    !current ||
    !Number.isFinite(currentExpiry) ||
    (Number.isFinite(nextExpiry) && nextExpiry > currentExpiry);
  const next = shouldReplace
    ? {
        version: 1,
        checkoutId: String(access.checkoutId || "").slice(0, 128),
        paidAt: new Date(access.paidAt).toISOString(),
        expiresAt: new Date(access.expiresAt).toISOString(),
        activationEmailedAt:
          current?.checkoutId === access.checkoutId
            ? current.activationEmailedAt || null
            : null,
        updatedAt: new Date().toISOString(),
      }
    : current;

  await writeEntitlement(user, next);
  return next;
}

async function markEntitlementEmailed(user, entitlement) {
  const current = await loadPlusEntitlement(user);
  if (!current || current.checkoutId !== entitlement.checkoutId) return;
  await writeEntitlement(user, {
    ...current,
    activationEmailedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

async function writeEntitlement(user, entitlement) {
  try {
    await writeJson(BUCKET, entitlementPath(user), entitlement);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

function normalizeEntitlement(value) {
  if (!value || value.version !== 1) return null;
  const paidAt = new Date(value.paidAt || "");
  const expiresAt = new Date(value.expiresAt || "");
  const checkoutId = String(value.checkoutId || "");
  if (
    !checkoutId ||
    Number.isNaN(paidAt.getTime()) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return null;
  }
  return {
    active: expiresAt.getTime() > Date.now(),
    checkoutId,
    paidAt: paidAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    activationEmailedAt: value.activationEmailedAt || null,
  };
}

function entitlementPath(user) {
  const key = requireEnv("APP_SECRET");
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${user.id}:${String(user.email || "").trim().toLowerCase()}`)
    .digest("hex");
  return `accounts/${digest}.json`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw storageUnavailable(`${name} mancante.`);
  return value;
}

function storageUnavailable(details) {
  const error = new Error(details || "Archivio entitlement non disponibile.");
  error.publicMessage = "Non riesco a verificare l’accesso Plus. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  loadPlusEntitlement,
  markEntitlementEmailed,
  savePlusEntitlement,
};
