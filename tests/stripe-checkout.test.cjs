const test = require("node:test");
const assert = require("node:assert/strict");
const Stripe = require("stripe");

process.env.APP_SECRET = "test-only-checkout-secret";
process.env.STRIPE_SECRET_KEY = "sk_test_quizpatente";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_quizpatente_test";
process.env.STRIPE_ACCOUNT_ID = "acct_realbit_test";
process.env.STRIPE_PLUS_PRODUCT_ID = "prod_quizpatente_plus";
process.env.STRIPE_PLUS_PRICE_ID = "price_quizpatente_plus";
process.env.STRIPE_EXPECT_LIVEMODE = "false";

const stripeCheckout = require("../lib/stripe-checkout");

test.afterEach(() => {
  delete global.__quizPatenteStripe;
  stripeCheckout.resetStripeClientForTests();
});

test("checkout uses only server-owned price, URLs, metadata, and project branding", async () => {
  let createCall = null;
  global.__quizPatenteStripe = {
    accounts: {
      retrieve: async () => ({ id: "acct_realbit_test" }),
    },
    prices: {
      retrieve: async () => validCatalogPrice(),
    },
    checkout: {
      sessions: {
        create: async (params, options) => {
          createCall = { params, options };
          return {
            id: "cs_test_quizpatente123456",
            url: "https://checkout.stripe.com/c/pay/test",
            livemode: false,
          };
        },
      },
    },
  };

  const session = await stripeCheckout.createPlusCheckoutSession({
    user: { id: "user-123", email: "Studente@Example.com" },
    attemptId: "attempt_quizpatente_123456",
    priceCents: 1,
    returnUrl: "https://attacker.example/",
  });

  assert.equal(session.id, "cs_test_quizpatente123456");
  assert.deepEqual(createCall.params.line_items, [
    { price: "price_quizpatente_plus", quantity: 1 },
  ]);
  assert.deepEqual(createCall.params.payment_method_types, ["card"]);
  assert.equal(createCall.params.customer_email, "studente@example.com");
  assert.equal(createCall.params.client_reference_id, "user-123");
  assert.equal(
    createCall.params.success_url,
    "https://quizpatente.realb.it/?checkout=success&session_id={CHECKOUT_SESSION_ID}",
  );
  assert.equal(
    createCall.params.cancel_url,
    "https://quizpatente.realb.it/?checkout=cancelled",
  );
  assert.equal(createCall.params.metadata.product_slug, "quizpatente-plus");
  assert.equal(createCall.params.metadata.user_id, "user-123");
  assert.equal(createCall.params.metadata.immediate_access_consent, "true");
  assert.deepEqual(createCall.params.branding_settings, {
    display_name: "Quiz Patente",
    icon: {
      type: "url",
      url: "https://quizpatente.realb.it/assets/icons/icon-512.png",
    },
    background_color: "#fffdfa",
    button_color: "#063f3d",
    border_style: "rounded",
    font_family: "inter",
  });
  assert.match(createCall.options.idempotencyKey, /^[a-f0-9]{64}$/);
});

test("checkout refuses a misconfigured Stripe amount, currency, or Product before charging", async () => {
  for (const invalidPrice of [
    validCatalogPrice({ unit_amount: 499 }),
    validCatalogPrice({ currency: "usd" }),
    validCatalogPrice({
      product: {
        ...validCatalogPrice().product,
        id: "prod_some_other_app",
      },
    }),
  ]) {
    let checkoutCreates = 0;
    global.__quizPatenteStripe = {
      accounts: {
        retrieve: async () => ({ id: "acct_realbit_test" }),
      },
      prices: { retrieve: async () => invalidPrice },
      checkout: {
        sessions: {
          create: async () => {
            checkoutCreates += 1;
            throw new Error("checkout must not be created");
          },
        },
      },
    };
    stripeCheckout.resetStripeClientForTests();

    await assert.rejects(
      stripeCheckout.createPlusCheckoutSession({
        user: { id: "user-123", email: "studente@example.com" },
        attemptId: "attempt_quizpatente_123456",
      }),
      (error) => error.statusCode === 503,
    );
    assert.equal(checkoutCreates, 0);
  }
});

