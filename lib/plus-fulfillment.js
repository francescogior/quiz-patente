const { issuePlusToken, verifyPlusToken } = require("./plus-access");
const {
  claimEntitlementEmail,
  loadPlusEntitlement,
  markEntitlementEmailed,
  releaseEntitlementEmailClaim,
  revokePlusEntitlement,
  savePlusEntitlement,
} = require("./plus-entitlements");
const {
  listJsonByPrefix,
  readJson,
  writeJson,
  writeJsonIfNewer,
} = require("./db-kv");
const { claimPlusPayment, releasePlusPayment } = require("./plus-payment-lock");

const PAYMENTS_BUCKET = "quizpatente-plus-payments";
const TERMINAL_REVOCATION_ERROR_CODE =
  "PLUS_PAYMENT_PERMANENTLY_REVOKED";

async function fulfillPlusCheckout(user, checkout) {
  const paymentClaim = checkout.paymentIntentId
    ? await claimPlusPayment(checkout.paymentIntentId)
    : null;
  if (checkout.paymentIntentId && !paymentClaim) {
    throw fulfillmentError(
      "Questo pagamento è già in elaborazione. Riprova tra poco.",
      409,
    );
  }
  try {
    return await fulfillPlusCheckoutLocked(user, checkout);
  } finally {
    await releasePlusPayment(paymentClaim);
  }
}

async function fulfillPlusCheckoutLocked(user, checkout) {
  const existingRevocation = checkout.paymentIntentId
    ? await loadPlusPaymentRevocation(checkout.paymentIntentId)
    : null;
  if (existingRevocation) {
    throw revokedPaymentError(existingRevocation);
  }

  let token = issuePlusToken({
    user,
    checkoutId: checkout.id,
    paidAt: checkout.paidAt,
  });
  let access = verifyPlusToken(token, user);
  if (!access.active) {
    throw fulfillmentError("Questo pass di 30 giorni è già scaduto.", 410);
  }

  const entitlement = await savePlusEntitlement(user, access);
  if (!entitlement?.active) {
    throw fulfillmentError("Questo pagamento non dà più accesso a Plus.", 410);
  }
  token = issuePlusToken({
    user,
    checkoutId: entitlement.checkoutId,
    paidAt: entitlement.paidAt,
  });
  access = verifyPlusToken(token, user);
  if (!access.active) {
    throw fulfillmentError("Questo pass di 30 giorni è già scaduto.", 410);
  }

  const paymentRecord = {
    version: 1,
    sessionId: checkout.id,
    paymentIntentId: checkout.paymentIntentId || null,
    userId: String(user.id),
    source: checkout.source,
    status: "paid",
    amountCents: checkout.amountCents,
    currency: checkout.currency,
    customerEmailSha256: checkout.customerEmailSha256,
    paidAt: checkout.paidAt,
    expiresAt: access.expiresAt,
    updatedAt: new Date().toISOString(),
  };
  await writeJson(
    PAYMENTS_BUCKET,
    `sessions/${checkout.id}.json`,
    paymentRecord,
  );
  if (checkout.paymentIntentId) {
    await writeJson(
      PAYMENTS_BUCKET,
      paymentIntentPath(checkout.paymentIntentId),
      paymentRecord,
    );
  }

  const concurrentRevocation = checkout.paymentIntentId
    ? await loadPlusPaymentRevocation(checkout.paymentIntentId)
    : null;
  if (concurrentRevocation) {
    await revokePlusEntitlement(user, {
      checkoutId: checkout.id,
      reason: concurrentRevocation.reason,
      eventId: concurrentRevocation.eventId,
    });
    await syncPlusPaymentRevocation(checkout.paymentIntentId);
    throw revokedPaymentError(concurrentRevocation);
  }

  if (!entitlement.activationEmailedAt) {
    const claimId = await claimEntitlementEmail(user, entitlement);
    if (claimId) {
      try {
        const currentEntitlement = await loadPlusEntitlement(user);
        if (
          !currentEntitlement?.active ||
          currentEntitlement.checkoutId !== entitlement.checkoutId
        ) {
          throw fulfillmentError(
            "Questo pagamento non dà più accesso a Plus.",
            410,
          );
        }
        const sent = await sendActivationEmail(
          user.email,
          token,
          access.expiresAt,
          entitlement.checkoutId,
        );
        if (sent) {
          await markEntitlementEmailed(user, entitlement, claimId);
        } else {
          await releaseEntitlementEmailClaim(user, entitlement, claimId);
        }
      } catch (error) {
        await releaseEntitlementEmailClaim(user, entitlement, claimId).catch(
          (releaseError) => {
            console.error("Plus activation email claim release failed", {
              message: releaseError.message,
            });
          },
        );
        if (error.statusCode) throw error;
        console.error("Plus activation email failed", {
          message: error.message,
        });
      }
    }
  }

  return { token, access };
}

