const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-usage-secret";

test("Plus generation atomically claims burst, daily, and generation slots", async () => {
  const requests = [];
  global.__quizPatenteDbQuery = async (sql, params) => {
    requests.push({ sql, key: params[1] });
    if (sql.includes("insert into app_kv_objects")) return [{ object_key: params[1] }];
    if (sql.includes("delete from app_kv_objects")) return [];
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const { DAILY_LIMIT, consumePlusGeneration } = require("../lib/plus-usage");
    const user = { id: "usage-user", email: "usage@example.com" };
    const first = await consumePlusGeneration(user, "translation", "question:42:en");
    assert.equal(first.limit, DAILY_LIMIT);
    assert.equal(first.remaining, DAILY_LIMIT - 1);
    assert.equal(requests.some(({ key }) => key.includes("burst/")), true);
    assert.equal(requests.some(({ key }) => key.includes("daily/")), true);
    assert.equal(requests.some(({ key }) => key.includes("locks/")), true);
    await first.release();
    assert.equal(requests.some(({ sql }) => sql.includes("delete from")), true);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("distributed burst claims fail closed when every slot already exists", async () => {
  global.__quizPatenteDbQuery = async () => [];

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
    delete global.__quizPatenteDbQuery;
  }
});
