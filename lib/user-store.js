const crypto = require("node:crypto");

const USERS_TABLE = "app_users";
const CODES_TABLE = "app_login_codes";
const SESSIONS_TABLE = "app_sessions";
const RESULTS_TABLE = "user_exam_results";
const SESSION_DAYS = 30;
const CODE_MINUTES = 10;
const ADMIN_EMAILS_ENV = "ADMIN_EMAILS";

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function isAdminEmail(email) {
  const admins = String(process.env[ADMIN_EMAILS_ENV] || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
  return admins.includes(normalizeEmail(email));
}

function withAdminFlag(user) {
  if (!user) return user;
  return { ...user, isAdmin: isAdminEmail(user.email) };
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
  const body = await response.text();
  return body ? JSON.parse(body) : null;
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
  const resendApiKey = requireEnv("RESEND_API_KEY").trim();
  const emailFrom = requireEnv("EMAIL_FROM").trim();

  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
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
  } catch (fetchError) {
    console.error("Resend request failed before response", {
      message: fetchError.message,
      cause: fetchError.cause?.message,
    });
    const error = new Error(fetchError.message);
    error.publicMessage = "Non riesco a inviare il codice ora.";
    error.statusCode = 502;
    throw error;
  }

  if (!response.ok) {
    const body = await response.text();
    console.error("Resend rejected login code email", {
      status: response.status,
      body: body.slice(0, 500),
    });
    const error = new Error(body);
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

async function authenticateAdminRequest(req) {
  const auth = await authenticateRequest(req);
  if (!isAdminEmail(auth.user?.email)) {
    const error = new Error("Accesso admin richiesto.");
    error.publicMessage = "Accesso admin richiesto.";
    error.statusCode = 403;
    throw error;
  }
  return auth;
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
    "exam_id,finished_at,used_ms,total_questions,correct_count,error_count,passed,finish_reason,answers",
  );
  url.searchParams.set("order", "finished_at.desc");
  url.searchParams.set("limit", "50");

  const rows = await supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
  const simulationRows = rows.filter((row) => examMode(row.exam_id) === "simulation");
  const total = simulationRows.length;
  const passed = simulationRows.filter((row) => row.passed).length;
  const averageErrors =
    total === 0 ? 0 : simulationRows.reduce((sum, row) => sum + Number(row.error_count || 0), 0) / total;
  const revision = buildRevisionProgress(rows);

  return {
    summary: { total, passed, averageErrors },
    recent: rows.slice(0, 24).map((row) => ({
      examId: row.exam_id,
      finishedAt: row.finished_at,
      usedMs: row.used_ms,
      totalQuestions: row.total_questions,
      correctCount: row.correct_count,
      errorCount: row.error_count,
      passed: row.passed,
      finishReason: row.finish_reason,
      mode: examMode(row.exam_id),
    })),
    revision,
  };
}

function examMode(examId) {
  return String(examId || "").startsWith("revision-") ? "revision" : "simulation";
}

function buildRevisionProgress(rows) {
  const wrongByQuestion = new Map();
  let totalWrongAnswers = 0;

  rows.forEach((row) => {
    normalizeSavedAnswers(row.answers).forEach((answer) => {
      if (answer.isCorrect !== false || answer.questionId === null || answer.questionId === undefined) return;
      totalWrongAnswers += 1;
      const questionId = String(answer.questionId);
      if (wrongByQuestion.has(questionId)) return;
      wrongByQuestion.set(questionId, {
        questionId,
        topic: answer.topic || "",
        lastWrongAt: row.finished_at,
      });
    });
  });

  return {
    totalWrongAnswers,
    uniqueWrongQuestions: wrongByQuestion.size,
    questionIds: [...wrongByQuestion.keys()].slice(0, 120),
    topics: [...wrongByQuestion.values()].slice(0, 12),
  };
}

async function getExamResult(userId, examId) {
  const normalizedExamId = String(examId || "").trim();
  if (!normalizedExamId) {
    const error = new Error("Test mancante.");
    error.publicMessage = "Test non trovato.";
    error.statusCode = 404;
    throw error;
  }

  const url = new URL(`${RESULTS_TABLE}`, "https://example.test");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("exam_id", `eq.${normalizedExamId}`);
  url.searchParams.set(
    "select",
    "exam_id,started_at,finished_at,used_ms,total_questions,correct_count,error_count,passed,finish_reason,answers",
  );
  url.searchParams.set("limit", "1");

  const rows = await supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
  const row = rows[0];
  if (!row) {
    const error = new Error("Test non trovato.");
    error.publicMessage = "Test non trovato.";
    error.statusCode = 404;
    throw error;
  }

  return {
    examId: row.exam_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    usedMs: row.used_ms,
    totalQuestions: row.total_questions,
    correctCount: row.correct_count,
    errorCount: row.error_count,
    passed: row.passed,
    finishReason: row.finish_reason,
    answers: normalizeSavedAnswers(row.answers),
  };
}

async function getAdminDashboard() {
  const [users, loginCodes, sessions, results] = await Promise.all([
    selectRows(USERS_TABLE, {
      select: "id,email,created_at,updated_at",
      order: "created_at.desc",
      limit: "300",
    }),
    selectRows(CODES_TABLE, {
      select: "id,user_id,email,created_at,expires_at,consumed_at",
      order: "created_at.desc",
      limit: "300",
    }),
    selectRows(SESSIONS_TABLE, {
      select: "id,user_id,created_at,expires_at",
      order: "created_at.desc",
      limit: "300",
    }),
    selectRows(RESULTS_TABLE, {
      select:
        "id,user_id,exam_id,started_at,finished_at,used_ms,total_questions,correct_count,error_count,passed,finish_reason,answers,created_at",
      order: "finished_at.desc",
      limit: "300",
    }),
  ]);

  const now = Date.now();
  const usersById = new Map(users.map((user) => [user.id, user]));
  const statsByUser = new Map();
  const sessionsByUser = new Map();
  const loginsByUser = new Map();

  sessions.forEach((session) => {
    if (new Date(session.expires_at).getTime() <= now) return;
    sessionsByUser.set(session.user_id, (sessionsByUser.get(session.user_id) || 0) + 1);
  });

  loginCodes.forEach((code) => {
    const current = loginsByUser.get(code.user_id) || {
      requested: 0,
      completed: 0,
      lastLoginAt: null,
      lastRequestAt: null,
    };
    current.requested += 1;
    current.lastRequestAt = maxDate(current.lastRequestAt, code.created_at);
    if (code.consumed_at) {
      current.completed += 1;
      current.lastLoginAt = maxDate(current.lastLoginAt, code.consumed_at);
    }
    loginsByUser.set(code.user_id, current);
  });

  results.forEach((result) => {
    const current = statsByUser.get(result.user_id) || {
      totalTests: 0,
      passedTests: 0,
      errorSum: 0,
      correctSum: 0,
      lastTestAt: null,
    };
    current.totalTests += 1;
    current.passedTests += result.passed ? 1 : 0;
    current.errorSum += Number(result.error_count || 0);
    current.correctSum += Number(result.correct_count || 0);
    current.lastTestAt = maxDate(current.lastTestAt, result.finished_at);
    statsByUser.set(result.user_id, current);
  });

  const adminUsers = users.map((user) => {
    const stats = statsByUser.get(user.id) || {};
    const loginStats = loginsByUser.get(user.id) || {};
    return {
      id: user.id,
      email: user.email,
      createdAt: user.created_at,
      updatedAt: user.updated_at,
      lastLoginAt: loginStats.lastLoginAt || null,
      lastRequestAt: loginStats.lastRequestAt || null,
      loginRequests: loginStats.requested || 0,
      completedLogins: loginStats.completed || 0,
      activeSessions: sessionsByUser.get(user.id) || 0,
      totalTests: stats.totalTests || 0,
      passedTests: stats.passedTests || 0,
      averageErrors:
        stats.totalTests > 0 ? Number(((stats.errorSum || 0) / stats.totalTests).toFixed(2)) : 0,
      averageCorrect:
        stats.totalTests > 0 ? Number(((stats.correctSum || 0) / stats.totalTests).toFixed(2)) : 0,
      lastTestAt: stats.lastTestAt || null,
    };
  });

  const adminTests = results.map((result) => ({
    id: result.id,
    userId: result.user_id,
    userEmail: usersById.get(result.user_id)?.email || "utente sconosciuto",
    examId: result.exam_id,
    startedAt: result.started_at,
    finishedAt: result.finished_at,
    usedMs: result.used_ms,
    totalQuestions: result.total_questions,
    correctCount: result.correct_count,
    errorCount: result.error_count,
    passed: result.passed,
    finishReason: result.finish_reason,
    answers: normalizeAdminAnswers(result.answers),
  }));

  const activity = [
    ...users.map((user) => ({
      type: "signup",
      label: "Iscrizione",
      at: user.created_at,
      userId: user.id,
      email: user.email,
      detail: "Nuovo utente registrato",
    })),
    ...loginCodes.map((code) => ({
      type: code.consumed_at ? "login" : "login_code",
      label: code.consumed_at ? "Accesso" : "Codice richiesto",
      at: code.consumed_at || code.created_at,
      userId: code.user_id,
      email: code.email,
      detail: code.consumed_at ? "Codice usato" : loginCodeStatus(code),
    })),
    ...adminTests.map((test) => ({
      type: "test",
      label: "Test completato",
      at: test.finishedAt,
      userId: test.userId,
      email: test.userEmail,
      detail: `${test.errorCount} ${test.errorCount === 1 ? "errore" : "errori"} · ${formatServerDuration(test.usedMs)}`,
    })),
  ]
    .filter((item) => item.at)
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, 120);

  const totalTests = adminTests.length;
  const passedTests = adminTests.filter((test) => test.passed).length;
  const errorSum = adminTests.reduce((sum, test) => sum + Number(test.errorCount || 0), 0);

  return {
    summary: {
      users: users.length,
      activeSessions: sessionsByUser.size,
      loginRequests: loginCodes.length,
      tests: totalTests,
      passedTests,
      averageErrors: totalTests > 0 ? Number((errorSum / totalTests).toFixed(2)) : 0,
    },
    users: adminUsers,
    activity,
    tests: adminTests,
  };
}

