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

test("the admin dashboard exposes effective Plus status without payment identifiers", async () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  const createdAt = "2026-08-10T10:00:00.000Z";
  const expiresAt = "2026-09-09T10:00:00.000Z";
  const restoreQuestions = installStub("lib/question-bank.js", {
    getQuestion: () => null,
    getQuestionBankSettings: () => ({}),
  });
  const restoreLimits = installStub("lib/request-limits.js", {
    enforceExamResultWriteLimit: async () => {},
  });
  const restoreDb = installStub("lib/db.js", {
    async query(sql) {
      if (sql.includes("from app_users")) {
        return [
          {
            id: userId,
            email: "driver@example.com",
            created_at: createdAt,
            updated_at: createdAt,
          },
        ];
      }
      if (
        sql.includes("from app_login_codes") ||
        sql.includes("from app_sessions") ||
        sql.includes("from user_exam_results")
      ) {
        return [];
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  });
  const restoreGrants = installStub("lib/plus-admin-grants.js", {
    loadManualPlusGrantAudit: async () => [
      {
        version: 1,
        status: "granted",
        targetUserId: userId,
        durationDays: 30,
        validFrom: createdAt,
        createdAt,
      },
    ],
  });
  const restoreEntitlements = installStub("lib/plus-entitlements.js", {
    loadPlusEntitlementsForUsers: async () => ({
      [userId]: {
        active: true,
        source: "manual_admin",
        expiresAt,
        grantedAt: createdAt,
        checkoutId: "manual:private-grant-id",
        grantedByUserId: "private-admin-id",
      },
    }),
  });
  const storePath = require.resolve(path.join(root, "lib/user-store.js"));
  delete require.cache[storePath];

  try {
    const { getAdminDashboard } = require(storePath);
    const admin = await getAdminDashboard();
    assert.equal(admin.summary.plusUsers, 1);
    assert.deepEqual(admin.users[0].plus, {
      active: true,
      expiresAt,
      source: "manual_admin",
      grantedAt: createdAt,
      revokedAt: null,
      revocationReason: null,
    });
    assert.doesNotMatch(JSON.stringify(admin.users), /checkoutId|grantedBy/);
    const grantActivity = admin.activity.find(
      (activity) => activity.type === "plus_grant",
    );
    assert.equal(grantActivity.email, "driver@example.com");
  } finally {
    delete require.cache[storePath];
    restoreEntitlements();
    restoreGrants();
    restoreDb();
    restoreLimits();
    restoreQuestions();
  }
});
