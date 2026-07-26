const crypto = require("node:crypto");

const BUCKET = "quizpatente-plus-entitlements";
const runtime = globalThis;
runtime.__quizPatenteEntitlementStore ||= {
  bucketReady: false,
  bucketPromise: null,
};

async function loadPlusEntitlement(user) {
  await ensureBucket();
  const response = await fetch(objectUrl("authenticated", entitlementPath(user)), {
    headers: storageHeaders(),
    cache: "no-store",
  });
  if (response.status === 404) return null;
  if (!response.ok) throw storageUnavailable(await response.text());
  const value = await response.json().catch(() => null);
  return normalizeEntitlement(value);
}

async function savePlusEntitlement(user, access) {
  await ensureBucket();
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
  const response = await fetch(objectUrl(null, entitlementPath(user)), {
    method: "POST",
    headers: {
      ...storageHeaders(),
      "Content-Type": "application/json",
      "x-upsert": "true",
    },
    body: JSON.stringify(entitlement),
  });
  if (!response.ok) throw storageUnavailable(await response.text());
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
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const digest = crypto
    .createHmac("sha256", key)
    .update(`${user.id}:${String(user.email || "").trim().toLowerCase()}`)
    .digest("hex");
  return `accounts/${digest}.json`;
}

async function ensureBucket() {
  if (runtime.__quizPatenteEntitlementStore.bucketReady) return;
  if (runtime.__quizPatenteEntitlementStore.bucketPromise) {
    return runtime.__quizPatenteEntitlementStore.bucketPromise;
  }

  runtime.__quizPatenteEntitlementStore.bucketPromise = (async () => {
    const existing = await fetch(`${supabaseUrl()}/storage/v1/bucket/${BUCKET}`, {
      headers: storageHeaders(),
    });
    if (existing.ok) {
      runtime.__quizPatenteEntitlementStore.bucketReady = true;
      return;
    }
    const body = await existing.text();
    if (existing.status !== 404 && !body.toLowerCase().includes("not found")) {
      throw storageUnavailable(body);
    }
    const created = await fetch(`${supabaseUrl()}/storage/v1/bucket`, {
      method: "POST",
      headers: {
        ...storageHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        id: BUCKET,
        name: BUCKET,
        public: false,
        file_size_limit: 20_000,
        allowed_mime_types: ["application/json"],
      }),
    });
    if (!created.ok && created.status !== 409) {
      throw storageUnavailable(await created.text());
    }
    runtime.__quizPatenteEntitlementStore.bucketReady = true;
  })();

  try {
    await runtime.__quizPatenteEntitlementStore.bucketPromise;
  } finally {
    runtime.__quizPatenteEntitlementStore.bucketPromise = null;
  }
}

function objectUrl(scope, path) {
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  const prefix = scope ? `object/${scope}` : "object";
  return `${supabaseUrl()}/storage/v1/${prefix}/${BUCKET}/${encoded}`;
}

function storageHeaders() {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return { apikey: key, Authorization: `Bearer ${key}` };
}

function supabaseUrl() {
  return requireEnv("SUPABASE_URL").replace(/\/$/, "");
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
