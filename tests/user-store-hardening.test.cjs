const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-user-store-secret";

const {
  createLoginCode,
  normalizeExamResult,
  verifyLoginCode,
} = require("../lib/user-store");
const { getQuestion } = require("../lib/question-bank");

test("requesting a new OTP invalidates previous active codes before inserting it", async () => {
  const operations = [];
  global.__quizPatenteDbQuery = async (sql, params) => {
    if (sql.includes("insert into app_users")) {
      operations.push("user");
      return [{ id: "user-123", email: "driver@example.com" }];
    }
    if (sql.includes("with consumed as")) {
      operations.push("invalidate");
      operations.push("insert");
      assert.equal(params[2], "user-123");
      assert.equal(params[1], "driver@example.com");
      assert.equal(typeof params[3], "string");
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const result = await createLoginCode("driver@example.com");
    assert.match(result.code, /^\d{6}$/);
    assert.deepEqual(operations, ["user", "invalidate", "insert"]);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("OTP consumption is conditional and a lost race cannot create a session", async () => {
  let sessionCreated = false;
  global.__quizPatenteDbQuery = async (sql) => {
    if (sql.includes("update app_login_codes")) return [];
    if (sql.includes("insert into app_sessions")) {
      sessionCreated = true;
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    await assert.rejects(
      () => verifyLoginCode("driver@example.com", "123456"),
      (error) => error.statusCode === 401,
    );
    assert.equal(sessionCreated, false);
  } finally {
    delete global.__quizPatenteDbQuery;
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
