const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("Plus checkout is wired to the exact product and production return URL", () => {
  const app = read("app.js");
  assert.match(app, /experimentSlug:\s*"quizpatente-plus"/);
  assert.match(app, /title:\s*"Quiz Patente Plus — 30 giorni"/);
  assert.match(app, /priceCents:\s*399/);
  assert.match(app, /returnUrl:\s*"https:\/\/quizpatente\.realb\.it\/"/);
  assert.match(app, /immediateAccessConsent:\s*true/);
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
  assert.match(worker, /quiz-patente-ab-v29/);
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
  assert.match(app, /localStorage\.setItem\(PLUS_PENDING_SESSION_KEY, response\.sessionId\)/);
  assert.match(app, /Riapri lo stesso checkout/);
  const cancelledBranch = app.slice(
    app.indexOf('checkoutState === "cancelled"'),
    app.indexOf('checkoutState === "cancelled"') + 650,
  );
  assert.doesNotMatch(cancelledBranch, /clearPendingPlusCheckout/);
  assert.match(app, /checkoutUrl\.hostname !== "checkout\.stripe\.com"/);
  assert.match(app, /\.\/api\/plus-checkout-reset/);
  assert.match(reset, /payload\.sync\?\.ok === true/);
  assert.match(reset, /checkout\.status === "paid"/);
  assert.match(reset, /checkout\.status === "expired"/);
  assert.doesNotMatch(reset, /checkout\.status === "open"/);
  assert.match(worker, /url\.searchParams\.has\("checkout"\)/);
  assert.match(worker, /url\.searchParams\.has\("session_id"\)/);
  assert.match(worker, /cache: "no-store"/);
});

test("activation binds the Stripe payer hash and pass duration to paidAt", () => {
  const activation = read("api/plus-activate.js");
  const access = read("lib/plus-access.js");
  assert.match(activation, /customerEmailSha256/);
  assert.match(activation, /createHash\("sha256"\)/);
  assert.match(access, /paidAtSeconds \+ ACCESS_DAYS/);
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
  assert.match(translation, /consumePlusGeneration\(user, "translation", cachePath\)/);
  assert.match(explanation, /consumePlusGeneration\(/);
  assert.match(explanation, /`\$\{PROMPT_VERSION\}:\$\{question\.id\}`/);
});

test("paid access is persisted and recoverable without relying on email delivery", () => {
  const activation = read("api/plus-activate.js");
  const status = read("api/plus-status.js");
  const store = read("lib/plus-entitlements.js");
  assert.match(activation, /savePlusEntitlement\(user, access\)/);
  assert.match(status, /loadPlusEntitlement\(user\)/);
  assert.match(status, /issuePlusToken/);
  assert.match(store, /quizpatente-plus-entitlements/);
  assert.match(store, /readJson\(BUCKET, entitlementPath\(user\)\)/);
  assert.match(activation, /checkoutId: entitlement\.checkoutId/);
  assert.match(activation, /paidAt: entitlement\.paidAt/);
});
