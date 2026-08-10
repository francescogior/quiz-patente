const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Plus checkout is app-owned and server-authoritative", () => {
  const app = read("app.js");
  const route = read("api/plus-checkout.js");
  const stripe = read("lib/stripe-checkout.js");
  assert.match(app, /PLUS_CHECKOUT_URL = "\.\/api\/plus-checkout"/);
  assert.match(app, /authFetch\(PLUS_CHECKOUT_URL/);
  assert.doesNotMatch(app, /proofkit\.realb\.it/);
  assert.doesNotMatch(app, /priceCents:\s*399/);
  assert.match(app, /immediateAccessConsent:\s*true/);
  assert.match(route, /authenticateRequest\(req\)/);
  assert.match(route, /body\.immediateAccessConsent !== true/);
  assert.match(stripe, /STRIPE_PLUS_PRICE_ID/);
  assert.match(stripe, /STRIPE_PLUS_PRODUCT_ID/);
  assert.match(stripe, /client\.prices\.retrieve/);
  assert.match(stripe, /PRICE_CENTS/);
  assert.match(stripe, /CURRENCY/);
  assert.match(stripe, /Quiz Patente/);
  assert.match(stripe, /branding_settings/);
  assert.match(stripe, /assets\/icons\/icon-512\.png/);
});

test("account UI discloses the duration, consent, and legal pages", () => {
  const html = read("index.html");
  assert.match(html, /id="plusConsent"/);
  assert.match(html, /€3,99/);
  assert.match(html, /30 giorni/);
  assert.match(html, /rel="icon"[^>]+assets\/icons\/icon-192\.png/);
  for (const file of ["terms.html", "refunds.html", "privacy.html"]) {
    assert.equal(fs.existsSync(path.join(root, file)), true);
    assert.match(html, new RegExp(file.replace(".", "\\.")));
  }
});

test("service worker revision includes the legal pages", () => {
  const worker = read("service-worker.js");
  assert.match(worker, /quiz-patente-ab-v32/);
  assert.match(worker, /\.\/terms\.html/);
  assert.match(worker, /\.\/refunds\.html/);
  assert.match(worker, /\.\/privacy\.html/);
});

test("checkout recovery is persisted and callback URLs bypass CacheStorage", () => {
  const app = read("app.js");
  const worker = read("service-worker.js");
  const reset = read("api/plus-checkout-reset.js");
  assert.match(app, /PLUS_PENDING_SESSION_KEY/);
  assert.match(app, /PLUS_PENDING_CHECKOUT_URL_KEY/);
  assert.match(
    app,
    /localStorage\.setItem\(PLUS_PENDING_SESSION_KEY, response\.sessionId\)/,
  );
  assert.match(app, /Riapri lo stesso checkout/);
  const cancelledBranch = app.slice(
    app.indexOf('checkoutState === "cancelled"'),
    app.indexOf('checkoutState === "cancelled"') + 650,
  );
  assert.doesNotMatch(cancelledBranch, /clearPendingPlusCheckout/);
  assert.match(app, /checkoutUrl\.hostname !== "checkout\.stripe\.com"/);
  assert.match(app, /\.\/api\/plus-checkout-reset/);
  assert.match(reset, /retrievePlusCheckoutSession/);
  assert.match(reset, /expirePlusCheckoutSession/);
  assert.match(reset, /checkout\.paymentStatus === "paid"/);
  assert.match(reset, /session\.status !== "expired"/);
  assert.match(worker, /url\.searchParams\.has\("checkout"\)/);
  assert.match(worker, /url\.searchParams\.has\("session_id"\)/);
  assert.match(worker, /cache: "no-store"/);
});

test("activation verifies Stripe directly and binds pass duration to durable dates", () => {
  const activation = read("api/plus-activate.js");
  const access = read("lib/plus-access.js");
  const stripe = read("lib/stripe-checkout.js");
  assert.match(activation, /retrievePlusCheckoutSession/);
  assert.match(activation, /validatePlusCheckoutSession/);
  assert.match(stripe, /payment_intent\.latest_charge/);
  assert.match(stripe, /customerEmailSha256/);
  assert.match(access, /paidAtMs \+ ACCESS_DAYS/);
  assert.match(access, /Math\.floor\(expiresAtMs \/ 1000\)/);
});

test("signed Stripe webhook fulfills Plus without a browser return", () => {
  const webhook = read("api/stripe-webhook.mjs");
  assert.match(webhook, /request\.arrayBuffer\(\)/);
  assert.doesNotMatch(webhook, /request\.body/);
  assert.match(webhook, /constructStripeWebhookEvent/);
  assert.match(webhook, /checkout\.session\.completed/);
  assert.match(webhook, /checkout\.session\.async_payment_succeeded/);
  assert.match(webhook, /charge\.refunded/);
  assert.match(webhook, /charge\.dispute\.created/);
  assert.match(webhook, /charge\.dispute\.closed/);
  assert.match(webhook, /recordPlusPaymentRevocation/);
  assert.match(webhook, /fulfillPlusCheckout/);
  assert.match(webhook, /quizpatente-stripe-events/);
});

test("private translation cache uses the server-only Neon key-value store", () => {
  const translation = read("api/translation.js");
  assert.match(translation, /readCachedJson\(BUCKET, cachePath\)/);
  assert.match(translation, /writeJson\(BUCKET, cachePath, translation\)/);
});

test("new AI generations use atomic distributed quota slots and generation locks", () => {
  const usage = read("lib/plus-usage.js");
  const translation = read("api/translation.js");
  const explanation = read("api/explanation.js");
  assert.match(usage, /DAILY_LIMIT = 30/);
  assert.match(usage, /BURST_LIMIT = 6/);
  assert.match(usage, /claimFirstAvailableSlot/);
  assert.match(usage, /claimJson\(BUCKET, objectPath, payload\)/);
  assert.match(usage, /locks\/\$\{dateKey\}/);
  assert.match(
    translation,
    /consumePlusGeneration\(\s*user,\s*"translation",\s*cachePath,?\s*\)/,
  );
  assert.match(explanation, /consumePlusGeneration\(/);
  assert.match(explanation, /`\$\{PROMPT_VERSION\}:\$\{question\.id\}`/);
});

test("Neon bigint question ids keep the numeric API contract", () => {
  const explanation = read("api/explanation.js");
  assert.match(explanation, /questionId: Number\(row\.question_id\)/);
});

test("paid access is persisted and recoverable without relying on email delivery", () => {
  const activation = read("api/plus-activate.js");
  const status = read("api/plus-status.js");
  const store = read("lib/plus-entitlements.js");
  const fulfillment = read("lib/plus-fulfillment.js");
  assert.match(activation, /fulfillPlusCheckout\(user, checkout\)/);
  assert.match(fulfillment, /savePlusEntitlement\(user, access\)/);
  assert.match(status, /loadPlusEntitlement\(user\)/);
  assert.match(status, /issuePlusToken/);
  assert.match(store, /quizpatente-plus-entitlements/);
  assert.match(store, /readJson\(BUCKET, entitlementPath\(user\)\)/);
  assert.match(fulfillment, /checkoutId: entitlement\.checkoutId/);
  assert.match(fulfillment, /paidAt: entitlement\.paidAt/);
});
