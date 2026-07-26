const crypto = require("node:crypto");

const BUCKET = "quizpatente-plus-usage";
const DAILY_LIMIT = 30;
const BURST_LIMIT = 6;

const runtime = globalThis;
runtime.__quizPatentePlusUsage ||= {
  bucketReady: false,
  bucketPromise: null,
};

async function consumePlusGeneration(user, kind, generationKey) {
  if (
    !user?.id ||
    !["explanation", "translation"].includes(kind) ||
    !String(generationKey || "").trim()
  ) {
    const error = new Error("Contatore Plus non valido.");
    error.publicMessage = "Non riesco a verificare il limite Plus.";
    error.statusCode = 500;
    throw error;
  }

  await ensureBucket();
  const userKey = usageKey(user);
  const now = new Date();
  const dateKey = now.toISOString().slice(0, 10);
  const minuteKey = now.toISOString().slice(0, 16).replace(/:/g, "-");

  await claimFirstAvailableSlot(
    `burst/${minuteKey}/${userKey}`,
    BURST_LIMIT,
    "Attendi un minuto prima di generare altri contenuti.",
  );
  const dailySlot = await claimFirstAvailableSlot(
    `daily/${dateKey}/${userKey}`,
    DAILY_LIMIT,
    "Hai raggiunto il limite di 30 nuovi contenuti AI per oggi. I contenuti già disponibili restano accessibili.",
  );

  const generationHash = crypto
    .createHash("sha256")
    .update(`${kind}:${String(generationKey)}`)
    .digest("hex");
  const lockPath = `locks/${dateKey}/${generationHash}.json`;
  const lock = await createClaim(lockPath, {
    kind,
    user: userKey.slice(0, 16),
    createdAt: now.toISOString(),
  });
  if (!lock.created) {
    const error = new Error("Generazione già in corso.");
    error.publicMessage =
      "Questo contenuto è già in preparazione. Attendi qualche secondo e riprova.";
    error.statusCode = 409;
    throw error;
  }

  let released = false;
  return {
    limit: DAILY_LIMIT,
    remaining: Math.max(0, DAILY_LIMIT - dailySlot - 1),
    async release() {
      if (released) return;
      released = true;
      await deleteClaim(lockPath);
    },
  };
}

async function claimFirstAvailableSlot(prefix, limit, publicMessage) {
  for (let slot = 0; slot < limit; slot += 1) {
    const result = await createClaim(`${prefix}/${slot}.json`, {
      slot,
      createdAt: new Date().toISOString(),
    });
    if (result.created) return slot;
  }

  const error = new Error("Limite Plus raggiunto.");
  error.publicMessage = publicMessage;
  error.statusCode = 429;
  throw error;
}

async function createClaim(objectPath, payload) {
  const response = await fetch(objectUrl(null, objectPath), {
    method: "POST",
    headers: {
      ...storageHeaders(),
      "Content-Type": "application/json",
      "x-upsert": "false",
    },
    body: JSON.stringify(payload),
  });
  if (response.ok) return { created: true };

  const body = await response.text();
  const normalized = body.toLowerCase();
  const conflict =
    response.status === 409 ||
    (response.status === 400 &&
      (normalized.includes("already exists") ||
        normalized.includes("resource exists") ||
        normalized.includes("duplicate")));
  if (conflict) return { created: false };
  throw usageUnavailable(body);
}

async function deleteClaim(objectPath) {
  const response = await fetch(`${supabaseUrl()}/storage/v1/object/${BUCKET}`, {
    method: "DELETE",
    headers: {
      ...storageHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ prefixes: [objectPath] }),
  });
  if (!response.ok && response.status !== 404) {
    throw usageUnavailable(await response.text());
  }
}

function usageKey(user) {
  const secret = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return crypto
    .createHmac("sha256", secret)
    .update(`${user.id}:${String(user.email || "").trim().toLowerCase()}`)
    .digest("hex");
}

async function ensureBucket() {
  if (runtime.__quizPatentePlusUsage.bucketReady) return;
  if (runtime.__quizPatentePlusUsage.bucketPromise) {
    return runtime.__quizPatentePlusUsage.bucketPromise;
  }

  runtime.__quizPatentePlusUsage.bucketPromise = (async () => {
    const existing = await fetch(`${supabaseUrl()}/storage/v1/bucket/${BUCKET}`, {
      headers: storageHeaders(),
    });
    if (existing.ok) {
      runtime.__quizPatentePlusUsage.bucketReady = true;
      return;
    }

    const body = await existing.text();
    if (existing.status !== 404 && !body.toLowerCase().includes("not found")) {
      throw usageUnavailable(body);
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
      throw usageUnavailable(await created.text());
    }
    runtime.__quizPatentePlusUsage.bucketReady = true;
  })();

  try {
    await runtime.__quizPatentePlusUsage.bucketPromise;
  } finally {
    runtime.__quizPatentePlusUsage.bucketPromise = null;
  }
}

function objectUrl(scope, objectPath) {
  const encodedPath = objectPath.split("/").map(encodeURIComponent).join("/");
  const prefix = scope ? `object/${scope}` : "object";
  return `${supabaseUrl()}/storage/v1/${prefix}/${BUCKET}/${encodedPath}`;
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
  if (!value) throw usageUnavailable(`${name} mancante.`);
  return value;
}

function usageUnavailable(details) {
  const error = new Error(details || "Contatore Plus non disponibile.");
  error.publicMessage = "Non riesco a verificare il limite Plus. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  BURST_LIMIT,
  DAILY_LIMIT,
  consumePlusGeneration,
};
