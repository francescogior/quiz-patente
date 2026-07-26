const {
  authenticateRequest,
  publicError,
  readJson,
  sendJson,
} = require("../lib/user-store");
const {
  CURRENCY,
  PRICE_CENTS,
  PRODUCT_SLUG,
  issuePlusToken,
  verifyPlusToken,
} = require("../lib/plus-access");
const crypto = require("node:crypto");
const {
  markEntitlementEmailed,
  savePlusEntitlement,
} = require("../lib/plus-entitlements");

const CHECKOUT_STATUS_URL = "https://proofkit.realb.it/api/checkout/status";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    const body = await readJson(req);
    const sessionId = String(body.sessionId || "").trim();
    if (!/^cs_(test_|live_)?[A-Za-z0-9_]{12,240}$/.test(sessionId)) {
      return sendJson(res, 400, { error: "Sessione di pagamento non valida." });
    }

    const checkout = await loadPaidCheckout(sessionId);
    const accountHash = crypto
      .createHash("sha256")
      .update(String(user.email || "").trim().toLowerCase())
      .digest("hex");
    if (!checkout.customerEmailSha256 || checkout.customerEmailSha256 !== accountHash) {
      const error = new Error("Il pagamento appartiene a un altro account.");
      error.publicMessage =
        "Accedi con la stessa email usata durante il pagamento per attivare Plus.";
      error.statusCode = 403;
      throw error;
    }
    let token = issuePlusToken({
      user,
      checkoutId: checkout.id,
      paidAt: checkout.paidAt,
    });
    let access = verifyPlusToken(token, user);
    if (!access.active) {
      const error = new Error("Pass già scaduto.");
      error.publicMessage = "Questo pass di 30 giorni è già scaduto.";
      error.statusCode = 410;
      throw error;
    }

    const entitlement = await savePlusEntitlement(user, access);
    token = issuePlusToken({
      user,
      checkoutId: entitlement.checkoutId,
      paidAt: entitlement.paidAt,
    });
    access = verifyPlusToken(token, user);
    if (!access.active) {
      const error = new Error("Entitlement salvato ma già scaduto.");
      error.publicMessage = "Questo pass di 30 giorni è già scaduto.";
      error.statusCode = 410;
      throw error;
    }
    if (!entitlement.activationEmailedAt) {
      await sendActivationEmail(user.email, token, access.expiresAt)
        .then(() => markEntitlementEmailed(user, entitlement))
        .catch((error) => {
          console.error("Plus activation email failed", { message: error.message });
        });
    }

    return sendJson(res, 200, { token, access });
  } catch (error) {
    const response = publicError(error, "Attivazione Plus non riuscita.");
    return sendJson(res, response.statusCode, response.payload);
  }
};

async function loadPaidCheckout(sessionId) {
  const url = new URL(CHECKOUT_STATUS_URL);
  url.searchParams.set("sessionId", sessionId);
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok || !payload.checkout) {
    const error = new Error(payload?.error || "Checkout non trovato.");
    error.publicMessage = "Non riesco a verificare il pagamento.";
    error.statusCode = response.status === 404 ? 404 : 502;
    throw error;
  }

  const checkout = payload.checkout;
  const isExpectedPurchase =
    checkout.status === "paid" &&
    checkout.experimentSlug === PRODUCT_SLUG &&
    checkout.amountCents === PRICE_CENTS &&
    String(checkout.currency || "").toLowerCase() === CURRENCY;
  if (!isExpectedPurchase) {
    const error = new Error("Pagamento non completato o prodotto errato.");
    error.publicMessage = "Il pagamento non risulta completato.";
    error.statusCode = 402;
    throw error;
  }
  return checkout;
}

async function sendActivationEmail(email, token, expiresAt) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from || !email) return;

  const url = new URL("https://quizpatente.realb.it/");
  url.hash = `plus_token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: email,
      subject: "Quiz Patente Plus è attivo",
      text: [
        "Quiz Patente Plus è attivo.",
        "",
        `Accesso valido fino al ${new Date(expiresAt).toLocaleDateString("it-IT")}.`,
        "Al checkout hai chiesto l’inizio immediato del servizio digitale e confermato la relativa informativa sul recesso.",
        "Per attivarlo su un altro dispositivo, accedi allo stesso account e apri questo link:",
        url.toString(),
        "",
        "Il link è personale: non inoltrarlo.",
        "Termini: https://quizpatente.realb.it/terms.html",
        "Rimborsi: https://quizpatente.realb.it/refunds.html",
      ].join("\n"),
    }),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 500));
}
