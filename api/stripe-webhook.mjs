import { createRequire } from "node:module";
import crypto from "node:crypto";

const require = createRequire(import.meta.url);
const { readJson: readStoredJson } = require("../lib/db-kv");
const { query } = require("../lib/db");
const {
  claimPlusPayment,
  releasePlusPayment,
} = require("../lib/plus-payment-lock");
const {
  TERMINAL_REVOCATION_ERROR_CODE,
  fulfillPlusCheckout,
  recordPlusPaymentRevocation,
} = require("../lib/plus-fulfillment");
const { PRODUCT_SLUG } = require("../lib/plus-access");
const {
  restorePlusEntitlement,
  revokePlusEntitlement,
} = require("../lib/plus-entitlements");
const {
  constructStripeWebhookEvent,
  retrieveCheckoutSessionByPaymentIntent,
  retrievePlusCheckoutSession,
  validatePlusCheckoutSession,
} = require("../lib/stripe-checkout");
const {
  findUserByEmail,
  findUserById,
  publicError,
} = require("../lib/user-store");

const EVENTS_BUCKET = "quizpatente-stripe-events";
const CHECKOUT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);
const REVOCATION_EVENTS = new Set([
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
]);

export default {
  async fetch(request) {
    if (request.method !== "POST") {
      return json(405, { error: "Metodo non supportato." });
    }

    let eventClaim = null;
    let paymentClaim = null;
    try {
      const rawBody = Buffer.from(await request.arrayBuffer());
      if (rawBody.length > 1_000_000) {
        throw webhookError("Webhook troppo grande.", 413);
      }
      const signature = request.headers.get("stripe-signature") || "";
      let event;
      try {
        event = constructStripeWebhookEvent(rawBody, signature);
      } catch {
        throw webhookError("Firma webhook non valida.", 400);
      }

      if (
        !CHECKOUT_EVENTS.has(event.type) &&
        !REVOCATION_EVENTS.has(event.type)
      ) {
        return json(200, { received: true, ignored: true });
      }
      const eventPath = `events/${event.id}.json`;
      eventClaim = await claimEvent(eventPath, event);
      if (!eventClaim) {
        const existing = await readStoredJson(EVENTS_BUCKET, eventPath);
        if (existing?.outcome && existing.outcome !== "processing") {
          return json(200, { received: true, duplicate: true });
        }
        return json(409, { error: "Evento Stripe già in elaborazione." });
      }

      if (REVOCATION_EVENTS.has(event.type)) {
        const paymentIntentId = stripeId(event.data?.object?.payment_intent);
        if (!paymentIntentId) {
          await recordEvent(
            eventPath,
            event,
            eventClaim,
            "ignored_missing_payment_intent",
          );
          return json(200, { received: true, ignored: true });
        }
        paymentClaim = await claimPlusPayment(paymentIntentId);
        if (!paymentClaim) {
          throw webhookError(
            "Un altro evento di questo pagamento è in elaborazione.",
            409,
          );
        }
        try {
          const eventObject = event.data?.object || {};
          const { payment, revocation } = await recordPlusPaymentRevocation(
            paymentIntentId,
            {
              reason: event.type,
              eventId: event.id,
              objectId: eventObject.id,
              status: eventObject.status,
              eventCreated: event.created,
            },
          );
          const applyEntitlementState = (user, checkoutId) =>
            revocation
              ? revokePlusEntitlement(user, {
                  checkoutId,
                  reason: revocation.reason,
                  eventId: revocation.eventId,
                })
              : restorePlusEntitlement(user, {
                  checkoutId,
                  eventId: event.id,
                });
          if (!payment) {
            const session =
              await retrieveCheckoutSessionByPaymentIntent(paymentIntentId);
            const metadata = session?.metadata || {};
            const isQuizPatente =
              (metadata.app_slug === "quizpatente" &&
                metadata.product_slug === PRODUCT_SLUG) ||
              metadata.experiment_slug === PRODUCT_SLUG;
            if (session && isQuizPatente) {
              const user = metadata.user_id
                ? await findUserById(metadata.user_id)
                : await findUserByEmail(
                    session.customer_details?.email ||
                      session.customer_email ||
                      event.data?.object?.billing_details?.email,
                  );
              const entitlement = user
                ? await applyEntitlementState(user, session.id)
                : null;
              if (entitlement) {
                const outcome = revocation
                  ? "revoked_recovered_checkout"
                  : "restored_recovered_checkout";
                await recordEvent(eventPath, event, eventClaim, outcome);
                return json(200, {
                  received: true,
                  revoked: Boolean(revocation),
                  restored: !revocation,
                });
              }
            }
            await recordEvent(
              eventPath,
              event,
              eventClaim,
              revocation ? "revocation_tombstone" : "dispute_resolved",
            );
            return json(200, { received: true, ignored: true });
          }
          const user = await findUserById(payment.userId);
          if (!user) {
            throw webhookError("Account del pagamento non trovato.", 409);
          }
          await applyEntitlementState(user, payment.sessionId);
          await recordEvent(
            eventPath,
            event,
            eventClaim,
            revocation ? "revoked" : "restored",
          );
          return json(200, {
            received: true,
            revoked: Boolean(revocation),
            restored: !revocation,
          });
        } finally {
          await releasePlusPayment(paymentClaim);
          paymentClaim = null;
        }
      }

      const eventSession = event.data?.object;
      const productSlug =
        eventSession?.metadata?.product_slug ||
        eventSession?.metadata?.experiment_slug;
      if (productSlug !== PRODUCT_SLUG) {
        await recordEvent(eventPath, event, eventClaim, "ignored");
        return json(200, { received: true, ignored: true });
      }

      if (
        event.type === "checkout.session.completed" ||
        event.type === "checkout.session.async_payment_succeeded"
      ) {
        const session = await retrievePlusCheckoutSession(eventSession.id);
        if (session.payment_status === "paid") {
          const userId = String(session.metadata?.user_id || "");
          if (!userId && session.metadata?.experiment_slug === PRODUCT_SLUG) {
            await recordEvent(eventPath, event, eventClaim, "ignored_legacy");
            return json(200, { received: true, ignored: true });
          }
          const user = userId ? await findUserById(userId) : null;
          if (!user) {
            throw webhookError("Account del pagamento non trovato.", 409);
          }
          const checkout = validatePlusCheckoutSession(session, user, {
            requirePaid: true,
          });
          try {
            await fulfillPlusCheckout(user, checkout);
          } catch (error) {
            if (error?.code !== TERMINAL_REVOCATION_ERROR_CODE) throw error;
            await recordEvent(
              eventPath,
              event,
              eventClaim,
              "not_fulfilled_revoked",
            );
            return json(200, { received: true, revoked: true });
          }
        }
      }

      await recordEvent(eventPath, event, eventClaim, "processed");
      return json(200, { received: true });
    } catch (error) {
      if (paymentClaim) {
        await releasePlusPayment(paymentClaim).catch((releaseError) => {
          console.error("Stripe payment claim release failed", {
            message: releaseError.message,
          });
        });
      }
      if (eventClaim) {
        await releaseEventClaim(eventClaim).catch((releaseError) => {
          console.error("Stripe event claim release failed", {
            message: releaseError.message,
          });
        });
      }
      const response = publicError(error, "Webhook Stripe non elaborato.");
      return json(response.statusCode, response.payload);
    }
  },
};