test("new app-owned paid sessions require the same user, price, and charge time", () => {
  const session = paidSession();
  const checkout = stripeCheckout.validatePlusCheckoutSession(
    session,
    { id: "user-123", email: "studente@example.com" },
    { requirePaid: true },
  );

  assert.equal(checkout.source, "quizpatente");
  assert.equal(checkout.paidAt, "2026-08-10T12:00:00.000Z");
  assert.equal(checkout.amountCents, 399);
  assert.equal(checkout.currency, "eur");

  assert.throws(
    () =>
      stripeCheckout.validatePlusCheckoutSession(
        session,
        { id: "other-user", email: "studente@example.com" },
        { requirePaid: true },
      ),
    (error) => error.statusCode === 403,
  );
});

test("legacy ProofKit sessions remain recoverable by the original payer email", () => {
  const session = paidSession({
    client_reference_id: "legacy-proofkit-checkout",
    metadata: {
      experiment_slug: "quizpatente-plus",
      immediate_access_consent: "true",
      terms_version: "2026-07-26",
    },
    line_items: {
      data: [{ price: { id: "price_legacy_inline" }, quantity: 1 }],
    },
  });
  const checkout = stripeCheckout.validatePlusCheckoutSession(
    session,
    { id: "user-123", email: "studente@example.com" },
    { requirePaid: true },
  );
  assert.equal(checkout.source, "proofkit");

  assert.throws(
    () =>
      stripeCheckout.validatePlusCheckoutSession(
        session,
        { id: "user-123", email: "other@example.com" },
        { requirePaid: true },
      ),
    (error) => error.statusCode === 403,
  );
});

test("a refund can recover its Checkout Session from the PaymentIntent", async () => {
  const session = paidSession();
  global.__quizPatenteStripe = {
    accounts: {
      retrieve: async () => ({ id: "acct_realbit_test" }),
    },
    checkout: {
      sessions: {
        list: async (params) => {
          assert.deepEqual(params, {
            payment_intent: "pi_quizpatente",
            limit: 2,
          });
          return { data: [{ id: session.id }] };
        },
        retrieve: async () => session,
        listLineItems: async () => session.line_items,
      },
    },
  };

  const recovered =
    await stripeCheckout.retrieveCheckoutSessionByPaymentIntent(
      "pi_quizpatente",
    );
  assert.equal(recovered.id, session.id);
  assert.equal(recovered.payment_status, "paid");
});

test("webhook signature and live/test mode are both verified", () => {
  delete global.__quizPatenteStripe;
  stripeCheckout.resetStripeClientForTests();
  const payload = JSON.stringify({
    id: "evt_test_quizpatente",
    object: "event",
    type: "checkout.session.completed",
    livemode: false,
    data: { object: { id: "cs_test_quizpatente123456" } },
  });
  const signature = Stripe.webhooks.generateTestHeaderString({
    payload,
    secret: process.env.STRIPE_WEBHOOK_SECRET,
  });

  const event = stripeCheckout.constructStripeWebhookEvent(
    Buffer.from(payload),
    signature,
  );
  assert.equal(event.id, "evt_test_quizpatente");
  assert.throws(
    () =>
      stripeCheckout.constructStripeWebhookEvent(
        Buffer.from(payload),
        "t=1,v1=invalid",
      ),
    /signature/i,
  );
});

function paidSession(overrides = {}) {
  const email = "studente@example.com";
  const hash = require("node:crypto")
    .createHash("sha256")
    .update(email)
    .digest("hex");
  return {
    id: "cs_test_quizpatente123456",
    livemode: false,
    mode: "payment",
    status: "complete",
    payment_status: "paid",
    amount_total: 399,
    currency: "eur",
    client_reference_id: "user-123",
    customer_details: { email },
    customer_email: email,
    metadata: {
      app_slug: "quizpatente",
      checkout_schema: "quizpatente-v1",
      product_slug: "quizpatente-plus",
      user_id: "user-123",
      customer_email_sha256: hash,
      immediate_access_consent: "true",
      terms_version: "2026-08-10",
    },
    payment_intent: {
      id: "pi_quizpatente",
      latest_charge: {
        id: "ch_quizpatente",
        created: Date.parse("2026-08-10T12:00:00.000Z") / 1000,
      },
    },
    line_items: {
      data: [{ price: { id: "price_quizpatente_plus" }, quantity: 1 }],
    },
    ...overrides,
  };
}

function validCatalogPrice(overrides = {}) {
  return {
    id: "price_quizpatente_plus",
    active: true,
    type: "one_time",
    unit_amount: 399,
    currency: "eur",
    product: {
      id: "prod_quizpatente_plus",
      active: true,
      name: "Quiz Patente Plus — 30 giorni",
      metadata: {
        app_slug: "quizpatente",
        product_slug: "quizpatente-plus",
      },
    },
    ...overrides,
  };
}
