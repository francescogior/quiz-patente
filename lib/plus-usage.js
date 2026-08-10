const crypto = require("node:crypto");
const { claimJson, deleteJson } = require("./db-kv");

const BUCKET = "quizpatente-plus-usage";
const DAILY_LIMIT = 30;
const BURST_LIMIT = 6;

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
    "Hai raggiunto il limite di 30 nuovi contenuti AI per oggi. I contenuti Plus già disponibili restano accessibili.",
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
  try {
    return { created: await claimJson(BUCKET, objectPath, payload) };
  } catch (error) {
    throw usageUnavailable(error.message);
  }
}

async function deleteClaim(objectPath) {
  try {
    await deleteJson(BUCKET, objectPath);
  } catch (error) {
    throw usageUnavailable(error.message);
  }
}

function usageKey(user) {
  const secret = requireEnv("APP_SECRET");
  return crypto
    .createHmac("sha256", secret)
    .update(
      `${user.id}:${String(user.email || "")
        .trim()
        .toLowerCase()}`,
    )
    .digest("hex");
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw usageUnavailable(`${name} mancante.`);
  return value;
}

function usageUnavailable(details) {
  const error = new Error(details || "Contatore Plus non disponibile.");
  error.publicMessage =
    "Non riesco a verificare il limite Plus. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  BURST_LIMIT,
  DAILY_LIMIT,
  consumePlusGeneration,
};
