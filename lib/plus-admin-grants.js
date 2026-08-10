const crypto = require("node:crypto");
const { query } = require("./db");
const { readJson } = require("./db-kv");

const BUCKET = "quizpatente-plus-admin-grants";
const SOURCE = "manual_admin";
const ADMIN_GRANT_DAYS = 30;

async function grantManualPlus({
  targetUser,
  adminUser,
  requestId,
  currentEntitlement,
  loadCurrentEntitlement,
}) {
  const normalizedRequestId = String(requestId || "")
    .trim()
    .toLowerCase();
  if (
    !targetUser?.id ||
    !targetUser?.email ||
    !adminUser?.id ||
    !isUuid(normalizedRequestId)
  ) {
    throw grantError("Richiesta di attivazione non valida.");
  }

  const objectKey = grantPath(normalizedRequestId);
  let existing = await readGrant(objectKey);
  if (existing) {
    assertSameGrant(existing, targetUser, adminUser);
    return {
      granted: false,
      replayed: true,
      reason: "replayed",
      grant: existing,
      entitlement: toManualEntitlement(existing),
    };
  }

  const targetClaim = await claimGrantTarget(targetUser.id);
  if (!targetClaim) {
    throw grantError(
      "Un’altra attivazione Plus è in corso per questo utente. Riprova.",
      409,
    );
  }

  try {
    existing = await readGrant(objectKey);
    if (existing) {
      assertSameGrant(existing, targetUser, adminUser);
      return {
        granted: false,
        replayed: true,
        reason: "replayed",
        grant: existing,
        entitlement: toManualEntitlement(existing),
      };
    }

    const effectiveEntitlement = loadCurrentEntitlement
      ? await loadCurrentEntitlement()
      : currentEntitlement;
    if (effectiveEntitlement?.active) {
      return {
        granted: false,
        replayed: false,
        reason: "already_active",
        grant: null,
        entitlement: effectiveEntitlement,
      };
    }

    const validFrom = new Date();
    const record = {
      version: 1,
      status: "granted",
      requestId: normalizedRequestId,
      grantId: `manual:${normalizedRequestId}`,
      source: SOURCE,
      targetUserId: String(targetUser.id),
      grantedByUserId: String(adminUser.id),
      durationDays: ADMIN_GRANT_DAYS,
      validFrom: validFrom.toISOString(),
      expiresAt: new Date(
        validFrom.getTime() + ADMIN_GRANT_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
      createdAt: validFrom.toISOString(),
    };

    const claimed = await claimGrantRecord(objectKey, record, targetClaim);
    existing = claimed ? record : await readGrant(objectKey);
    if (!existing) {
      throw grantError(
        "L’attivazione Plus è stata superata da un’altra richiesta. Riprova.",
        409,
      );
    }
    assertSameGrant(existing, targetUser, adminUser);
    return {
      granted: claimed,
      replayed: !claimed,
      reason: claimed ? "granted" : "replayed",
      grant: existing,
      entitlement: toManualEntitlement(existing),
    };
  } catch (error) {
    if (error.statusCode) throw error;
    throw storageUnavailable(error.message);
  } finally {
    await releaseGrantTarget(targetClaim).catch((error) => {
      console.error("Manual Plus target lock release failed", {
        message: error.message,
      });
    });
  }
}

async function claimGrantRecord(objectKey, record, targetClaim) {
  try {
    const rows = await query(
      `insert into app_kv_objects (namespace, object_key, payload)
       select $1, $2, $3::jsonb
        where exists (
          select 1
            from app_kv_objects
           where namespace = $1
             and object_key = $4
             and payload->>'claimId' = $5
           for update
        )
       on conflict (namespace, object_key) do nothing
       returning object_key`,
      [
        BUCKET,
        objectKey,
        JSON.stringify(record),
        targetClaim.objectKey,
        targetClaim.claimId,
      ],
    );
    return rows.length > 0;
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function claimGrantTarget(targetUserId) {
  const claimId = crypto.randomUUID();
  const objectKey = `locks/users/${String(targetUserId)}.json`;
  try {
    const rows = await query(
      `insert into app_kv_objects (namespace, object_key, payload)
       values (
         $1,
         $2,
         jsonb_build_object(
           'version', 1,
           'claimId', $3::text,
           'targetUserId', $4::text,
           'claimedAt', now(),
           'leaseUntil', now() + interval '1 minute'
         )
       )
       on conflict (namespace, object_key) do update
         set payload = excluded.payload, updated_at = now()
         where coalesce(
                 nullif(app_kv_objects.payload->>'leaseUntil', '')::timestamptz,
                 '-infinity'::timestamptz
               ) <= now()
       returning payload`,
      [BUCKET, objectKey, claimId, String(targetUserId)],
    );
    return rows.length > 0 ? { objectKey, claimId } : null;
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function releaseGrantTarget(claim) {
  if (!claim) return;
  await query(
    `delete from app_kv_objects
      where namespace = $1
        and object_key = $2
        and payload->>'claimId' = $3`,
    [BUCKET, claim.objectKey, claim.claimId],
  );
}

async function loadActiveManualPlusGrant(user) {
  if (!user?.id) return null;
  try {
    const rows = await query(
      `select payload
         from app_kv_objects
        where namespace = $1
          and payload->>'status' = 'granted'
          and payload->>'targetUserId' = $2
        order by nullif(payload->>'expiresAt', '')::timestamptz desc
        limit 1`,
      [BUCKET, String(user.id)],
    );
    return toManualEntitlement(rows[0]?.payload);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function loadManualPlusGrantsForUsers(users = []) {
  const userIds = users.map((user) => String(user?.id || "")).filter(Boolean);
  if (userIds.length === 0) return {};
  try {
    const rows = await query(
      `select payload
         from app_kv_objects
        where namespace = $1
          and payload->>'status' = 'granted'
          and payload->>'targetUserId' = any($2::text[])
        order by nullif(payload->>'expiresAt', '')::timestamptz desc`,
      [BUCKET, userIds],
    );
    const byUser = {};
    rows.forEach((row) => {
      const record = normalizeGrant(row.payload);
      if (!record || byUser[record.targetUserId]) return;
      byUser[record.targetUserId] = toManualEntitlement(record);
    });
    return byUser;
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function loadManualPlusGrantAudit(limit = 120) {
  const safeLimit = Math.min(120, Math.max(1, Number(limit) || 120));
  try {
    const rows = await query(
      `select payload
         from app_kv_objects
        where namespace = $1
          and object_key like 'requests/%'
        order by created_at desc
        limit $2`,
      [BUCKET, safeLimit],
    );
    return rows.map((row) => normalizeGrant(row.payload)).filter(Boolean);
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

async function readGrant(objectKey) {
  try {
    return normalizeGrant(await readJson(BUCKET, objectKey));
  } catch (error) {
    throw storageUnavailable(error.message);
  }
}

function toManualEntitlement(value) {
  const record = normalizeGrant(value);
  if (!record) return null;
  const expiresAtMs = new Date(record.expiresAt).getTime();
  return {
    active: expiresAtMs > Date.now(),
    source: SOURCE,
    checkoutId: record.grantId,
    paidAt: record.validFrom,
    expiresAt: record.expiresAt,
    grantedAt: record.validFrom,
    grantedByUserId: record.grantedByUserId,
    grantRequestId: record.requestId,
    activationEmailedAt: null,
    revokedAt: null,
    revocationReason: null,
  };
}

function normalizeGrant(value) {
  if (!value || value.version !== 1 || value.status !== "granted") return null;
  const validFrom = new Date(value.validFrom || "");
  const expiresAt = new Date(value.expiresAt || "");
  if (
    !isUuid(value.requestId) ||
    value.grantId !== `manual:${value.requestId}` ||
    value.source !== SOURCE ||
    !value.targetUserId ||
    !value.grantedByUserId ||
    Number(value.durationDays) !== ADMIN_GRANT_DAYS ||
    Number.isNaN(validFrom.getTime()) ||
    Number.isNaN(expiresAt.getTime())
  ) {
    return null;
  }
  return {
    version: 1,
    status: "granted",
    requestId: String(value.requestId),
    grantId: String(value.grantId),
    source: SOURCE,
    targetUserId: String(value.targetUserId),
    grantedByUserId: String(value.grantedByUserId),
    durationDays: ADMIN_GRANT_DAYS,
    validFrom: validFrom.toISOString(),
    expiresAt: expiresAt.toISOString(),
    createdAt: value.createdAt || validFrom.toISOString(),
  };
}

function assertSameGrant(grant, targetUser, adminUser) {
  if (
    grant.targetUserId !== String(targetUser.id) ||
    grant.grantedByUserId !== String(adminUser.id)
  ) {
    throw grantError("Identificativo richiesta già utilizzato.", 409);
  }
}

function grantPath(requestId) {
  return `requests/${requestId}.json`;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

function grantError(message, statusCode = 400) {
  const error = new Error(message);
  error.publicMessage = message;
  error.statusCode = statusCode;
  return error;
}

function storageUnavailable(details) {
  const error = new Error(details || "Archivio grant Plus non disponibile.");
  error.publicMessage = "Non riesco ad attivare Plus. Riprova tra poco.";
  error.statusCode = 503;
  return error;
}

module.exports = {
  ADMIN_GRANT_DAYS,
  grantManualPlus,
  loadActiveManualPlusGrant,
  loadManualPlusGrantAudit,
  loadManualPlusGrantsForUsers,
  toManualEntitlement,
};
