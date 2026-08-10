const {
  authenticateRequest,
  publicError,
  readJson,
  sendJson,
} = require("../lib/user-store");
const { fulfillPlusCheckout } = require("../lib/plus-fulfillment");
const {
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
    const session = await retrievePlusCheckoutSession(body.sessionId);
    const checkout = validatePlusCheckoutSession(session, user, {
      requirePaid: true,
    });
    const result = await fulfillPlusCheckout(user, checkout);
    return sendJson(res, 200, result);
  } catch (error) {
    const response = publicError(error, "Attivazione Plus non riuscita.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
