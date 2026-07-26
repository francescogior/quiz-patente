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
} = require("../lib/plus-access");

const CHECKOUT_STATUS_URL = "https://proofkit.realb.it/api/checkout/status";

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Metodo non supportato." });
  }

  try {
    await authenticateRequest(req);
    const body = await readJson(req);
    const sessionId = String(body.sessionId || "").trim();
    if (!/^cs_(test_|live_)?[A-Za-z0-9_]{12,240}$/.test(sessionId)) {
      return sendJson(res, 400, { error: "Sessione di pagamento non valida." });
    }

    const url = new URL(CHECKOUT_STATUS_URL);
    url.searchParams.set("sessionId", sessionId);
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.ok || !payload.checkout) {
      const error = new Error(payload?.error || "Checkout non trovato.");
      error.publicMessage =
        "Non posso verificare che il pagamento sia sicuro da scartare. Riprova tra poco.";
      error.statusCode = 502;
      throw error;
    }

    const checkout = payload.checkout;
    const exactProduct =
      checkout.experimentSlug === PRODUCT_SLUG &&
      checkout.amountCents === PRICE_CENTS &&
      String(checkout.currency || "").toLowerCase() === CURRENCY;
    if (!exactProduct) {
      return sendJson(res, 403, {
        error: "Questa sessione non appartiene a Quiz Patente Plus.",
      });
    }
    if (checkout.status === "paid") {
      return sendJson(res, 409, {
        error:
          "Il pagamento è completato: non ricominciare. Usa “Riprova l’attivazione” o contatta l’assistenza.",
      });
    }

    const stripeConfirmedUnpaid =
      payload.sync?.ok === true &&
      (checkout.status === "open" || checkout.status === "expired");
    if (!stripeConfirmedUnpaid) {
      return sendJson(res, 409, {
        error:
          "Lo stato del pagamento non è ancora certo. Riprova l’attivazione o attendi qualche minuto.",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      discardable: true,
      status: checkout.status,
    });
  } catch (error) {
    const result = publicError(
      error,
      "Non posso verificare il tentativo di pagamento.",
    );
    return sendJson(res, result.statusCode, result.payload);
  }
};
