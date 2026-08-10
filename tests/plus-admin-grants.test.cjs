const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const root = path.resolve(__dirname, "..");

function installStub(relativePath, exports) {
  const filename = require.resolve(path.join(root, relativePath));
  const previous = require.cache[filename];
  require.cache[filename] = {
    id: filename,
    filename,
    loaded: true,
    exports,
  };
  return () => {
    if (previous) require.cache[filename] = previous;
    else delete require.cache[filename];
  };
}

test("manual Plus grants are fixed, atomic, idempotent and account-scoped", async () => {
  const records = new Map();
  const targetLocks = new Map();
  let claimCount = 0;
  const restoreKv = installStub("lib/db-kv.js", {
    async readJson(namespace, objectKey) {
      assert.equal(namespace, "quizpatente-plus-admin-grants");
      return records.get(objectKey) || null;
    },
  });
  const restoreDb = installStub("lib/db.js", {
    async query(sql, params) {
      if (sql.includes("'leaseUntil', now() + interval '1 minute'")) {
        if (targetLocks.has(params[1])) return [];
        targetLocks.set(params[1], params[2]);
        return [{ payload: { claimId: params[2] } }];
      }
      if (sql.includes("where exists")) {
        claimCount += 1;
        if (targetLocks.get(params[3]) !== params[4]) return [];
        if (records.has(params[1])) return [];
        records.set(params[1], JSON.parse(params[2]));
        return [{ object_key: params[1] }];
      }
      if (sql.includes("delete from app_kv_objects")) {
        if (targetLocks.get(params[1]) === params[2]) {
          targetLocks.delete(params[1]);
        }
        return [];
      }
      const values = [...records.values()];
      if (sql.includes("payload->>'targetUserId' = $2")) {
        return values
          .filter((value) => value.targetUserId === params[1])
          .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))
          .map((payload) => ({ payload }));
      }
      if (sql.includes("payload->>'targetUserId' = any")) {
        return values
          .filter((value) => params[1].includes(value.targetUserId))
          .sort((a, b) => b.expiresAt.localeCompare(a.expiresAt))
          .map((payload) => ({ payload }));
      }
      if (sql.includes("object_key like 'requests/%'")) {
        return values.map((payload) => ({ payload }));
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  const modulePath = require.resolve(
    path.join(root, "lib/plus-admin-grants.js"),
  );
  delete require.cache[modulePath];

  try {
    const {
      grantManualPlus,
      loadActiveManualPlusGrant,
      loadManualPlusGrantAudit,
      loadManualPlusGrantsForUsers,
    } = require(modulePath);
    const targetUser = { id: "user-one", email: "one@example.com" };
    const adminUser = { id: "admin-one", email: "admin@example.com" };
    const requestId = "11111111-1111-4111-8111-111111111111";

    const result = await grantManualPlus({
      targetUser,
      adminUser,
      requestId,
      currentEntitlement: null,
    });
    assert.equal(result.granted, true);
    assert.equal(result.replayed, false);
    assert.equal(result.entitlement.active, true);
    assert.equal(result.entitlement.source, "manual_admin");
    assert.equal(result.entitlement.checkoutId, `manual:${requestId}`);
    assert.equal(
      new Date(result.grant.expiresAt).getTime() -
        new Date(result.grant.validFrom).getTime(),
      30 * 24 * 60 * 60 * 1000,
    );
    assert.equal(claimCount, 1);

    const replay = await grantManualPlus({
      targetUser,
      adminUser,
      requestId,
      currentEntitlement: null,
    });
    assert.equal(replay.granted, false);
    assert.equal(replay.replayed, true);
    assert.equal(replay.grant.expiresAt, result.grant.expiresAt);
    assert.equal(claimCount, 1);

    await assert.rejects(
      grantManualPlus({
        targetUser: { id: "user-two", email: "two@example.com" },
        adminUser,
        requestId,
        currentEntitlement: null,
      }),
      (error) => error.statusCode === 409,
    );

    const alreadyActive = await grantManualPlus({
      targetUser,
      adminUser,
      requestId: "22222222-2222-4222-8222-222222222222",
      currentEntitlement: {
        active: true,
        source: "stripe",
        expiresAt: new Date(Date.now() + 100_000).toISOString(),
      },
    });
    assert.equal(alreadyActive.reason, "already_active");
    assert.equal(claimCount, 1);

    const loaded = await loadActiveManualPlusGrant(targetUser);
    assert.equal(loaded.source, "manual_admin");
    const batch = await loadManualPlusGrantsForUsers([
      targetUser,
      { id: "user-two", email: "two@example.com" },
    ]);
    assert.equal(batch["user-one"].grantRequestId, requestId);
    assert.equal(batch["user-two"], undefined);
    const audit = await loadManualPlusGrantAudit();
    assert.equal(audit.length, 1);
    assert.equal(audit[0].grantedByUserId, adminUser.id);

    let continueFirstGrant;
    let markFirstGrantEntered;
    const firstGrantEntered = new Promise((resolve) => {
      markFirstGrantEntered = resolve;
    });
    const firstGrantGate = new Promise((resolve) => {
      continueFirstGrant = resolve;
    });
    const concurrentTarget = {
      id: "user-concurrent",
      email: "concurrent@example.com",
    };
    const firstConcurrent = grantManualPlus({
      targetUser: concurrentTarget,
      adminUser,
      requestId: "33333333-3333-4333-8333-333333333333",
      loadCurrentEntitlement: async () => {
        markFirstGrantEntered();
        await firstGrantGate;
        return null;
      },
    });
    await firstGrantEntered;
    await assert.rejects(
      grantManualPlus({
        targetUser: concurrentTarget,
        adminUser,
        requestId: "44444444-4444-4444-8444-444444444444",
        loadCurrentEntitlement: async () => null,
      }),
      (error) => error.statusCode === 409,
    );
    continueFirstGrant();
    assert.equal((await firstConcurrent).granted, true);
    assert.equal(targetLocks.size, 0);

    let continueFencedGrant;
    let markFencedGrantEntered;
    const fencedGrantEntered = new Promise((resolve) => {
      markFencedGrantEntered = resolve;
    });
    const fencedGrantGate = new Promise((resolve) => {
      continueFencedGrant = resolve;
    });
    const fencedTarget = {
      id: "user-fenced",
      email: "fenced@example.com",
    };
    const fencedRequestId = "66666666-6666-4666-8666-666666666666";
    const fencedGrant = grantManualPlus({
      targetUser: fencedTarget,
      adminUser,
      requestId: fencedRequestId,
      loadCurrentEntitlement: async () => {
        markFencedGrantEntered();
        await fencedGrantGate;
        return null;
      },
    });
    await fencedGrantEntered;
    const fencedLockKey = `locks/users/${fencedTarget.id}.json`;
    targetLocks.set(fencedLockKey, "takeover-owner");
    continueFencedGrant();
    await assert.rejects(fencedGrant, (error) => error.statusCode === 409);
    assert.equal(records.has(`requests/${fencedRequestId}.json`), false);
    assert.equal(targetLocks.get(fencedLockKey), "takeover-owner");
    targetLocks.delete(fencedLockKey);
  } finally {
    delete require.cache[modulePath];
    restoreDb();
    restoreKv();
  }
});
