const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-usage-secret";

test("Plus generation atomically claims burst, daily, and generation slots", async () => {
  const originalFetch = global.fetch;
  const requests = [];
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    requests.push({ value, method: options.method || "GET" });
    if (value.endsWith("/storage/v1/bucket/quizpatente-plus-usage")) {
      return new Response("{}", { status: 200 });
    }
    if (value.includes("/storage/v1/object/") && options.method === "POST") {
      return new Response("{}", { status: 200 });
    }
    if (
      value.endsWith("/storage/v1/object/quizpatente-plus-usage") &&
      options.method === "DELETE"
    ) {
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  try {
    const { DAILY_LIMIT, consumePlusGeneration } = require("../lib/plus-usage");
    const user = { id: "usage-user", email: "usage@example.com" };
    const first = await consumePlusGeneration(user, "translation", "question:42:en");
    assert.equal(first.limit, DAILY_LIMIT);
    assert.equal(first.remaining, DAILY_LIMIT - 1);
    assert.equal(requests.some(({ value }) => value.includes("/burst/")), true);
    assert.equal(requests.some(({ value }) => value.includes("/daily/")), true);
    assert.equal(requests.some(({ value }) => value.includes("/locks/")), true);
    await first.release();
    assert.equal(requests.some(({ method }) => method === "DELETE"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("distributed burst claims fail closed when every slot already exists", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.includes("/burst/") && options.method === "POST") {
      return new Response("The resource already exists", { status: 409 });
    }
    throw new Error(`Unexpected request: ${value}`);
  };

  try {
    const { consumePlusGeneration } = require("../lib/plus-usage");
    await assert.rejects(
      () =>
        consumePlusGeneration(
          { id: "blocked-user", email: "blocked@example.com" },
          "explanation",
          "question:77",
        ),
      (error) => error.statusCode === 429,
    );
  } finally {
    global.fetch = originalFetch;
  }
});
