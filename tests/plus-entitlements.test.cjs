const test = require("node:test");
const assert = require("node:assert/strict");

process.env.APP_SECRET = "test-only-entitlement-secret";

test("paid access is durably recoverable by the same authenticated account", async () => {
  let stored = null;
  let manualStored = null;
  global.__quizPatenteDbQuery = async (sql, params) => {
    if (
      sql.includes("select payload") &&
      params?.[0] === "quizpatente-plus-admin-grants"
    ) {
      return manualStored ? [{ payload: manualStored }] : [];
    }
    if (sql.includes("select payload"))
      return stored ? [{ payload: stored }] : [];
    if (sql.includes("insert into app_kv_objects")) {
      stored = JSON.parse(params[2]);
      return [{ payload: stored }];
    }
    if (sql.includes("'activationEmailClaimId', $4::text")) {
      if (stored?.checkoutId === params[2]) {
        stored.activationEmailClaimId = params[3];
        stored.activationEmailClaimedAt = params[4];
        stored.updatedAt = params[4];
        return [{ payload: stored }];
      }
      return [];
    }
    if (sql.includes("'activationEmailedAt', $5::text")) {
      if (
        stored?.checkoutId === params[2] &&
        stored.activationEmailClaimId === params[3]
      ) {
        stored.activationEmailedAt = params[4];
        delete stored.activationEmailClaimId;
        delete stored.activationEmailClaimedAt;
      }
      return [];
    }
    if (sql.includes("'revokedAt', $4::text")) {
      if (stored?.checkoutId === params[2]) {
        stored.revokedAt = params[3];
        stored.revocationReason = params[4];
        stored.revocationEventId = params[5];
        return [{ payload: stored }];
      }
      return [];
    }
    if (sql.includes("'restoredAt', $4::text")) {
      if (
        stored?.checkoutId === params[2] &&
        stored.revocationReason === "charge.dispute.created"
      ) {
        delete stored.revokedAt;
        delete stored.revocationReason;
        delete stored.revocationEventId;
        stored.restoredAt = params[3];
        stored.restorationEventId = params[4];
        return [{ payload: stored }];
      }
      return [];
    }
    throw new Error(`Unexpected query: ${sql}`);
  };

  try {
    const {
      claimEntitlementEmail,
      loadPlusEntitlement,
      markEntitlementEmailed,
      restorePlusEntitlement,
      revokePlusEntitlement,
      savePlusEntitlement,
    } = require("../lib/plus-entitlements");
    const user = { id: "paid-user", email: "paid@example.com" };
    const paidAt = new Date().toISOString();
    const expiresAt = new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000,
    ).toISOString();

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

    const claimId = await claimEntitlementEmail(user, recovered);
    assert.ok(claimId);
    await markEntitlementEmailed(user, recovered, claimId);
    assert.ok(stored.activationEmailedAt);

    const revoked = await revokePlusEntitlement(user, {
      checkoutId: "checkout-123",
      reason: "charge.dispute.created",
      eventId: "evt_dispute_123",
    });
    assert.equal(revoked.active, false);
    assert.equal(revoked.revocationReason, "charge.dispute.created");

    const restored = await restorePlusEntitlement(user, {
      checkoutId: "checkout-123",
      eventId: "evt_dispute_closed_123",
    });
    assert.equal(restored.active, true);

    const refunded = await revokePlusEntitlement(user, {
      checkoutId: "checkout-123",
      reason: "charge.refunded",
      eventId: "evt_refund_123",
    });
    assert.equal(refunded.active, false);
    assert.equal(refunded.revocationReason, "charge.refunded");
    const refundRestore = await restorePlusEntitlement(user, {
      checkoutId: "checkout-123",
      eventId: "evt_dispute_closed_456",
    });
    assert.equal(refundRestore, null);

    manualStored = {
      version: 1,
      status: "granted",
      requestId: "55555555-5555-4555-8555-555555555555",
      grantId: "manual:55555555-5555-4555-8555-555555555555",
      source: "manual_admin",
      targetUserId: user.id,
      grantedByUserId: "admin-user",
      durationDays: 30,
      validFrom: paidAt,
      expiresAt,
      createdAt: paidAt,
    };
    const effectiveAfterRefund = await loadPlusEntitlement(user);
    assert.equal(effectiveAfterRefund.active, true);
    assert.equal(effectiveAfterRefund.source, "manual_admin");
  } finally {
    delete global.__quizPatenteDbQuery;
  }
});

test("an active manual grant survives a revoked or shorter Stripe entitlement", () => {
  const { selectEffectiveEntitlement } = require("../lib/plus-entitlements");
  const manual = {
    active: true,
    source: "manual_admin",
    checkoutId: "manual:grant-id",
    expiresAt: new Date(Date.now() + 20_000).toISOString(),
  };
  const revokedStripe = {
    active: false,
    source: "stripe",
    checkoutId: "cs_paid",
    expiresAt: new Date(Date.now() + 40_000).toISOString(),
    revokedAt: new Date().toISOString(),
  };
  assert.equal(
    selectEffectiveEntitlement(revokedStripe, manual).source,
    "manual_admin",
  );

  const shorterStripe = {
    ...revokedStripe,
    active: true,
    revokedAt: null,
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
  };
  assert.equal(
    selectEffectiveEntitlement(shorterStripe, manual).source,
    "manual_admin",
  );
});