async function selectRows(table, params) {
  const url = new URL(table, "https://example.test");
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null) url.searchParams.set(key, value);
  });
  return supabaseFetch(`${url.pathname.slice(1)}${url.search}`);
}

function maxDate(current, candidate) {
  if (!candidate) return current || null;
  if (!current) return candidate;
  return new Date(candidate).getTime() > new Date(current).getTime() ? candidate : current;
}

function loginCodeStatus(code) {
  return new Date(code.expires_at).getTime() < Date.now() ? "Codice scaduto" : "Codice in attesa";
}

function formatServerDuration(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function normalizeAdminAnswers(answers) {
  return normalizeSavedAnswers(answers);
}

function normalizeSavedAnswers(answers) {
  if (!Array.isArray(answers)) return [];
  return answers.slice(0, 60).map((answer) => ({
    questionId: answer.questionId,
    topic: answer.topic,
    answer: normalizeBooleanOrNull(answer.answer),
    correctAnswer: normalizeBooleanOrNull(answer.correctAnswer),
    isCorrect: Boolean(answer.isCorrect),
  }));
}

function normalizeBooleanOrNull(value) {
  if (value === null || value === undefined) return null;
  return Boolean(value);
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
  authenticateAdminRequest,
  authenticateRequest,
  createLoginCode,
  destroySession,
  getAdminDashboard,
  getExamResult,
  getProgress,
  isAdminEmail,
  isValidEmail,
  normalizeEmail,
  publicError,
  readJson,
  saveExamResult,
  sendJson,
  sendLoginCode,
  verifyLoginCode,
  withAdminFlag,
};
