const crypto = require("node:crypto");
const { getQuestion, getQuestionBankSettings } = require("./question-bank");
const { enforceExamResultWriteLimit } = require("./request-limits");
const { query } = require("./db");

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
  const normalized = String(email || "");
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized);
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

function codeHash(email, code) {
  return crypto
    .createHmac("sha256", requireEnv("APP_SECRET"))
    .update(`code:${email}:${code}`)
    .digest("hex");
}

function tokenHash(token) {
  return crypto
    .createHmac("sha256", requireEnv("APP_SECRET"))
    .update(`session:${token}`)
    .digest("hex");
}

function randomCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

async function getOrCreateUser(email) {
  const rows = await query(
    `insert into ${USERS_TABLE} (email, updated_at)
     values ($1, now())
     on conflict (email) do update set updated_at = excluded.updated_at
     returning *`,
    [email],
  );
  return rows[0];
}

async function createLoginCode(email) {
  const user = await getOrCreateUser(email);
  const code = randomCode();
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + CODE_MINUTES * 60 * 1000).toISOString();

  await query(
    `with consumed as (
       update ${CODES_TABLE}
          set consumed_at = $1
        where email = $2 and consumed_at is null
     )
     insert into ${CODES_TABLE} (user_id, email, code_hash, expires_at)
     values ($3, $2, $4, $5)`,
    [now, email, user.id, codeHash(email, code), expiresAt],
  );

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
  const consumed = await query(
    `update ${CODES_TABLE}
        set consumed_at = now()
      where id = (
        select id from ${CODES_TABLE}
         where email = $1
           and code_hash = $2
           and consumed_at is null
           and expires_at > now()
         order by created_at desc
         limit 1
      )
        and consumed_at is null
        and expires_at > now()
      returning id, user_id`,
    [email, codeHash(email, code)],
  );
  if (!consumed?.[0]) throw invalidLoginCode();

  return createSession(consumed[0].user_id);
}

async function createSession(userId) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const rows = await query(
    `insert into ${SESSIONS_TABLE} (user_id, token_hash, expires_at)
     values ($1, $2, $3)
     returning *`,
    [userId, tokenHash(token), expiresAt],
  );

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

  const rows = await query(
    `select id, user_id, expires_at
       from ${SESSIONS_TABLE}
      where token_hash = $1 and expires_at > now()
      limit 1`,
    [tokenHash(token)],
  );
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
  await query(`delete from ${SESSIONS_TABLE} where token_hash = $1`, [tokenHash(token)]);
}

async function findUserById(userId) {
  const rows = await query(`select id, email from ${USERS_TABLE} where id = $1 limit 1`, [userId]);
  return rows[0] || null;
}

async function saveExamResult(user, payload) {
  if (!user?.id) throw serverValidationError("Utente non valido.");
  const row = normalizeExamResult(user.id, payload);
  await enforceExamResultWriteLimit(user);
  await query(
    `insert into ${RESULTS_TABLE} (
       user_id, exam_id, started_at, finished_at, used_ms, total_questions,
       correct_count, error_count, passed, finish_reason, answers, updated_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)
     on conflict (user_id, exam_id) do update set
       started_at = excluded.started_at,
       finished_at = excluded.finished_at,
       used_ms = excluded.used_ms,
       total_questions = excluded.total_questions,
       correct_count = excluded.correct_count,
       error_count = excluded.error_count,
       passed = excluded.passed,
       finish_reason = excluded.finish_reason,
       answers = excluded.answers,
       updated_at = excluded.updated_at`,
    [
      row.user_id,
      row.exam_id,
      row.started_at,
      row.finished_at,
      row.used_ms,
      row.total_questions,
      row.correct_count,
      row.error_count,
      row.passed,
      row.finish_reason,
      JSON.stringify(row.answers),
      row.updated_at,
    ],
  );
}

