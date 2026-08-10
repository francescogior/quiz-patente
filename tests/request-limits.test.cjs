const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-request-limit-secret";

const {
  BUCKET,
  consumeRateLimits,
  enforceAuthRequestLimit,
  enforceAuthVerifyLimit,
  enforceExamResultWriteLimit,
  enforceExplanationReportLimit,
} = require("../lib/request-limits");

test("auth limits use durable atomic slots without exposing email or IP", async () => {
  const requests = [];
  global.__quizPatenteDbQuery = async (sql, params) => {
    requests.push({ sql, namespace: params[0], key: params[1] });
    return [{ object_key: params[1] }];
  };

  try {
    await enforceAuthRequestLimit(
      { headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" } },
      "driver@example.com",
      new Date("2026-07-26T10:15:00.000Z"),
    );
    const claims = requests.filter(({ sql }) => sql.includes("insert into app_kv_objects"));
    assert.equal(claims.length, 4);
    assert.equal(claims.every(({ namespace }) => namespace === BUCKET), true);
    assert.equal(claims.some(({ key }) => key.includes("driver@example.com")), false);
    assert.equal(claims.some(({ key }) => key.includes("203.0.113.4")), false);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("a distributed limit fails closed after every unique slot is claimed", async () => {
  let claims = 0;
  global.__quizPatenteDbQuery = async () => { claims += 1; return []; };

  try {
    await assert.rejects(
      () =>
        consumeRateLimits(
          [
            {
              namespace: "test-user-minute",
              identity: "user-123",
              limit: 2,
              windowSeconds: 60,
            },
          ],
          new Date("2026-07-26T10:15:00.000Z"),
          "Attendi.",
        ),
      (error) => error.statusCode === 429 && error.publicMessage === "Attendi.",
    );
    assert.equal(claims, 2);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("OTP verification and exam saves consume their per-account durable caps", async () => {
  const requests = [];
  global.__quizPatenteDbQuery = async (_sql, params) => {
    requests.push(params[1]);
    return [{ object_key: params[1] }];
  };

  try {
    const now = new Date("2026-07-26T10:15:00.000Z");
    await enforceAuthVerifyLimit(
      { headers: { "x-forwarded-for": "203.0.113.8" } },
      "driver@example.com",
      now,
    );
    await enforceExamResultWriteLimit({ id: "user-123" }, now);
    assert.equal(requests.length, 7);
    assert.equal(requests.some((value) => value.includes("auth-verify-email-10m")), true);
    assert.equal(requests.some((value) => value.includes("exam-write-user-minute")), true);
    assert.equal(requests.some((value) => value.includes("exam-write-user-day")), true);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("the same account cannot report the same question and reason twice per day", async () => {
  global.__quizPatenteDbQuery = async () => [];

  try {
    await assert.rejects(
      () =>
        enforceExplanationReportLimit(
          { id: "user-123" },
          31059,
          "wrong",
          new Date("2026-07-26T10:15:00.000Z"),
        ),
      (error) =>
        error.statusCode === 429 &&
        error.publicMessage === "Hai già inviato questa segnalazione oggi.",
    );
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("storage errors stop the protected action instead of resetting the counter", async () => {
  global.__quizPatenteDbQuery = async () => { throw new Error("database unavailable"); };
  try {
    await assert.rejects(
      () =>
        consumeRateLimits(
          [
            {
              namespace: "test-storage-failure",
              identity: "user-456",
              limit: 1,
              windowSeconds: 60,
            },
          ],
          new Date(),
        ),
      (error) => error.statusCode === 503,
    );
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});
