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
  assert.equal(verifyPlusToken(token, { ...user, id: "someone-else" }).active, false);
  assert.equal(verifyPlusToken(token, { ...user, email: "other@example.com" }).active, false);
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
  assert.equal(verifyPlusToken(first, user).expiresAt, verifyPlusToken(replay, user).expiresAt);
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
      requirePlusAccess(
        { headers: { "x-quizpatente-plus": token } },
        user,
      ),
      (error) => error.statusCode === 402,
    );
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});
