const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
process.env.APP_SECRET = "test-only-fulfillment-secret";

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

test("a refund tombstone prevents a later browser activation", async () => {
  let entitlementSaves = 0;
  const restoreKv = installStub("lib/db-kv.js", {
    listJsonByPrefix: async () => [],
    readJson: async (_bucket, objectKey) =>
      objectKey.startsWith("refunds/")
        ? {
            version: 1,
            paymentIntentId: "pi_refunded123456",
            active: true,
            reason: "charge.refunded",
            eventId: "evt_refunded123456",
            revokedAt: new Date().toISOString(),
          }
        : null,
    writeJson: async () => {},
    writeJsonIfNewer: async () => {},
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    claimEntitlementEmail: async () => null,
    loadPaidPlusEntitlement: async () => null,
    markEntitlementEmailed: async () => {},
    releaseEntitlementEmailClaim: async () => {},
    revokePlusEntitlement: async () => {},
    savePlusEntitlement: async () => {
      entitlementSaves += 1;
    },
  });
  const restorePaymentLock = installStub("lib/plus-payment-lock.js", {
    claimPlusPayment: async () => ({
      path: "payment-intents/pi_refunded123456.json",
      claimId: "claim-refunded",
    }),
    releasePlusPayment: async () => {},
  });
  const fulfillmentPath = require.resolve(
    path.join(root, "lib/plus-fulfillment.js"),
  );
  delete require.cache[fulfillmentPath];

  try {
    const { fulfillPlusCheckout } = require(fulfillmentPath);
    await assert.rejects(
      fulfillPlusCheckout(
        { id: "paid-user", email: "paid@example.com" },
        checkout({ paymentIntentId: "pi_refunded123456" }),
      ),
      (error) =>
        error.statusCode === 410 &&
        error.code === "PLUS_PAYMENT_PERMANENTLY_REVOKED",
    );
    assert.equal(entitlementSaves, 0);
  } finally {
    delete require.cache[fulfillmentPath];
    restorePaymentLock();
    restoreEntitlements();
    restoreKv();
  }
});

