const crypto = require("node:crypto");
const { query } = require("./db");

const BUCKET = "quizpatente-stripe-payment-locks";

async function claimPlusPayment(paymentIntentId) {
  const normalizedId = normalizePaymentIntentId(paymentIntentId);
  const claimId = crypto.randomUUID();
  const path = `payment-intents/${normalizedId}.json`;
  const rows = await query(
    `insert into app_kv_objects (namespace, object_key, payload)
     values (
       $1,
       $2,
       jsonb_build_object(
         'version', 1,
         'paymentIntentId', $3::text,
         'claimId', $4::text,
         'claimedAt', now(),
         'leaseUntil', now() + interval '10 minutes'
       )
     )
     on conflict (namespace, object_key) do update
       set payload = excluded.payload, updated_at = now()
       where nullif(app_kv_objects.payload->>'leaseUntil', '')::timestamptz
             <= now()
     returning payload`,
    [BUCKET, path, normalizedId, claimId],
  );
  return rows.length > 0 ? { path, claimId } : null;
}

async function releasePlusPayment(claim) {
  if (!claim) return;
  await query(
    `delete from app_kv_objects
      where namespace = $1
        and object_key = $2
        and payload->>'claimId' = $3`,
    [BUCKET, claim.path, claim.claimId],
  );
}

function normalizePaymentIntentId(value) {
  const id = String(value || "").trim();
  if (!/^pi_[A-Za-z0-9_]{8,240}$/.test(id)) {
    const error = new Error("PaymentIntent Stripe non valido.");
    error.publicMessage = "Riferimento del pagamento non valido.";
    error.statusCode = 400;
    throw error;
  }
  return id;
}

module.exports = { claimPlusPayment, releasePlusPayment };
