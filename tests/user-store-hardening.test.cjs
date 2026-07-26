const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-user-store-secret";

const {
  createLoginCode,
  normalizeExamResult,
  verifyLoginCode,
} = require("../lib/user-store");
const { getQuestion } = require("../lib/question-bank");

test("requesting a new OTP invalidates previous active codes before inserting it", async () => {
  const originalFetch = global.fetch;
  const operations = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("/rest/v1/app_users")) {
      operations.push("user");
      return Response.json([{ id: "user-123", email: "driver@example.com" }]);
    }
    if (value.includes("/rest/v1/app_login_codes") && options.method === "PATCH") {
      operations.push("invalidate");
      assert.match(value, /consumed_at=is\.null/);
      const payload = JSON.parse(options.body);
      assert.ok(payload.consumed_at);
      return new Response(null, { status: 204 });
    }
    if (value.endsWith("/rest/v1/app_login_codes") && options.method === "POST") {
      operations.push("insert");
      const payload = JSON.parse(options.body);
      assert.equal(payload.user_id, "user-123");
      assert.equal(payload.email, "driver@example.com");
      assert.equal(typeof payload.code_hash, "string");
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  try {
    const result = await createLoginCode("driver@example.com");
    assert.match(result.code, /^\d{6}$/);
    assert.deepEqual(operations, ["user", "invalidate", "insert"]);
  } finally {
    global.fetch = originalFetch;
  }
});

test("OTP consumption is conditional and a lost race cannot create a session", async () => {
  const originalFetch = global.fetch;
  let sessionCreated = false;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("/rest/v1/app_login_codes") && !options.method) {
      return Response.json([{ id: "code-123", user_id: "user-123" }]);
    }
    if (value.includes("/rest/v1/app_login_codes") && options.method === "PATCH") {
      assert.match(value, /consumed_at=is\.null/);
      assert.match(value, /expires_at=gt\./);
      assert.equal(options.headers.Prefer, "return=representation");
      return Response.json([]);
    }
    if (value.includes("/rest/v1/app_sessions")) {
      sessionCreated = true;
      return Response.json([]);
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  try {
    await assert.rejects(
      () => verifyLoginCode("driver@example.com", "123456"),
      (error) => error.statusCode === 401,
    );
    assert.equal(sessionCreated, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("exam results are rebuilt from canonical question data", () => {
  const question = getQuestion(31059);
  assert.ok(question);
  const finishedAt = new Date(Date.now() - 1_000).toISOString();
  const startedAt = new Date(new Date(finishedAt).getTime() - 12_000).toISOString();
  const payload = {
    examId: "revision-018f8c2a-4b81-7e92-a012-456789abcdef",
    startedAt,
    finishedAt,
    usedMs: 12_000,
    totalQuestions: 1,
    correctCount: 1,
    errorCount: 0,
    passed: true,
    finishReason: "manual",
    answers: [
      {
        questionId: question.id,
        topic: question.topic,
        answer: question.correct,
        correctAnswer: question.correct,
        isCorrect: true,
      },
    ],
  };

  const result = normalizeExamResult("user-123", payload);
  assert.equal(result.exam_id, payload.examId);
  assert.equal(result.answers[0].topic, question.topic);
  assert.equal(result.answers[0].correctAnswer, question.correct);
  assert.equal(result.correct_count, 1);
  assert.equal(result.error_count, 0);
});

test("exam result validation rejects forged metadata and scores", () => {
  const question = getQuestion(31059);
  const finishedAt = new Date(Date.now() - 1_000).toISOString();
  const startedAt = new Date(new Date(finishedAt).getTime() - 12_000).toISOString();
  const base = {
    examId: "revision-018f8c2a-4b81-7e92-a012-456789abcdef",
    startedAt,
    finishedAt,
    usedMs: 12_000,
    totalQuestions: 1,
    correctCount: 1,
    errorCount: 0,
    passed: true,
    finishReason: "manual",
    answers: [
      {
        questionId: question.id,
        topic: question.topic,
        answer: question.correct,
        correctAnswer: question.correct,
        isCorrect: true,
      },
    ],
  };

  assert.throws(
    () =>
      normalizeExamResult("user-123", {
        ...base,
        answers: [{ ...base.answers[0], topic: "Argomento inventato" }],
      }),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => normalizeExamResult("user-123", { ...base, correctCount: 0, errorCount: 1 }),
    (error) => error.statusCode === 400,
  );
  assert.throws(
    () => normalizeExamResult("user-123", { ...base, examId: "attacker-controlled-id" }),
    (error) => error.statusCode === 400,
  );
});
