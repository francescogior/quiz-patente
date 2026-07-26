const { authenticateRequest, publicError, sendJson } = require("../lib/user-store");
const {
  issuePlusToken,
  plusTokenFromRequest,
  verifyPlusToken,
} = require("../lib/plus-access");
const { loadPlusEntitlement } = require("../lib/plus-entitlements");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Metodo non supportato." });

  try {
    const { user } = await authenticateRequest(req);
    let token = plusTokenFromRequest(req);
    let access = verifyPlusToken(token, user);
    if (!access.active) {
      const entitlement = await loadPlusEntitlement(user);
      if (entitlement?.active) {
        token = issuePlusToken({
          user,
          checkoutId: entitlement.checkoutId,
          paidAt: entitlement.paidAt,
        });
        access = verifyPlusToken(token, user);
      }
    }
    return sendJson(res, 200, {
      access,
      token: access.active ? token : null,
    });
  } catch (error) {
    const response = publicError(error, "Stato Plus non disponibile.");
    return sendJson(res, response.statusCode, response.payload);
  }
};
