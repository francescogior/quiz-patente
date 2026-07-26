const crypto = require("node:crypto");

const BUCKET = "quizpatente-request-limits";
const runtime = globalThis;

runtime.__quizPatenteRequestLimits ||= {
  bucketReady: false,
  bucketPromise: null,
};

async function enforceAuthRequestLimit(req, email, now = new Date()) {
  return consumeRateLimits(
    [
      rule("auth-request-email-15m", email, 3, 15 * 60),
      rule("auth-request-email-day", email, 8, 24 * 60 * 60),
      rule("auth-request-ip-15m", clientIp(req), 12, 15 * 60),
      rule("auth-request-ip-day", clientIp(req), 50, 24 * 60 * 60),
    ],
    now,
    "Hai richiesto troppi codici. Attendi e riprova più tardi.",
  );
}

async function enforceAuthVerifyLimit(req, email, now = new Date()) {
  return consumeRateLimits(
    [
      rule("auth-verify-email-10m", email, 6, 10 * 60),
      rule("auth-verify-email-day", email, 20, 24 * 60 * 60),
      rule("auth-verify-ip-10m", clientIp(req), 30, 10 * 60),
      rule("auth-verify-ip-day", clientIp(req), 150, 24 * 60 * 60),
    ],
    now,
    "Troppi tentativi di accesso. Richiedi un nuovo codice più tardi.",
  );
}

async function enforceExplanationReportLimit(user, questionId, reason, now = new Date()) {
  const identity = requireUserIdentity(user);
  return consumeRateLimits(
    [
      rule(
        "report-user-question-day",
        `${identity}:${questionId}:${reason}`,
        1,
        24 * 60 * 60,
        "Hai già inviato questa segnalazione oggi.",
      ),
      rule("report-user-day", identity, 5, 24 * 60 * 60),
    ],
    now,
    "Hai inviato troppe segnalazioni oggi. Riprova domani.",
  );
}

async function enforceExamResultWriteLimit(user, now = new Date()) {
  const identity = requireUserIdentity(user);
  return consumeRateLimits(
    [
      rule("exam-write-user-minute", identity, 4, 60),
      rule("exam-write-user-hour", identity, 15, 60 * 60),
      rule("exam-write-user-day", identity, 40, 24 * 60 * 60),
    ],
    now,
    "Troppi salvataggi ravvicinati. Attendi prima di riprovare.",
  );
}

function rule(namespace, identity, limit, windowSeconds, publicMessage) {
  return { namespace, identity: String(identity || ""), limit, windowSeconds, publicMessage };
}

async function consumeRateLimits(rules, now = new Date(), defaultPublicMessage) {
  const timestamp = new Date(now).getTime();
  if (!Number.isFinite(timestamp) || !Array.isArray(rules) || rules.length === 0) {
    throw limitsUnavailable("Configurazione limite non valida.");
  }

  await ensureBucket();
  for (const item of rules) {
    validateRule(item);
    const windowIndex = Math.floor(timestamp / (item.windowSeconds * 1000));
    const identityKey = hashIdentity(item.namespace, item.identity);
    const prefix = `v1/${item.namespace}/${item.windowSeconds}/${windowIndex}/${identityKey}`;
    await claimFirstAvailableSlot(
      prefix,
      item.limit,
      item.publicMessage || defaultPublicMessage || "Troppe richieste. Riprova più tardi.",
      timestamp,
    );
  }
}

async function claimFirstAvailableSlot(prefix, limit, publicMessage, timestamp) {
  for (let slot = 0; slot < limit; slot += 1) {
    const response = await fetch(objectUrl(`${prefix}/${slot}.json`), {
      method: "POST",
      headers: {
        ...storageHeaders(),
        "Content-Type": "application/json",
        "x-upsert": "false",
      },
      body: JSON.stringify({ version: 1, claimedAt: new Date(timestamp).toISOString() }),
    });
    if (response.ok) return slot;

    const body = await response.text();
    if (isConflict(response.status, body)) continue;
    throw limitsUnavailable(body);
  }

  const error = new Error("Limite richieste raggiunto.");
  error.publicMessage = publicMessage;
  error.statusCode = 429;
  throw error;
}

function validateRule(item) {
  const valid =
    item &&
    /^[a-z0-9-]{3,64}$/.test(item.namespace) &&
    item.identity.length > 0 &&
    item.identity.length <= 512 &&
    Number.isInteger(item.limit) &&
    item.limit >= 1 &&
    item.limit <= 200 &&
    Number.isInteger(item.windowSeconds) &&
    item.windowSeconds >= 60 &&
    item.windowSeconds <= 24 * 60 * 60;
  if (!valid) throw limitsUnavailable("Regola limite non valida.");
}

function hashIdentity(namespace, identity) {
  return crypto
    .createHmac("sha256", requireEnv("SUPABASE_SERVICE_ROLE_KEY"))
    .update(`${namespace}:${identity}`)
    .digest("hex");
}

function clientIp(req) {
  const headers = req?.headers || {};
  const forwarded = firstHeaderValue(
    headers["x-forwarded-for"] ||
      headers["x-vercel-forwarded-for"] ||
      headers["cf-connecting-ip"] ||
      headers["x-real-ip"],
  );
  const normalized = String(forwarded || "unknown").trim().slice(0, 80);
  return normalized || "unknown";
}

function firstHeaderValue(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return String(first || "").split(",")[0].trim();
}

function requireUserIdentity(user) {
  const id = String(user?.id || "").trim();
  if (!id || id.length > 128) throw limitsUnavailable("Utente limite non valido.");
  return id;
}

function isConflict(status, body) {
  const normalized = String(body || "").toLowerCase();
  return (
    status === 409 ||
    (status === 400 &&
      (normalized.includes("already exists") ||
        normalized.includes("resource exists") ||
        normalized.includes("duplicate")))
  );
}

async function ensureBucket() {
  if (runtime.__quizPatenteRequestLimits.bucketReady) return;
  if (runtime.__quizPatenteRequestLimits.bucketPromise) {
    return runtime.__quizPatenteRequestLimits.bucketPromise;
  }

  runtime.__quizPatenteRequestLimits.bucketPromise = (async () => {
    const existing = await fetch(`${supabaseUrl()}/storage/v1/bucket/${BUCKET}`, {
      headers: storageHeaders(),
    });
    if (existing.ok) {
      runtime.__quizPatenteRequestLimits.bucketReady = true;
      return;
    }

    const body = await existing.text();
    if (existing.status !== 404 && !body.toLowerCase().includes("not found")) {
      throw limitsUnavailable(body);
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
      throw limitsUnavailable(await created.text());
    }
    runtime.__quizPatenteRequestLimits.bucketReady = true;
  })();

  try {
    await runtime.__quizPatenteRequestLimits.bucketPromise;
  } finally {
    runtime.__quizPatenteRequestLimits.bucketPromise = null;
  }
}

function objectUrl(objectPath) {
  const encoded = objectPath.split("/").map(encodeURIComponent).join("/");
  return `${supabaseUrl()}/storage/v1/object/${BUCKET}/${encoded}`;
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
  if (!value) throw limitsUnavailable(`${name} mancante.`);
  return value;
}

function limitsUnavailable(details) {
  const error = new Error(details || "Limiti richieste non disponibili.");
  error.publicMessage = "Non riesco a verificare i limiti di sicurezza. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  BUCKET,
  consumeRateLimits,
  enforceAuthRequestLimit,
  enforceAuthVerifyLimit,
  enforceExamResultWriteLimit,
  enforceExplanationReportLimit,
};
