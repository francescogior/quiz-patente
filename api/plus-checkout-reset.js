const {
  authenticateRequest,
  publicError,
  readJson,
  sendJson,
} = require("../lib/user-store");
const {
  expirePlusCheckoutSession,
  retrievePlusCheckoutSession,
  validatePlusCheckoutSession,
} = require("../lib/stripe-checkout");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Metodo non supportato." });
  }

  try {
    const { user } = await authenticateRequest(req);
    const body = await readJson(req);
    let session = await retrievePlusCheckoutSession(body.sessionId);
    const checkout = validatePlusCheckoutSession(session, user, {
      requirePaid: false,
    });

    if (checkout.paymentStatus === "paid") {
      return sendJson(res, 409, {
        error:
          "Il pagamento è completato: usa “Riprova l’attivazione” o contatta l’assistenza.",
      });
    }
    if (session.status === "open") {
      session = await expirePlusCheckoutSession(session.id);
    }
    if (session.status !== "expired") {
      return sendJson(res, 409, {
        error:
          "La sessione può ancora essere pagata. Riapri lo stesso checkout o riprova tra poco.",
      });
    }

    return sendJson(res, 200, {
      ok: true,
      discardable: true,
      status: session.status,
    });
  } catch (error) {
    const response = publicError(
      error,
      "Non posso verificare il tentativo di pagamento.",
    );
    return sendJson(res, response.statusCode, response.payload);
  }
};
