const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

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

test("the Web Request webhook preserves the signed body and owns finalization", async () => {
  let fulfilled = 0;
  let fulfillmentFailure = null;
  let releasedClaims = 0;
  let finalizeRows = 1;
  let paymentLockHeld = false;
  let releaseFirstReversal;
  let markFirstReversalStarted;
  let blockFirstReversal = true;
  const firstReversalStarted = new Promise((resolve) => {
    markFirstReversalStarted = resolve;
  });
  const rawPayloads = [];
  const finalizedOutcomes = [];
  const restoreKv = installStub("lib/db-kv.js", {
    readJson: async () => null,
  });
  const restoreDb = installStub("lib/db.js", {
    query: async (sql, params) => {
      if (sql.startsWith("insert into app_kv_objects")) {
        if (params[0] === "quizpatente-stripe-payment-locks") {
          if (paymentLockHeld) return [];
          paymentLockHeld = true;
        }
        return [{ payload: { outcome: "processing" } }];
      }
      if (sql.startsWith("update app_kv_objects")) {
        finalizedOutcomes.push(JSON.parse(params[3]).outcome);
        return finalizeRows ? [{ object_key: "event" }] : [];
      }
      if (sql.startsWith("delete from app_kv_objects")) {
        if (params[0] === "quizpatente-stripe-payment-locks") {
          paymentLockHeld = false;
        } else {
          releasedClaims += 1;
        }
        return [];
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  });
  const restoreFulfillment = installStub("lib/plus-fulfillment.js", {
    TERMINAL_REVOCATION_ERROR_CODE: "PLUS_PAYMENT_PERMANENTLY_REVOKED",
    fulfillPlusCheckout: async () => {
      fulfilled += 1;
      if (fulfillmentFailure) throw fulfillmentFailure;
    },
    recordPlusPaymentRevocation: async () => {
      if (blockFirstReversal) {
        blockFirstReversal = false;
        markFirstReversalStarted();
        await new Promise((resolve) => {
          releaseFirstReversal = resolve;
        });
      }
      return {
        payment: {
          userId: "paid-user",
          sessionId: "cs_test_webhook123456",
        },
        revocation: {
          reason: "charge.refunded",
          eventId: "evt_refund_first",
        },
      };
    },
  });
  const restoreAccess = installStub("lib/plus-access.js", {
    PRODUCT_SLUG: "quizpatente-plus",
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    restorePlusEntitlement: async () => null,
    revokePlusEntitlement: async () => ({ active: false }),
  });
  const restoreStripe = installStub("lib/stripe-checkout.js", {
    constructStripeWebhookEvent: (rawBody, signature) => {
      rawPayloads.push(rawBody.toString("utf8"));
      if (signature !== "valid-signature") throw new Error("bad signature");
      const parsed = JSON.parse(rawBody.toString("utf8"));
      if (parsed.type === "refund") {
        return {
          id: parsed.id,
          type: "charge.refunded",
          livemode: false,
          created: 1_786_000_100,
          data: {
            object: {
              id: "ch_webhook123456",
              payment_intent: "pi_webhook123456",
            },
          },
        };
      }
      return {
        id: parsed.id,
        type: "checkout.session.completed",
        livemode: false,
        created: 1_786_000_000,
        data: {
          object: {
            id: "cs_test_webhook123456",
            metadata: {
              product_slug: "quizpatente-plus",
            },
          },
        },
      };
    },
    retrieveCheckoutSessionByPaymentIntent: async () => null,
    retrievePlusCheckoutSession: async () => ({
      id: "cs_test_webhook123456",
      payment_status: "paid",
      metadata: { user_id: "paid-user" },
    }),
    validatePlusCheckoutSession: () => ({
      id: "cs_test_webhook123456",
      paymentIntentId: "pi_webhook123456",
      paidAt: new Date().toISOString(),
    }),
  });
  const restoreUsers = installStub("lib/user-store.js", {
    findUserByEmail: async () => null,
    findUserById: async () => ({
      id: "paid-user",
      email: "paid@example.com",
    }),
    publicError(error, fallback) {
      return {
        statusCode: error.statusCode || 500,
        payload: { error: error.publicMessage || fallback },
      };
    },
  });

  try {
    const routeUrl = `${
      pathToFileURL(path.join(root, "api/stripe-webhook.mjs")).href
    }?test=${Date.now()}`;
    const { default: webhook } = await import(routeUrl);
    const firstPayload = JSON.stringify({ id: "evt_webhook_valid" });
    const firstResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: firstPayload,
      }),
    );
    assert.equal(firstResponse.status, 200);
    assert.equal(fulfilled, 1);
    assert.equal(rawPayloads[0], firstPayload);

    fulfillmentFailure = Object.assign(new Error("payment revoked"), {
      statusCode: 410,
      code: "PLUS_PAYMENT_PERMANENTLY_REVOKED",
    });
    const revokedResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: JSON.stringify({ id: "evt_webhook_revoked" }),
      }),
    );
    assert.equal(revokedResponse.status, 200);
    assert.equal(finalizedOutcomes.at(-1), "not_fulfilled_revoked");

    fulfillmentFailure = Object.assign(new Error("temporary revocation"), {
      statusCode: 410,
      publicMessage: "Pagamento temporaneamente non disponibile.",
    });
    const retryableResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: JSON.stringify({ id: "evt_webhook_retryable_revocation" }),
      }),
    );
    assert.equal(retryableResponse.status, 410);
    assert.equal(finalizedOutcomes.at(-1), "not_fulfilled_revoked");
    fulfillmentFailure = null;

    const invalidResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "invalid-signature" },
        body: JSON.stringify({ id: "evt_webhook_invalid" }),
      }),
    );
    assert.equal(invalidResponse.status, 400);

    const firstReversalPromise = webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: JSON.stringify({ id: "evt_refund_first", type: "refund" }),
      }),
    );
    await firstReversalStarted;
    const concurrentReversalResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: JSON.stringify({ id: "evt_refund_second", type: "refund" }),
      }),
    );
    assert.equal(concurrentReversalResponse.status, 409);
    releaseFirstReversal();
    const firstReversalResponse = await firstReversalPromise;
    assert.equal(firstReversalResponse.status, 200);
    assert.equal(paymentLockHeld, false);

    finalizeRows = 0;
    const lostLeaseResponse = await webhook.fetch(
      new Request("https://example.test/api/stripe-webhook", {
        method: "POST",
        headers: { "stripe-signature": "valid-signature" },
        body: JSON.stringify({ id: "evt_webhook_lost_lease" }),
      }),
    );
    assert.equal(lostLeaseResponse.status, 409);
    assert.equal(releasedClaims, 3);
  } finally {
    restoreUsers();
    restoreStripe();
    restoreEntitlements();
    restoreAccess();
    restoreFulfillment();
    restoreDb();
    restoreKv();
  }
});