function normalizeExamResult(userId, payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw resultValidationError("Risultato non valido.");
  }

  const examId = normalizeExamId(payload.examId);
  const settings = getQuestionBankSettings();
  const totalQuestions = requireInteger(
    payload.totalQuestions,
    1,
    60,
    "Numero domande non valido.",
  );
  const isRevision = examId.startsWith("revision-");
  if (!isRevision && totalQuestions !== Number(settings.examQuestions || 30)) {
    throw resultValidationError("La simulazione non contiene il numero previsto di domande.");
  }
  if (!Array.isArray(payload.answers) || payload.answers.length !== totalQuestions) {
    throw resultValidationError("Le risposte non corrispondono alle domande del test.");
  }

  const seenQuestionIds = new Set();
  const answers = payload.answers.map((answer) => {
    if (!answer || typeof answer !== "object" || Array.isArray(answer)) {
      throw resultValidationError("Formato risposta non valido.");
    }
    const questionId = requireInteger(
      answer.questionId,
      1,
      Number.MAX_SAFE_INTEGER,
      "Domanda non valida.",
    );
    if (seenQuestionIds.has(questionId)) {
      throw resultValidationError("Una domanda è presente più di una volta.");
    }
    seenQuestionIds.add(questionId);

    const question = getQuestion(questionId);
    if (!question) throw resultValidationError("Domanda non presente nella banca dati.");
    if (answer.answer !== null && typeof answer.answer !== "boolean") {
      throw resultValidationError("Risposta selezionata non valida.");
    }
    if (typeof answer.correctAnswer !== "boolean" || answer.correctAnswer !== question.correct) {
      throw resultValidationError("Risposta corretta non coerente con la banca dati.");
    }
    if (String(answer.topic || "") !== String(question.topic || "")) {
      throw resultValidationError("Argomento non coerente con la banca dati.");
    }

    const isCorrect = answer.answer === question.correct;
    if (typeof answer.isCorrect !== "boolean" || answer.isCorrect !== isCorrect) {
      throw resultValidationError("Esito della risposta non valido.");
    }
    return {
      questionId: question.id,
      topic: question.topic,
      answer: answer.answer,
      correctAnswer: question.correct,
      isCorrect,
    };
  });

  const correctCount = answers.filter((answer) => answer.isCorrect).length;
  const errorCount = totalQuestions - correctCount;
  if (
    payload.correctCount !== correctCount ||
    payload.errorCount !== errorCount ||
    payload.correctCount + payload.errorCount !== totalQuestions
  ) {
    throw resultValidationError("Punteggio non coerente con le risposte.");
  }

  const expectedPassed = errorCount <= Number(settings.maxErrors || 3);
  if (typeof payload.passed !== "boolean" || payload.passed !== expectedPassed) {
    throw resultValidationError("Esito del test non coerente con il punteggio.");
  }
  if (!["manual", "timeout"].includes(payload.finishReason)) {
    throw resultValidationError("Motivo di chiusura non valido.");
  }

  const startedAt = requireIso(payload.startedAt, "Data di inizio non valida.");
  const finishedAt = requireIso(payload.finishedAt, "Data di fine non valida.");
  const elapsed = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  const usedMs = requireInteger(
    payload.usedMs,
    0,
    24 * 60 * 60 * 1000,
    "Durata non valida.",
  );
  if (elapsed < 0 || Math.abs(elapsed - usedMs) > 1_000) {
    throw resultValidationError("Durata non coerente con le date del test.");
  }
  if (new Date(finishedAt).getTime() > Date.now() + 5 * 60 * 1000) {
    throw resultValidationError("La data di fine non può essere nel futuro.");
  }

  return {
    user_id: userId,
    exam_id: examId,
    started_at: startedAt,
    finished_at: finishedAt,
    used_ms: usedMs,
    total_questions: totalQuestions,
    correct_count: correctCount,
    error_count: errorCount,
    passed: expectedPassed,
    finish_reason: payload.finishReason,
    answers,
    updated_at: new Date().toISOString(),
  };
}

async function getProgress(userId) {
  const rows = await query(
    `select exam_id, finished_at, used_ms, total_questions, correct_count,
            error_count, passed, finish_reason, answers
       from ${RESULTS_TABLE}
      where user_id = $1
      order by finished_at desc
      limit 50`,
    [userId],
  );
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
  let normalizedExamId;
  try {
    normalizedExamId = normalizeExamId(examId);
  } catch {
    const error = new Error("Test mancante.");
    error.publicMessage = "Test non trovato.";
    error.statusCode = 404;
    throw error;
  }

  const rows = await query(
    `select exam_id, started_at, finished_at, used_ms, total_questions,
            correct_count, error_count, passed, finish_reason, answers
       from ${RESULTS_TABLE}
      where user_id = $1 and exam_id = $2
      limit 1`,
    [userId, normalizedExamId],
  );
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
  const allowed = new Map([
    [USERS_TABLE, new Set(["id", "email", "created_at", "updated_at"])],
    [CODES_TABLE, new Set(["id", "user_id", "email", "created_at", "expires_at", "consumed_at"])],
    [SESSIONS_TABLE, new Set(["id", "user_id", "created_at", "expires_at"])],
    [
      RESULTS_TABLE,
      new Set([
        "id", "user_id", "exam_id", "started_at", "finished_at", "used_ms",
        "total_questions", "correct_count", "error_count", "passed", "finish_reason",
        "answers", "created_at",
      ]),
    ],
  ]);
  const columns = String(params.select || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const order = String(params.order || "created_at.desc").split(".");
  const limit = Math.min(300, Math.max(1, Number(params.limit || 300)));
  const valid = allowed.get(table);
  if (!valid || columns.some((column) => !valid.has(column)) || !valid.has(order[0])) {
    throw serverValidationError("Selezione admin non valida.");
  }
  const direction = order[1] === "asc" ? "asc" : "desc";
  return query(
    `select ${columns.join(", ")} from ${table} order by ${order[0]} ${direction} limit ${limit}`,
  );
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

function normalizeExamId(value) {
  const examId = String(value || "").trim();
  const uuid = "[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}";
  const timestamp = "[0-9]{10,16}";
  if (!new RegExp(`^(?:revision-)?(?:${uuid}|${timestamp})$`, "i").test(examId)) {
    throw resultValidationError("Identificativo test non valido.");
  }
  return examId;
}

function requireInteger(value, min, max, message) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw resultValidationError(message);
  }
  return value;
}

function requireIso(value, message) {
  if (typeof value !== "string" || value.length > 40) throw resultValidationError(message);
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== value) {
    throw resultValidationError(message);
  }
  return value;
}

function invalidLoginCode() {
  const error = new Error("Codice non valido.");
  error.publicMessage = "Codice non valido o scaduto.";
  error.statusCode = 401;
  return error;
}

function resultValidationError(message) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = 400;
  return error;
}

function serverValidationError(message) {
  const error = new Error(message);
  error.publicMessage = "Configurazione server incompleta.";
  error.statusCode = 500;
  return error;
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
  normalizeExamResult,
  publicError,
  readJson,
  saveExamResult,
  sendJson,
  sendLoginCode,
  verifyLoginCode,
  withAdminFlag,
};
