const crypto = require("node:crypto");
const Stripe = require("stripe");
const {
  CURRENCY,
  PRICE_CENTS,
  PRODUCT_SLUG,
  PRODUCT_TITLE,
} = require("./plus-access");

const APP_ORIGIN = "https://quizpatente.realb.it";
const APP_SLUG = "quizpatente";
const CHECKOUT_SCHEMA = "quizpatente-v1";
const STRIPE_API_VERSION = "2026-07-29.dahlia";
const TERMS_VERSION = "2026-08-10";
const BRANDING = Object.freeze({
  displayName: "Quiz Patente",
  iconUrl: `${APP_ORIGIN}/assets/icons/icon-512.png`,
  backgroundColor: "#fffdfa",
  buttonColor: "#063f3d",
});

let cachedClient = null;
let cachedSecret = null;
let verifiedAccountKey = null;
let verifiedCatalogKey = null;

function getStripeClient() {
  if (globalThis.__quizPatenteStripe) return globalThis.__quizPatenteStripe;
  const secret = requireEnv("STRIPE_SECRET_KEY");
  if (!cachedClient || cachedSecret !== secret) {
    cachedClient = new Stripe(secret, {
      apiVersion: STRIPE_API_VERSION,
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
    cachedSecret = secret;
    verifiedAccountKey = null;
    verifiedCatalogKey = null;
  }
  return cachedClient;
}

async function assertPlusCatalog(client = getStripeClient()) {
  const priceId = requireEnv("STRIPE_PLUS_PRICE_ID");
  const productId = requireEnv("STRIPE_PLUS_PRODUCT_ID");
  const cacheKey = `${priceId}:${productId}:${cachedSecret || "injected"}`;
  if (verifiedCatalogKey === cacheKey) return { priceId, productId };

  const price = await client.prices.retrieve(priceId, {
    expand: ["product"],
  });
  const product =
    price?.product && typeof price.product === "object" ? price.product : null;
  const validPrice =
    price?.id === priceId &&
    price.active === true &&
    price.type === "one_time" &&
    price.unit_amount === PRICE_CENTS &&
    String(price.currency || "").toLowerCase() === CURRENCY;
  const validProduct =
    product?.id === productId &&
    product.active === true &&
    product.name === PRODUCT_TITLE &&
    product.metadata?.app_slug === APP_SLUG &&
    product.metadata?.product_slug === PRODUCT_SLUG;
  if (!validPrice || !validProduct) {
    throw checkoutError(
      "Il catalogo Stripe non corrisponde a Quiz Patente Plus.",
      503,
    );
  }

  verifiedCatalogKey = cacheKey;
  return { priceId, productId };
}

async function assertExpectedStripeAccount(client = getStripeClient()) {
  const expectedAccountId = requireEnv("STRIPE_ACCOUNT_ID");
  const cacheKey = `${expectedAccountId}:${cachedSecret || "injected"}`;
  if (verifiedAccountKey === cacheKey) return expectedAccountId;

  const account = await client.accounts.retrieve();
  if (!account?.id || account.id !== expectedAccountId) {
    const error = new Error(
      "La chiave Stripe appartiene a un account inatteso.",
    );
    error.publicMessage = "Configurazione del pagamento non valida.";
    error.statusCode = 503;
    throw error;
  }
  verifiedAccountKey = cacheKey;
  return expectedAccountId;
}

async function createPlusCheckoutSession({ user, attemptId }) {
  if (!user?.id || !normalizeEmail(user.email)) {
    throw checkoutError("Account non valido.", 400);
  }
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(String(attemptId || ""))) {
    throw checkoutError("Tentativo di pagamento non valido.", 400);
  }

  const client = getStripeClient();
  await assertExpectedStripeAccount(client);
  const { priceId } = await assertPlusCatalog(client);
  const email = normalizeEmail(user.email);
  const metadata = {
    app_slug: APP_SLUG,
    checkout_schema: CHECKOUT_SCHEMA,
    product_slug: PRODUCT_SLUG,
    user_id: String(user.id),
    customer_email_sha256: sha256(email),
    immediate_access_consent: "true",
    terms_version: TERMS_VERSION,
    checkout_attempt_id: String(attemptId),
  };
  const session = await client.checkout.sessions.create(
    {
      mode: "payment",
      payment_method_types: ["card"],
      locale: "it",
      client_reference_id: String(user.id),
      customer_email: email,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata,
      payment_intent_data: { metadata },
      success_url: `${APP_ORIGIN}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${APP_ORIGIN}/?checkout=cancelled`,
      branding_settings: {
        display_name: BRANDING.displayName,
        icon: { type: "url", url: BRANDING.iconUrl },
        background_color: BRANDING.backgroundColor,
        button_color: BRANDING.buttonColor,
        border_style: "rounded",
        font_family: "inter",
      },
    },
    { idempotencyKey: checkoutIdempotencyKey(user.id, attemptId) },
  );

  assertExpectedLivemode(session);
  if (!session?.id || !session.url) {
    throw checkoutError("Stripe non ha restituito il checkout.", 502);
  }
  return session;
}

async function retrievePlusCheckoutSession(sessionId) {
  const normalizedId = normalizeSessionId(sessionId);
  const client = getStripeClient();
  await assertExpectedStripeAccount(client);
  const [session, lineItems] = await Promise.all([
    client.checkout.sessions.retrieve(normalizedId, {
      expand: ["payment_intent.latest_charge"],
    }),
    client.checkout.sessions.listLineItems(normalizedId, { limit: 10 }),
  ]);
  assertExpectedLivemode(session);
  return { ...session, line_items: lineItems };
}

async function retrieveCheckoutSessionByPaymentIntent(paymentIntentId) {
  const normalizedId = String(paymentIntentId || "").trim();
  if (!/^pi_[A-Za-z0-9_]{8,240}$/.test(normalizedId)) {
    throw checkoutError("PaymentIntent Stripe non valido.", 400);
  }
  const client = getStripeClient();
  await assertExpectedStripeAccount(client);
  const sessions = await client.checkout.sessions.list({
    payment_intent: normalizedId,
    limit: 2,
  });
  const session = sessions?.data?.[0];
  if (!session?.id) return null;
  if (sessions.data.length !== 1) {
    throw checkoutError("PaymentIntent associato a più checkout.", 409);
  }
  return retrievePlusCheckoutSession(session.id);
}

async function expirePlusCheckoutSession(sessionId) {
  const normalizedId = normalizeSessionId(sessionId);
  const client = getStripeClient();
  await assertExpectedStripeAccount(client);
  const session = await client.checkout.sessions.expire(normalizedId);
  assertExpectedLivemode(session);
  return session;
}

function validatePlusCheckoutSession(
  session,
  user,
  { requirePaid = true } = {},
) {
  if (!session || session.mode !== "payment") {
    throw checkoutError("Sessione Stripe non valida.", 400);
  }
  assertExpectedLivemode(session);

  const metadata = session.metadata || {};
  const isAppOwned =
    metadata.app_slug === APP_SLUG &&
    metadata.checkout_schema === CHECKOUT_SCHEMA &&
    metadata.product_slug === PRODUCT_SLUG;
  const isLegacyProofKit =
    !isAppOwned && metadata.experiment_slug === PRODUCT_SLUG;
  if (!isAppOwned && !isLegacyProofKit) {
    throw checkoutError("Il checkout non appartiene a Quiz Patente Plus.", 403);
  }
  if (
    session.amount_total !== PRICE_CENTS ||
    String(session.currency || "").toLowerCase() !== CURRENCY
  ) {
    throw checkoutError("Importo o valuta del checkout non validi.", 402);
  }
  if (
    metadata.immediate_access_consent !== "true" ||
    !String(metadata.terms_version || "").trim()
  ) {
    throw checkoutError(
      "Consenso digitale del checkout non verificabile.",
      402,
    );
  }

  const email = normalizeEmail(
    session.customer_details?.email || session.customer_email,
  );
  const expectedEmail = normalizeEmail(user?.email);
  if (!user?.id || !expectedEmail || email !== expectedEmail) {
    throw checkoutError(
      "Accedi con la stessa email usata durante il pagamento per attivare Plus.",
      403,
    );
  }

  if (isAppOwned) {
    const priceId = checkoutPriceId(session);
    if (
      metadata.user_id !== String(user.id) ||
      session.client_reference_id !== String(user.id) ||
      metadata.customer_email_sha256 !== sha256(expectedEmail) ||
      priceId !== requireEnv("STRIPE_PLUS_PRICE_ID")
    ) {
      throw checkoutError(
        "Il checkout appartiene a un altro account o piano.",
        403,
      );
    }
  }

  if (requirePaid && session.payment_status !== "paid") {
    throw checkoutError("Il pagamento non risulta completato.", 402);
  }
  const paidAt =
    session.payment_status === "paid" ? paidAtFromSession(session) : null;
  if (requirePaid && !paidAt) {
    throw checkoutError("Data del pagamento non verificabile.", 502);
  }

  return {
    id: session.id,
    source: isAppOwned ? APP_SLUG : "proofkit",
    status: session.status,
    paymentStatus: session.payment_status,
    paymentIntentId: paymentIntentId(session),
    amountCents: session.amount_total,
    currency: String(session.currency || "").toLowerCase(),
    paidAt,
    customerEmailSha256: sha256(email),
  };
}

function constructStripeWebhookEvent(rawBody, signature) {
  const secret = requireEnv("STRIPE_WEBHOOK_SECRET");
  const event = getStripeClient().webhooks.constructEvent(
    rawBody,
    signature,
    secret,
  );
  assertExpectedLivemode(event);
  return event;
}

function checkoutPriceId(session) {
  const price = session.line_items?.data?.[0]?.price;
  return typeof price === "string" ? price : price?.id || null;
}

function paidAtFromSession(session) {
  const paymentIntent = session.payment_intent;
  const charge =
    paymentIntent && typeof paymentIntent === "object"
      ? paymentIntent.latest_charge
      : null;
  const created =
    charge && typeof charge === "object" ? Number(charge.created) : Number.NaN;
  return Number.isFinite(created) && created > 0
    ? new Date(Math.trunc(created) * 1000).toISOString()
    : null;
}

function paymentIntentId(session) {
  const paymentIntent = session.payment_intent;
  return typeof paymentIntent === "string"
    ? paymentIntent
    : paymentIntent?.id || null;
}

function expectedLivemode() {
  const value = requireEnv("STRIPE_EXPECT_LIVEMODE").toLowerCase();
  if (value !== "true" && value !== "false") {
    throw checkoutError("STRIPE_EXPECT_LIVEMODE non valido.", 500);
  }
  return value === "true";
}

function assertExpectedLivemode(session) {
  if (
    typeof session?.livemode !== "boolean" ||
    session.livemode !== expectedLivemode()
  ) {
    throw checkoutError("Modalità Stripe inattesa.", 503);
  }
}

function checkoutIdempotencyKey(userId, attemptId) {
  return crypto
    .createHmac("sha256", requireEnv("APP_SECRET"))
    .update(`stripe-checkout:${userId}:${attemptId}`)
    .digest("hex");
}

function normalizeSessionId(value) {
  const sessionId = String(value || "").trim();
  if (!/^cs_(?:test_|live_)?[A-Za-z0-9_]{12,240}$/.test(sessionId)) {
    throw checkoutError("Sessione di pagamento non valida.", 400);
  }
  return sessionId;
}

function normalizeEmail(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw checkoutError(`${name} mancante.`, 503);
  return value;
}

function checkoutError(message, statusCode) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function resetStripeClientForTests() {
  cachedClient = null;
  cachedSecret = null;
  verifiedAccountKey = null;
  verifiedCatalogKey = null;
}

module.exports = {
  APP_ORIGIN,
  APP_SLUG,
  BRANDING,
  CHECKOUT_SCHEMA,
  STRIPE_API_VERSION,
  TERMS_VERSION,
  assertExpectedStripeAccount,
  assertPlusCatalog,
  constructStripeWebhookEvent,
  createPlusCheckoutSession,
  expirePlusCheckoutSession,
  resetStripeClientForTests,
  retrieveCheckoutSessionByPaymentIntent,
  retrievePlusCheckoutSession,
  validatePlusCheckoutSession,
};
