const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-plus-signing-secret";

const {
  PRODUCT_SLUG,
  issuePlusToken,
  requirePlusAccess,
  verifyPlusToken,
} = require("../lib/plus-access");

const user = { id: "user-123", email: "Driver@Example.com" };

test("issued access is active only for the matching account", () => {
  const paidAt = new Date().toISOString();
  const token = issuePlusToken({
    user,
    checkoutId: "checkout-123",
    paidAt,
  });

  const access = verifyPlusToken(token, user);
  assert.equal(access.active, true);
  assert.equal(access.product, PRODUCT_SLUG);
  assert.equal(access.checkoutId, "checkout-123");
  assert.equal(
    verifyPlusToken(token, { ...user, id: "someone-else" }).active,
    false,
  );
  assert.equal(
    verifyPlusToken(token, { ...user, email: "other@example.com" }).active,
    false,
  );
});

test("tampering invalidates the signed pass", () => {
  const token = issuePlusToken({
    user,
    checkoutId: "checkout-123",
    paidAt: new Date().toISOString(),
  });
  const [payload, signature] = token.split(".");
  const tampered = `${payload.slice(0, -1)}A.${signature}`;
  assert.equal(verifyPlusToken(tampered, user).active, false);
});

test("re-issuing a paid checkout cannot restart its 30-day clock", () => {
  const paidAt = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const first = issuePlusToken({ user, checkoutId: "checkout-123", paidAt });
  const replay = issuePlusToken({ user, checkoutId: "checkout-123", paidAt });
  assert.equal(
    verifyPlusToken(first, user).expiresAt,
    verifyPlusToken(replay, user).expiresAt,
  );
});

test("a durable entitlement can set an exact token expiry and source", () => {
  const paidAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const token = issuePlusToken({
    user,
    checkoutId: "manual:grant-123",
    paidAt,
    expiresAt,
    source: "manual_admin",
  });
  const access = verifyPlusToken(token, user);
  assert.equal(access.source, "manual_admin");
  assert.ok(
    Math.abs(
      new Date(access.expiresAt).getTime() - new Date(expiresAt).getTime(),
    ) < 1_000,
  );
  assert.throws(
    () =>
      issuePlusToken({
        user,
        checkoutId: "manual:invalid",
        paidAt,
        expiresAt: "not-a-date",
        source: "manual_admin",
      }),
    (error) => error.statusCode === 502,
  );
});

test("generation guard rejects a request without a pass", async () => {
  await assert.rejects(
    requirePlusAccess({ headers: {} }, user),
    (error) => error.statusCode === 402 && error.publicMessage.includes("Plus"),
  );
});

test("a signed pass is rejected after its durable entitlement is revoked", async () => {
  const paidAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const token = issuePlusToken({
    user,
    checkoutId: "checkout-revocable",
    paidAt,
  });
  let revokedAt = null;
  global.__quizPatenteDbQuery = async (sql) => {
    if (!sql.includes("select payload")) throw new Error("unexpected query");
    return [
      {
        payload: {
          version: 1,
          checkoutId: "checkout-revocable",
          paidAt,
          expiresAt,
          activationEmailedAt: null,
          revokedAt,
        },
      },
    ];
  };

  try {
    const access = await requirePlusAccess(
      { headers: { "x-quizpatente-plus": token } },
      user,
    );
    assert.equal(access.active, true);

    revokedAt = new Date().toISOString();
    await assert.rejects(
      requirePlusAccess({ headers: { "x-quizpatente-plus": token } }, user),
      (error) => error.statusCode === 402,
    );
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("a valid signed pass can rely on a separate active manual entitlement", async () => {
  const paidAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.now() + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const token = issuePlusToken({
    user,
    checkoutId: "checkout-previous",
    paidAt,
  });
  global.__quizPatenteDbQuery = async (sql, params) => {
    if (!sql.includes("select payload")) throw new Error("unexpected query");
    if (params[0] === "quizpatente-plus-entitlements") {
      return [
        {
          payload: {
            version: 1,
            checkoutId: "checkout-previous",
            paidAt,
            expiresAt,
            revokedAt: new Date().toISOString(),
          },
        },
      ];
    }
    if (params[0] === "quizpatente-plus-admin-grants") {
      return [
        {
          payload: {
            version: 1,
            status: "granted",
            requestId: "33333333-3333-4333-8333-333333333333",
            grantId: "manual:33333333-3333-4333-8333-333333333333",
            source: "manual_admin",
            targetUserId: user.id,
            grantedByUserId: "admin-user",
            durationDays: 30,
            validFrom: paidAt,
            expiresAt,
            createdAt: paidAt,
          },
        },
      ];
    }
    throw new Error("unexpected namespace");
  };

  try {
    const access = await requirePlusAccess(
      { headers: { "x-quizpatente-plus": token } },
      user,
    );
    assert.equal(access.active, true);
    assert.equal(access.source, "manual_admin");
    assert.match(access.checkoutId, /^manual:/);
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});