async function loadPlusPaymentByIntent(paymentIntentId) {
  const normalizedId = normalizePaymentIntentId(paymentIntentId);
  const value = await readJson(
    PAYMENTS_BUCKET,
    paymentIntentPath(normalizedId),
  );
  if (
    !value ||
    value.version !== 1 ||
    !value.sessionId ||
    !value.userId ||
    value.paymentIntentId !== normalizedId
  ) {
    return null;
  }
  return value;
}

async function loadPlusPaymentRevocation(paymentIntentId) {
  const normalizedId = normalizePaymentIntentId(paymentIntentId);
  const [refund, disputes] = await Promise.all([
    readJson(PAYMENTS_BUCKET, `refunds/${normalizedId}.json`),
    listJsonByPrefix(PAYMENTS_BUCKET, `disputes/${normalizedId}/`),
  ]);
  if (
    refund?.version === 1 &&
    refund.paymentIntentId === normalizedId &&
    refund.active === true
  ) {
    return refund;
  }
  return (
    disputes.find(
      (value) =>
        value?.version === 1 &&
        value.paymentIntentId === normalizedId &&
        value.active === true,
    ) || null
  );
}

async function recordPlusPaymentRevocation(
  payment,
  { reason, eventId, objectId, status, eventCreated } = {},
) {
  const normalizedId = normalizePaymentIntentId(
    typeof payment === "string" ? payment : payment?.paymentIntentId,
  );
  const existingPayment =
    typeof payment === "string"
      ? await loadPlusPaymentByIntent(normalizedId)
      : payment;
  const normalizedReason = String(reason || "payment_revoked").slice(0, 80);
  const isRefund = normalizedReason === "charge.refunded";
  const isDispute = normalizedReason.startsWith("charge.dispute.");
  if (!isRefund && !isDispute) {
    throw fulfillmentError("Tipo di revoca Stripe non valido.", 400);
  }
  const normalizedObjectId = isDispute ? normalizeDisputeId(objectId) : null;
  const normalizedEventCreated = Number(eventCreated);
  if (
    isDispute &&
    (!Number.isInteger(normalizedEventCreated) || normalizedEventCreated <= 0)
  ) {
    throw fulfillmentError("Data evento Stripe non valida.", 400);
  }
  const disputeResolved =
    normalizedReason === "charge.dispute.closed" &&
    (status === "won" || status === "warning_closed");
  const eventState = {
    version: 1,
    paymentIntentId: normalizedId,
    objectId: normalizedObjectId,
    reason: normalizedReason,
    status: String(status || "").slice(0, 80) || null,
    eventId: String(eventId || "").slice(0, 128),
    eventCreated: isDispute ? normalizedEventCreated : null,
    eventOrder: isDispute
      ? normalizedEventCreated * 10 +
        (normalizedReason === "charge.dispute.closed" ? 2 : 1)
      : null,
    active: isRefund || !disputeResolved,
    updatedAt: new Date().toISOString(),
  };
  let persistedEventState = eventState;
  if (isRefund) {
    await writeJson(
      PAYMENTS_BUCKET,
      `refunds/${normalizedId}.json`,
      eventState,
    );
  } else {
    const disputePath = `disputes/${normalizedId}/${normalizedObjectId}.json`;
    persistedEventState = await writeJsonIfNewer(
      PAYMENTS_BUCKET,
      disputePath,
      eventState,
      eventState.eventOrder,
    );
    if (!persistedEventState) {
      persistedEventState = await readJson(PAYMENTS_BUCKET, disputePath);
    }
  }
  const revocation = await loadPlusPaymentRevocation(normalizedId);
  if (!existingPayment) return { payment: null, revocation };

  const next = paymentRecordWithRevocationState(
    existingPayment,
    revocation,
    persistedEventState,
  );
  await savePaymentRecord(next);
  return { payment: next, revocation };
}

