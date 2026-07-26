const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-request-limit-secret";

const {
  BUCKET,
  consumeRateLimits,
  enforceAuthRequestLimit,
  enforceAuthVerifyLimit,
  enforceExamResultWriteLimit,
  enforceExplanationReportLimit,
} = require("../lib/request-limits");

test("auth limits use durable atomic slots without exposing email or IP", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    requests.push({ value, options });
    if (value.endsWith(`/storage/v1/bucket/${BUCKET}`)) {
      return new Response("{}", { status: 200 });
    }
    if (value.includes(`/storage/v1/object/${BUCKET}/`) && options.method === "POST") {
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  try {
    await enforceAuthRequestLimit(
      { headers: { "x-forwarded-for": "203.0.113.4, 10.0.0.1" } },
      "driver@example.com",
      new Date("2026-07-26T10:15:00.000Z"),
    );
    const claims = requests.filter(({ value }) => value.includes("/storage/v1/object/"));
    assert.equal(claims.length, 4);
    assert.equal(claims.every(({ options }) => options.headers["x-upsert"] === "false"), true);
    assert.equal(claims.some(({ value }) => value.includes("driver%40example.com")), false);
    assert.equal(claims.some(({ value }) => value.includes("203.0.113.4")), false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("a distributed limit fails closed after every unique slot is claimed", async () => {
  const originalFetch = global.fetch;
  let claims = 0;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes(`/storage/v1/object/${BUCKET}/`) && options.method === "POST") {
      claims += 1;
      return new Response("The resource already exists", { status: 409 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

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
    global.fetch = originalFetch;
  }
});

test("OTP verification and exam saves consume their per-account durable caps", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes(`/storage/v1/object/${BUCKET}/`) && options.method === "POST") {
      requests.push(value);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request: ${value}`);
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
    global.fetch = originalFetch;
  }
});

test("the same account cannot report the same question and reason twice per day", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("report-user-question-day") && options.method === "POST") {
      return new Response("The resource already exists", { status: 409 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

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
    global.fetch = originalFetch;
  }
});

test("storage errors stop the protected action instead of resetting the counter", async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response("storage unavailable", { status: 500 });
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
    global.fetch = originalFetch;
  }
});