test("concurrent fulfillment sends one idempotent activation email", async () => {
  let emailClaims = 0;
  let emailMarks = 0;
  let emailReleases = 0;
  let emailRequests = 0;
  let emailHeaders = null;
  let paymentClaims = 0;
  const previousFetch = global.fetch;
  const previousApiKey = process.env.RESEND_API_KEY;
  const previousFrom = process.env.EMAIL_FROM;
  process.env.RESEND_API_KEY = "re_test_fulfillment";
  process.env.EMAIL_FROM = "Quiz Patente <quizpatente@realb.it>";
  global.fetch = async (_url, options) => {
    emailRequests += 1;
    emailHeaders = options.headers;
    return { ok: true };
  };
  const paidAt = new Date().toISOString();
  const expiresAt = new Date(
    Date.parse(paidAt) + 30 * 24 * 60 * 60 * 1000,
  ).toISOString();
  const restoreKv = installStub("lib/db-kv.js", {
    listJsonByPrefix: async () => [],
    readJson: async () => null,
    writeJson: async () => {},
    writeJsonIfNewer: async () => {},
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    claimEntitlementEmail: async () => {
      emailClaims += 1;
      return emailClaims === 1 ? "email-claim-1" : null;
    },
    loadPaidPlusEntitlement: async () => ({
      active: true,
      checkoutId: "cs_test_fulfillment123456",
    }),
    markEntitlementEmailed: async () => {
      emailMarks += 1;
    },
    releaseEntitlementEmailClaim: async () => {
      emailReleases += 1;
    },
    revokePlusEntitlement: async () => {},
    savePlusEntitlement: async () => ({
      active: true,
      checkoutId: "cs_test_fulfillment123456",
      paidAt,
      expiresAt,
      activationEmailedAt: null,
    }),
  });
  const restorePaymentLock = installStub("lib/plus-payment-lock.js", {
    claimPlusPayment: async () => {
      paymentClaims += 1;
      return paymentClaims === 1
        ? {
            path: "payment-intents/pi_fulfillment123456.json",
            claimId: "claim-fulfillment",
          }
        : null;
    },
    releasePlusPayment: async () => {},
  });
  const fulfillmentPath = require.resolve(
    path.join(root, "lib/plus-fulfillment.js"),
  );
  delete require.cache[fulfillmentPath];

  try {
    const { fulfillPlusCheckout } = require(fulfillmentPath);
    const purchase = checkout({ paidAt });
    const results = await Promise.allSettled([
      fulfillPlusCheckout(
        { id: "paid-user", email: "paid@example.com" },
        purchase,
      ),
      fulfillPlusCheckout(
        { id: "paid-user", email: "paid@example.com" },
        purchase,
      ),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [
      "fulfilled",
      "rejected",
    ]);
    assert.equal(
      results.find((result) => result.status === "rejected").reason.statusCode,
      409,
    );
    assert.equal(emailRequests, 1);
    assert.equal(emailMarks, 1);
    assert.equal(emailReleases, 0);
    assert.equal(
      emailHeaders["Idempotency-Key"],
      "quizpatente-plus-activation/cs_test_fulfillment123456",
    );
  } finally {
    delete require.cache[fulfillmentPath];
    restorePaymentLock();
    restoreEntitlements();
    restoreKv();
    global.fetch = previousFetch;
    if (previousApiKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = previousApiKey;
    if (previousFrom === undefined) delete process.env.EMAIL_FROM;
    else process.env.EMAIL_FROM = previousFrom;
  }
});

test("a won dispute restores access unless the payment was also refunded", async () => {
  const stored = new Map();
  const paymentIntentPath = "payment-intents/pi_dispute123456.json";
  stored.set(paymentIntentPath, {
    version: 1,
    sessionId: "cs_test_dispute123456",
    paymentIntentId: "pi_dispute123456",
    userId: "paid-user",
    status: "paid",
  });
  const restoreKv = installStub("lib/db-kv.js", {
    listJsonByPrefix: async (_bucket, prefix) =>
      [...stored.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, value]) => value),
    readJson: async (_bucket, objectKey) => stored.get(objectKey) || null,
    writeJson: async (_bucket, objectKey, value) => {
      stored.set(objectKey, value);
    },
    writeJsonIfNewer: async (_bucket, objectKey, value, eventOrder) => {
      const current = stored.get(objectKey);
      if (!current || Number(current.eventOrder) <= Number(eventOrder)) {
        stored.set(objectKey, value);
        return value;
      }
      return null;
    },
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    claimEntitlementEmail: async () => null,
    loadPaidPlusEntitlement: async () => null,
    markEntitlementEmailed: async () => {},
    releaseEntitlementEmailClaim: async () => {},
    revokePlusEntitlement: async () => {},
    savePlusEntitlement: async () => {},
  });
  const restorePaymentLock = installStub("lib/plus-payment-lock.js", {
    claimPlusPayment: async () => ({
      path: "payment-intents/pi_dispute123456.json",
      claimId: "claim-dispute",
    }),
    releasePlusPayment: async () => {},
  });
  const fulfillmentPath = require.resolve(
    path.join(root, "lib/plus-fulfillment.js"),
  );
  delete require.cache[fulfillmentPath];

  try {
    const { loadPlusPaymentRevocation, recordPlusPaymentRevocation } = require(
      fulfillmentPath,
    );
    await recordPlusPaymentRevocation("pi_dispute123456", {
      reason: "charge.dispute.created",
      eventId: "evt_dispute_created",
      objectId: "du_dispute123456",
      status: "needs_response",
      eventCreated: 1_786_000_000,
    });
    assert.equal(
      (await loadPlusPaymentRevocation("pi_dispute123456")).active,
      true,
    );

    await recordPlusPaymentRevocation("pi_dispute123456", {
      reason: "charge.dispute.closed",
      eventId: "evt_dispute_won",
      objectId: "du_dispute123456",
      status: "won",
      eventCreated: 1_786_000_100,
    });
    assert.equal(await loadPlusPaymentRevocation("pi_dispute123456"), null);
    assert.equal(
      stored.get(paymentIntentPath).restorationEventId,
      "evt_dispute_won",
    );

    await recordPlusPaymentRevocation("pi_dispute123456", {
      reason: "charge.dispute.created",
      eventId: "evt_dispute_created_delayed",
      objectId: "du_dispute123456",
      status: "needs_response",
      eventCreated: 1_786_000_000,
    });
    assert.equal(await loadPlusPaymentRevocation("pi_dispute123456"), null);
    assert.equal(
      stored.get(paymentIntentPath).restorationEventId,
      "evt_dispute_won",
    );

    await recordPlusPaymentRevocation("pi_dispute123456", {
      reason: "charge.refunded",
      eventId: "evt_refunded",
    });
    await recordPlusPaymentRevocation("pi_dispute123456", {
      reason: "charge.dispute.closed",
      eventId: "evt_dispute_won_again",
      objectId: "du_dispute123456",
      status: "won",
      eventCreated: 1_786_000_200,
    });
    assert.equal(
      (await loadPlusPaymentRevocation("pi_dispute123456")).reason,
      "charge.refunded",
    );
  } finally {
    delete require.cache[fulfillmentPath];
    restorePaymentLock();
    restoreEntitlements();
    restoreKv();
  }
});

function checkout(overrides = {}) {
  return {
    id: "cs_test_fulfillment123456",
    source: "quizpatente",
    paymentIntentId: "pi_fulfillment123456",
    amountCents: 399,
    currency: "eur",
    paidAt: new Date().toISOString(),
    customerEmailSha256: "test-hash",
    ...overrides,
  };
}
