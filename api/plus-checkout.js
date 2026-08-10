const {
  authenticateRequest,
  publicError,
  readJson,
  sendJson,
} = require("../lib/user-store");
const { createPlusCheckoutSession } = require("../lib/stripe-checkout");
const { loadPlusEntitlement } = require("../lib/plus-entitlements");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { error: "Metodo non supportato." });
  }

  try {
    const { user } = await authenticateRequest(req);
    const entitlement = await loadPlusEntitlement(user);
    if (entitlement?.active) {
      return sendJson(res, 409, {
        error: "Quiz Patente Plus è già attivo su questo account.",
      });
    }
    const body = await readJson(req);
    if (body.immediateAccessConsent !== true) {
      return sendJson(res, 400, {
        error: "Conferma l’inizio immediato dell’accesso digitale.",
      });
    }
    const session = await createPlusCheckoutSession({
      user,
      attemptId: body.attemptId,
    });
    return sendJson(res, 200, {
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    const response = publicError(error, "Pagamento non disponibile ora.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
