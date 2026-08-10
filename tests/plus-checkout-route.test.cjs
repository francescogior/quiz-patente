const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function installStub(relativePath, exports) {
  const filename = require.resolve(path.join(root, relativePath));
  const previous = require.cache[filename];
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  };
}

test("an active Plus account cannot create a second checkout", async () => {
  let active = true;
  let checkoutCreates = 0;
  const restoreUserStore = installStub("lib/user-store.js", {
    authenticateRequest: async () => ({
      user: { id: "paid-user", email: "paid@example.com" },
    }),
    publicError(error, fallback) {
      return {
        statusCode: error.statusCode || 500,
        payload: { error: error.publicMessage || fallback },
      };
    },
    readJson: async (req) => req.body,
    sendJson(res, statusCode, payload) {
      res.statusCode = statusCode;
      res.payload = payload;
    },
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    loadPlusEntitlement: async () => ({ active }),
  });
  const restoreStripe = installStub("lib/stripe-checkout.js", {
    createPlusCheckoutSession: async () => {
      checkoutCreates += 1;
      return {
        id: "cs_test_route123456",
        url: "https://checkout.stripe.com/c/pay/test",
      };
    },
  });
  const routePath = require.resolve(path.join(root, "api/plus-checkout.js"));
  delete require.cache[routePath];

  try {
    const handler = require(routePath);
    const first = {};
    await handler(
      {
        method: "POST",
        body: {
          immediateAccessConsent: true,
          attemptId: "attempt_route_123456",
        },
      },
      first,
    );
    assert.equal(first.statusCode, 409);
    assert.equal(checkoutCreates, 0);

    active = false;
    const second = {};
    await handler(
      {
        method: "POST",
        body: {
          immediateAccessConsent: true,
          attemptId: "attempt_route_123456",
        },
      },
      second,
    );
    assert.equal(second.statusCode, 200);
    assert.equal(checkoutCreates, 1);
  } finally {
    delete require.cache[routePath];
    restoreStripe();
    restoreEntitlements();
    restoreUserStore();
  }
});
