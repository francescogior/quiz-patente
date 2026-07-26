const test = require("node:test");
const assert = require("node:assert/strict");

process.env.SUPABASE_URL = "https://project.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-only-entitlement-secret";

test("paid access is durably recoverable by the same authenticated account", async () => {
  const originalFetch = global.fetch;
  let stored = null;
  global.fetch = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/storage/v1/bucket/quizpatente-plus-entitlements")) {
      return new Response("{}", { status: 200 });
    }
    if (value.includes("/object/authenticated/")) {
      return stored
        ? Response.json(stored)
        : new Response("", { status: 404 });
    }
    if (value.includes("/storage/v1/object/") && options.method === "POST") {
      stored = JSON.parse(options.body);
      return new Response("{}", { status: 200 });
    }
    throw new Error(`Unexpected request: ${value}`);
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
    global.fetch = originalFetch;
  }
});
