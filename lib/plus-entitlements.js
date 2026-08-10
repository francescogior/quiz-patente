const crypto = require("node:crypto");
const { readJson } = require("./db-kv");
const { query } = require("./db");

const BUCKET = "quizpatente-plus-entitlements";
async function loadPlusEntitlement(user) {
  try {
    return normalizeEntitlement(await readJson(BUCKET, entitlementPath(user)));
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function savePlusEntitlement(user, access) {
  const nextExpiry = new Date(access.expiresAt || "").getTime();
  if (!Number.isFinite(nextExpiry)) {
    throw storageUnavailable("Scadenza entitlement non valida.");
  }
  const next = {
    version: 1,
    checkoutId: String(access.checkoutId || "").slice(0, 128),
    paidAt: new Date(access.paidAt).toISOString(),
    expiresAt: new Date(access.expiresAt).toISOString(),
    activationEmailedAt: null,
    activationEmailClaimId: null,
    activationEmailClaimedAt: null,
    revokedAt: null,
    revocationReason: null,
    revocationEventId: null,
    updatedAt: new Date().toISOString(),
  };

  try {
    const rows = await query(
      `insert into app_kv_objects (namespace, object_key, payload)
       values ($1, $2, $3::jsonb)
       on conflict (namespace, object_key) do update set
         payload = case
           when coalesce(
             nullif(app_kv_objects.payload->>'expiresAt', '')::timestamptz,
             '-infinity'::timestamptz
           ) <= (excluded.payload->>'expiresAt')::timestamptz
           then excluded.payload || jsonb_build_object(
             'activationEmailedAt',
             case
               when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
               then app_kv_objects.payload->'activationEmailedAt'
               else 'null'::jsonb
             end
            , 'activationEmailClaimId',
            case
              when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
              then app_kv_objects.payload->'activationEmailClaimId'
              else 'null'::jsonb
            end
            , 'activationEmailClaimedAt',
            case
              when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
              then app_kv_objects.payload->'activationEmailClaimedAt'
              else 'null'::jsonb
            end
            , 'revokedAt',
            case
              when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
              then app_kv_objects.payload->'revokedAt'
              else 'null'::jsonb
            end
            , 'revocationReason',
            case
              when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
              then app_kv_objects.payload->'revocationReason'
              else 'null'::jsonb
            end
            , 'revocationEventId',
            case
              when app_kv_objects.payload->>'checkoutId' = excluded.payload->>'checkoutId'
              then app_kv_objects.payload->'revocationEventId'
              else 'null'::jsonb
            end
           )
           else app_kv_objects.payload
         end,
         updated_at = now()
       returning payload`,
      [BUCKET, entitlementPath(user), JSON.stringify(next)],
    );
    return normalizeEntitlement(rows[0]?.payload);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function claimEntitlementEmail(user, entitlement) {
  const claimId = crypto.randomUUID();
  const claimedAt = new Date().toISOString();
  try {
    const rows = await query(
      `update app_kv_objects
          set payload = payload || jsonb_build_object(
                'activationEmailClaimId', $4::text,
                'activationEmailClaimedAt', $5::text,
                'updatedAt', $5::text
              ),
              updated_at = now()
        where namespace = $1
          and object_key = $2
          and payload->>'checkoutId' = $3
          and nullif(payload->>'activationEmailedAt', '') is null
          and nullif(payload->>'revokedAt', '') is null
          and nullif(payload->>'expiresAt', '')::timestamptz > now()
          and (
            nullif(payload->>'activationEmailClaimId', '') is null
            or nullif(payload->>'activationEmailClaimedAt', '')::timestamptz
                 < now() - interval '10 minutes'
          )
        returning payload`,
      [
        BUCKET,
        entitlementPath(user),
        String(entitlement.checkoutId),
        claimId,
        claimedAt,
      ],
    );
    return rows.length > 0 ? claimId : null;
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function markEntitlementEmailed(user, entitlement, claimId) {
  try {
    await query(
      `update app_kv_objects
          set payload = (
                payload || jsonb_build_object(
                  'activationEmailedAt', $5::text,
                  'updatedAt', $5::text
                )
              ) - 'activationEmailClaimId' - 'activationEmailClaimedAt',
              updated_at = now()
        where namespace = $1
          and object_key = $2
          and payload->>'checkoutId' = $3
          and payload->>'activationEmailClaimId' = $4`,
      [
        BUCKET,
        entitlementPath(user),
        String(entitlement.checkoutId),
        String(claimId || ""),
        new Date().toISOString(),
      ],
    );
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function releaseEntitlementEmailClaim(user, entitlement, claimId) {
  try {
    await query(
      `update app_kv_objects
          set payload = (payload - 'activationEmailClaimId' - 'activationEmailClaimedAt')
                        || jsonb_build_object('updatedAt', $5::text),
              updated_at = now()
        where namespace = $1
          and object_key = $2
          and payload->>'checkoutId' = $3
          and payload->>'activationEmailClaimId' = $4`,
      [
        BUCKET,
        entitlementPath(user),
        String(entitlement.checkoutId),
        String(claimId || ""),
        new Date().toISOString(),
      ],
    );
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function revokePlusEntitlement(
  user,
  { checkoutId, reason, eventId } = {},
) {
  const revokedAt = new Date().toISOString();
  try {
    const normalizedReason = String(reason || "payment_revoked").slice(0, 80);
    const rows = await query(
      `update app_kv_objects
          set payload = case
                when payload->>'revocationReason' = 'charge.refunded'
                     and $5::text <> 'charge.refunded'
                then payload
                else payload || jsonb_build_object(
                  'revokedAt', $4::text,
                  'revocationReason', $5::text,
                  'revocationEventId', $6::text,
                  'updatedAt', $4::text
                )
              end,
              updated_at = now()
        where namespace = $1
          and object_key = $2
          and payload->>'checkoutId' = $3
        returning payload`,
      [
        BUCKET,
        entitlementPath(user),
        String(checkoutId || ""),
        revokedAt,
        normalizedReason,
        String(eventId || "").slice(0, 128),
      ],
    );
    return normalizeEntitlement(rows[0]?.payload);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function restorePlusEntitlement(user, { checkoutId, eventId } = {}) {
  const restoredAt = new Date().toISOString();
  try {
    const rows = await query(
      `update app_kv_objects
          set payload = (
                payload - 'revokedAt' - 'revocationReason' - 'revocationEventId'
              ) || jsonb_build_object(
                'restoredAt', $4::text,
                'restorationEventId', $5::text,
                'updatedAt', $4::text
              ),
              updated_at = now()
        where namespace = $1
          and object_key = $2
          and payload->>'checkoutId' = $3
          and payload->>'revocationReason' = 'charge.dispute.created'
        returning payload`,
      [
        BUCKET,
        entitlementPath(user),
        String(checkoutId || ""),
        restoredAt,
        String(eventId || "").slice(0, 128),
      ],
    );
    return normalizeEntitlement(rows[0]?.payload);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

function normalizeEntitlement(value) {
  if (!value || value.version !== 1) return null;
  const paidAt = new Date(value.paidAt || "");
  const expiresAt = new Date(value.expiresAt || "");
  const checkoutId = String(value.checkoutId || "");
  if (
    !checkoutId ||
    Number.isNaN(paidAt.getTime()) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return null;
  }
  return {
    active: expiresAt.getTime() > Date.now() && !value.revokedAt,
    checkoutId,
    paidAt: paidAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    activationEmailedAt: value.activationEmailedAt || null,
    revokedAt: value.revokedAt || null,
    revocationReason: value.revocationReason || null,
  };
}

function entitlementPath(user) {
  const key = requireEnv("APP_SECRET");
  const digest = crypto
    .createHmac("sha256", key)
    .update(
      `${user.id}:${String(user.email || "")
        .trim()
        .toLowerCase()}`,
    )
    .digest("hex");
  return `accounts/${digest}.json`;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw storageUnavailable(`${name} mancante.`);
  return value;
}

function storageUnavailable(details) {
  const error = new Error(details || "Archivio entitlement non disponibile.");
  error.publicMessage =
    "Non riesco a verificare l’accesso Plus. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  claimEntitlementEmail,
  loadPlusEntitlement,
  markEntitlementEmailed,
  releaseEntitlementEmailClaim,
  restorePlusEntitlement,
  revokePlusEntitlement,
  savePlusEntitlement,
};