async function syncPlusPaymentRevocation(paymentIntentId) {
  const normalizedId = normalizePaymentIntentId(paymentIntentId);
  const [payment, revocation] = await Promise.all([
    loadPlusPaymentByIntent(normalizedId),
    loadPlusPaymentRevocation(normalizedId),
  ]);
  if (!payment) return { payment: null, revocation };
  const next = paymentRecordWithRevocationState(payment, revocation, {
    eventId: revocation?.eventId || null,
    updatedAt: revocation?.updatedAt || new Date().toISOString(),
  });
  await savePaymentRecord(next);
  return { payment: next, revocation };
}

function paymentRecordWithRevocationState(payment, revocation, eventState) {
  return revocation
    ? {
        ...payment,
        status: "revoked",
        revocationReason: revocation.reason,
        revocationEventId: revocation.eventId,
        revokedAt: revocation.updatedAt,
        updatedAt: new Date().toISOString(),
      }
    : restoredPaymentRecord(payment, eventState);
}

async function savePaymentRecord(payment) {
  await Promise.all([
    writeJson(PAYMENTS_BUCKET, `sessions/${payment.sessionId}.json`, payment),
    writeJson(
      PAYMENTS_BUCKET,
      paymentIntentPath(payment.paymentIntentId),
      payment,
    ),
  ]);
}

function restoredPaymentRecord(payment, eventState) {
  if (!eventState) return payment;
  const {
    revocationReason: _reason,
    revocationEventId: _eventId,
    revokedAt: _revokedAt,
    ...rest
  } = payment;
  return {
    ...rest,
    status: "paid",
    restoredAt: eventState.updatedAt,
    restorationEventId: eventState.eventId,
    updatedAt: new Date().toISOString(),
  };
}

function paymentIntentPath(paymentIntentId) {
  return `payment-intents/${normalizePaymentIntentId(paymentIntentId)}.json`;
}

function normalizePaymentIntentId(value) {
  const id = String(value || "").trim();
  if (!/^pi_[A-Za-z0-9_]{8,240}$/.test(id)) {
    throw fulfillmentError("PaymentIntent Stripe non valido.", 400);
  }
  return id;
}

function normalizeDisputeId(value) {
  const id = String(value || "").trim();
  if (!/^d[pu]_[A-Za-z0-9_]{6,240}$/.test(id)) {
    throw fulfillmentError("Contestazione Stripe non valida.", 400);
  }
  return id;
}

async function sendActivationEmail(email, token, expiresAt, checkoutId) {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.EMAIL_FROM?.trim();
  if (!apiKey || !from || !email) return false;

  const url = new URL("https://quizpatente.realb.it/");
  url.hash = `plus_token=${encodeURIComponent(token)}`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `quizpatente-plus-activation/${checkoutId}`,
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
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error((await response.text()).slice(0, 500));
  return true;
}

function fulfillmentError(message, statusCode) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function revokedPaymentError(revocation) {
  const error = fulfillmentError("Questo pagamento è stato revocato.", 410);
  if (
    revocation?.active === true &&
    (revocation.reason === "charge.refunded" ||
      revocation.reason === "charge.dispute.closed")
  ) {
    error.code = TERMINAL_REVOCATION_ERROR_CODE;
  }
  return error;
}

module.exports = {
  TERMINAL_REVOCATION_ERROR_CODE,
  fulfillPlusCheckout,
  loadPlusPaymentByIntent,
  loadPlusPaymentRevocation,
  recordPlusPaymentRevocation,
  syncPlusPaymentRevocation,
};