async function claimEvent(path, event) {
  const claimId = crypto.randomUUID();
  const payload = {
    version: 1,
    eventId: String(event.id),
    type: String(event.type),
    livemode: Boolean(event.livemode),
    outcome: "processing",
    claimId,
  };
  const rows = await query(
    `insert into app_kv_objects (namespace, object_key, payload)
     values (
       $1,
       $2,
       $3::jsonb || jsonb_build_object(
         'claimedAt', now(),
         'leaseUntil', now() + interval '10 minutes'
       )
     )
     on conflict (namespace, object_key) do update
       set payload = excluded.payload, updated_at = now()
       where app_kv_objects.payload->>'outcome' = 'processing'
         and nullif(app_kv_objects.payload->>'leaseUntil', '')::timestamptz <= now()
     returning payload`,
    [EVENTS_BUCKET, path, JSON.stringify(payload)],
  );
  return rows.length > 0 ? { path, claimId } : null;
}

async function recordEvent(path, event, claim, outcome) {
  const payload = {
    version: 1,
    eventId: String(event.id),
    type: String(event.type),
    livemode: Boolean(event.livemode),
    outcome,
    processedAt: new Date().toISOString(),
  };
  const rows = await query(
    `update app_kv_objects
        set payload = $4::jsonb, updated_at = now()
      where namespace = $1
        and object_key = $2
        and payload->>'claimId' = $3
      returning object_key`,
    [EVENTS_BUCKET, path, claim.claimId, JSON.stringify(payload)],
  );
  if (rows.length !== 1) {
    throw webhookError("Lease webhook Stripe non più valida.", 409);
  }
}

async function releaseEventClaim(claim) {
  await query(
    `delete from app_kv_objects
      where namespace = $1
        and object_key = $2
        and payload->>'claimId' = $3`,
    [EVENTS_BUCKET, claim.path, claim.claimId],
  );
}

function json(status, payload) {
  return Response.json(payload, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function webhookError(message, statusCode) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function stripeId(value) {
  return typeof value === "string" ? value : value?.id || null;
}
