const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
process.env.APP_SECRET = "test-only-manual-status-secret";

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

test("a manual grant is recovered as a signed Plus token and passes the API guard", async () => {
  const user = {
    id: "11111111-1111-4111-8111-111111111111",
    email: "manual@example.com",
  };
  const validFrom = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const entitlement = {
    active: true,
    source: "manual_admin",
    checkoutId: "manual:22222222-2222-4222-8222-222222222222",
    paidAt: validFrom,
    expiresAt,
  };
  const restoreUsers = installStub("lib/user-store.js", {
    authenticateRequest: async () => ({ user }),
    publicError(error, fallback) {
      return {
        statusCode: error.statusCode || 500,
        payload: { error: error.publicMessage || fallback },
      };
    },
    sendJson(res, statusCode, payload) {
      res.statusCode = statusCode;
      res.payload = payload;
    },
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    loadPlusEntitlement: async () => entitlement,
  });
  const routePath = require.resolve(path.join(root, "api/plus-status.js"));
  delete require.cache[routePath];

  try {
    const handler = require(routePath);
    const response = {
      headers: {},
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
    };
    await handler({ method: "GET", headers: {} }, response);
    assert.equal(response.statusCode, 200);
    assert.equal(response.payload.access.active, true);
    assert.equal(response.payload.access.source, "manual_admin");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.ok(response.payload.token);
    assert.ok(
      Math.abs(
        new Date(response.payload.access.expiresAt).getTime() -
          new Date(expiresAt).getTime(),
      ) < 1_000,
    );

    const { requirePlusAccess } = require("../lib/plus-access");
    const access = await requirePlusAccess(
      {
        headers: { "x-quizpatente-plus": response.payload.token },
      },
      user,
    );
    assert.equal(access.source, "manual_admin");
    assert.equal(access.checkoutId, entitlement.checkoutId);
  } finally {
    delete require.cache[routePath];
    restoreEntitlements();
    restoreUsers();
  }
});
