const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-entitlement-secret";

test("paid access is durably recoverable by the same authenticated account", async () => {
  let stored = null;
  global.__quizPatenteDbQuery = async (sql, params) => {
    if (sql.includes("select payload")) return stored ? [{ payload: stored }] : [];
    if (sql.includes("insert into app_kv_objects")) {
      stored = JSON.parse(params[2]);
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const {
      loadPlusEntitlement,
      markEntitlementEmailed,
      savePlusEntitlement,
    } = require("../lib/plus-entitlements");
    const user = { id: "paid-user", email: "paid@example.com" };
    const paidAt = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    const saved = await savePlusEntitlement(user, {
      checkoutId: "checkout-123",
      paidAt,
      expiresAt,
    });
    assert.equal(saved.checkoutId, "checkout-123");
    assert.equal(saved.activationEmailedAt, null);

    const recovered = await loadPlusEntitlement(user);
    assert.equal(recovered.active, true);
    assert.equal(recovered.checkoutId, "checkout-123");

    await markEntitlementEmailed(user, recovered);
    assert.ok(stored.activationEmailedAt);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});
