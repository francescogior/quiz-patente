const crypto = require("node:crypto");

const USERS_TABLE = "app_users";
const CODES_TABLE = "app_login_codes";
const SESSIONS_TABLE = "app_sessions";
const RESULTS_TABLE = "user_exam_results";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    const error = new Error(`${name} mancante.`);
    error.publicMessage = "Configurazione server incompleta.";
    error.statusCode = 500;
    throw error;
  }
  return value;
}

function supabaseUrl() {
  return requireEnv("SUPABASE_URL").replace(/\/$/, "");
}

function supabaseHeaders(extra = {}) {
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    ...extra,
  };
}

async function supabaseFetch(path, options = {}) {
  const response = await fetch(`${supabaseUrl()}/rest/v1/${path}`, {
    ...options,
    headers: supabaseHeaders(options.headers),
  });
  if (!response.ok) {
    const error = new Error(await response.text());
    error.publicMessage = "Database progressi non pronto.";
    error.statusCode = 503;
    throw error;
  }
  if (response.status === 204) return null;
  return response.json();
}

function codeHash(email, code) {
  return crypto
    .createHmac("sha256", requireEnv("SUPABASE_SERVICE_ROLE_KEY"))
    .update(`${email}:${code}`)
    .digest("hex");
}

function tokenHash(token) {
  return crypto
    .createHmac("sha256", requireEnv("SUPABASE_SERVICE_ROLE_KEY"))
    .update(token)
    .digest("hex");
}

function randomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function getOrCreateUser(email) {
  const rows = await supabaseFetch(`${USERS_TABLE}?on_conflict=email`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify({ email, updated_at: new Date().toISOString() }),
  });
  return rows[0];
}

async function createLoginCode(email) {
  const user = await getOrCreateUser(email);
  const code = randomCode();
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();

  await supabaseFetch(CODES_TABLE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({
      user_id: user.id,
      email,
      code_hash: codeHash(email, code),
      expires_at: expiresAt,
    }),
  });

  return { user, code };
}

async function sendLoginCode(email, code) {
  requireEnv("RESEND_API_KEY");
  requireEnv("EMAIL_FROM");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: email,
      subject: "Codice accesso Quiz Patente",
      text: [
        "Codice accesso Quiz Patente",
        "",
        `Il tuo codice e: ${code}`,
        "",
        "Scade tra 10 minuti.",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    const error = new Error(await response.text());
    error.publicMessage = "Non riesco a inviare il codice ora.";
    error.statusCode = 502;
    throw error;
  }
}

async function verifyLoginCode(email, code) {
  const url = new URL(`${CODES_TABLE}`, "https://example.test");
  url.searchParams.set("email", `eq.${email}`);
  url.searchParams.set("code_hash", `eq.${codeHash(email, code)}`);
  url.searchParams.set("consumed_at", "is.null");
  url.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
  url.searchParams.set("select", "id,user_id");
  url.searchParams.set("order", "created_at.desc");
  url.searchParams.set("limit", "1");

  const rows = await supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
  const match = rows[0];
  if (!match) {
    const error = new Error("Codice non valido.");
    error.publicMessage = "Codice non valido o scaduto.";
    error.statusCode = 401;
    throw error;
  }

  await supabaseFetch(`${CODES_TABLE}?id=eq.${match.id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ consumed_at: new Date().toISOString() }),
  });

  return createSession(match.user_id);
}

async function createSession(userId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const rows = await supabaseFetch(SESSIONS_TABLE, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      user_id: userId,
      token_hash: tokenHash(token),
      expires_at: expiresAt,
    }),
  });

  const user = await findUserById(userId);
  return { token, session: rows[0], user };
}

async function authenticateRequest(req) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    const error = new Error("Token mancante.");
    error.publicMessage = "Accesso richiesto.";
    error.statusCode = 401;
    throw error;
  }

  const url = new URL(`${SESSIONS_TABLE}`, "https://example.test");
  url.searchParams.set("token_hash", `eq.${tokenHash(token)}`);
  url.searchParams.set("expires_at", `gt.${new Date().toISOString()}`);
  url.searchParams.set("select", "id,user_id,expires_at");
  url.searchParams.set("limit", "1");

  const rows = await supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
  const session = rows[0];
  if (!session) {
    const error = new Error("Sessione scaduta.");
    error.publicMessage = "Sessione scaduta. Accedi di nuovo.";
    error.statusCode = 401;
    throw error;
  }

  const user = await findUserById(session.user_id);
  return { token, session, user };
}

async function destroySession(token) {
  await supabaseFetch(`${SESSIONS_TABLE}?token_hash=eq.${tokenHash(token)}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });
}

async function findUserById(userId) {
  const rows = await supabaseFetch(`${USERS_TABLE}?id=eq.${userId}&select=id,email&limit=1`);
  return rows[0] || null;
}

async function saveExamResult(userId, payload) {
  const row = normalizeExamResult(userId, payload);
  await supabaseFetch(`${RESULTS_TABLE}?on_conflict=user_id,exam_id`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  });
}

function normalizeExamResult(userId, payload) {
  const totalQuestions = clampInteger(payload.totalQuestions, 1, 60, 30);
  const errorCount = clampInteger(payload.errorCount, 0, totalQuestions, 0);
  const correctCount = clampInteger(payload.correctCount, 0, totalQuestions, totalQuestions - errorCount);

  return {
    user_id: userId,
    exam_id: String(payload.examId || crypto.randomUUID()),
    started_at: safeIso(payload.startedAt) || new Date().toISOString(),
    finished_at: safeIso(payload.finishedAt) || new Date().toISOString(),
    used_ms: clampInteger(payload.usedMs, 0, 60 * 60 * 1000, 0),
    total_questions: totalQuestions,
    correct_count: correctCount,
    error_count: errorCount,
    passed: Boolean(payload.passed),
    finish_reason: ["manual", "timeout"].includes(payload.finishReason) ? payload.finishReason : "manual",
    answers: Array.isArray(payload.answers) ? payload.answers.slice(0, 60) : [],
    updated_at: new Date().toISOString(),
  };
}

async function getProgress(userId) {
  const url = new URL(`${RESULTS_TABLE}`, "https://example.test");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set(
    "select",
    "exam_id,finished_at,used_ms,total_questions,correct_count,error_count,passed,finish_reason",
  );
  url.searchParams.set("order", "finished_at.desc");
  url.searchParams.set("limit", "24");

  const rows = await supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
  const total = rows.length;
  const passed = rows.filter((row) => row.passed).length;
  const averageErrors =
    total === 0 ? 0 : rows.reduce((sum, row) => sum + Number(row.error_count || 0), 0) / total;

  return {
    summary: { total, passed, averageErrors },
    recent: rows.slice(0, 8).map((row) => ({
      examId: row.exam_id,
      finishedAt: row.finished_at,
      usedMs: row.used_ms,
      totalQuestions: row.total_questions,
      correctCount: row.correct_count,
      errorCount: row.error_count,
      passed: row.passed,
      finishReason: row.finish_reason,
    })),
  };
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.round(number), min), max);
}

function safeIso(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return JSON.parse(req.body || "{}");

  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function publicError(error, fallback = "Richiesta non riuscita.") {
  return {
    statusCode: error.statusCode || 500,
    payload: { error: error.publicMessage || fallback },
  };
}

module.exports = {
  authenticateRequest,
  createLoginCode,
  destroySession,
  getProgress,
  isValidEmail,
  normalizeEmail,
  publicError,
  readJson,
  saveExamResult,
  sendJson,
  sendLoginCode,
  verifyLoginCode,
};
