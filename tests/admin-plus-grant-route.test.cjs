const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const targetUser = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "driver@example.com",
};
const adminUser = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  email: "admin@example.com",
};
const requestId = "22222222-2222-4222-8222-222222222222";

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

function request(body, headers = {}) {
  return {
    method: "POST",
    body,
    headers: {
      origin: "https://quizpatente.realb.it",
      host: "quizpatente.realb.it",
      "x-forwarded-proto": "https",
      ...headers,
    },
  };
}

function response() {
  return {
    headers: {},
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };
}

test("admin Plus grant route enforces admin, origin and a strict bounded body", async () => {
  let authError = null;
  let targetExists = true;
  let authCalls = 0;
  let grantCalls = 0;
  const restoreUserStore = installStub("lib/user-store.js", {
    async authenticateAdminRequest() {
      authCalls += 1;
      if (authError) throw authError;
      return { user: adminUser };
    },
    async findUserById() {
      return targetExists ? targetUser : null;
    },
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
    loadPlusEntitlement: async () => null,
  });
  const restoreGrants = installStub("lib/plus-admin-grants.js", {
    async grantManualPlus(options) {
      grantCalls += 1;
      assert.equal(options.targetUser.id, targetUser.id);
      assert.equal(options.adminUser.id, adminUser.id);
      assert.equal(options.requestId, requestId);
      assert.equal(typeof options.loadCurrentEntitlement, "function");
      return {
        granted: true,
        replayed: false,
        reason: "granted",
        entitlement: {
          active: true,
          source: "manual_admin",
          checkoutId: `manual:${requestId}`,
          grantedByUserId: adminUser.id,
          expiresAt: "2026-09-09T10:00:00.000Z",
        },
      };
    },
  });
  const routePath = require.resolve(path.join(root, "api/admin-plus-grant.js"));
  delete require.cache[routePath];

  try {
    const handler = require(routePath);
    const success = response();
    await handler(request({ userId: targetUser.id, requestId }), success);
    assert.equal(success.statusCode, 200);
    assert.equal(success.headers["cache-control"], "private, no-store");
    assert.deepEqual(success.payload, {
      grant: {
        granted: true,
        replayed: false,
        reason: "granted",
        userId: targetUser.id,
        access: {
          active: true,
          source: "manual_admin",
          expiresAt: "2026-09-09T10:00:00.000Z",
        },
      },
    });
    assert.doesNotMatch(
      JSON.stringify(success.payload),
      /checkoutId|grantedBy/,
    );

    const authCallsBeforeOrigin = authCalls;
    const crossOrigin = response();
    await handler(
      request(
        { userId: targetUser.id, requestId },
        { origin: "https://attacker.example" },
      ),
      crossOrigin,
    );
    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(authCalls, authCallsBeforeOrigin);

    authError = Object.assign(new Error("forbidden"), {
      publicMessage: "Accesso admin richiesto.",
      statusCode: 403,
    });
    const notAdmin = response();
    await handler(request({ userId: targetUser.id, requestId }), notAdmin);
    assert.equal(notAdmin.statusCode, 403);
    authError = null;

    const unknownField = response();
    await handler(
      request({ userId: targetUser.id, requestId, durationDays: 365 }),
      unknownField,
    );
    assert.equal(unknownField.statusCode, 400);

    const invalidId = response();
    await handler(
      request({ userId: "driver@example.com", requestId }),
      invalidId,
    );
    assert.equal(invalidId.statusCode, 400);

    const tooLarge = response();
    await handler(
      request(
        { userId: targetUser.id, requestId },
        { "content-length": "2049" },
      ),
      tooLarge,
    );
    assert.equal(tooLarge.statusCode, 413);

    targetExists = false;
    const missing = response();
    await handler(request({ userId: targetUser.id, requestId }), missing);
    assert.equal(missing.statusCode, 404);
    targetExists = true;

    const wrongMethod = response();
    await handler(
      {
        ...request({ userId: targetUser.id, requestId }),
        method: "GET",
      },
      wrongMethod,
    );
    assert.equal(wrongMethod.statusCode, 405);
    assert.equal(grantCalls, 1);
  } finally {
    delete require.cache[routePath];
    restoreGrants();
    restoreEntitlements();
    restoreUserStore();
  }
});
