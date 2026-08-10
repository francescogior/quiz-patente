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

function responseRecorder() {
  return {
    statusCode: 0,
    payload: null,
    setHeader() {},
    end(value) {
      this.payload = JSON.parse(value);
    },
  };
}

test("cached explanations and translations still reject a Free account", async () => {
  let explanationCacheReads = 0;
  let translationCacheReads = 0;
  const plusError = () => {
    const error = new Error("Plus required");
    error.publicMessage =
      "Spiegazioni e traduzioni sono disponibili con Quiz Patente Plus.";
    error.statusCode = 402;
    throw error;
  };

  const restoreUserStore = installStub("lib/user-store.js", {
    authenticateRequest: async () => ({
      user: { id: "free-user", email: "free@example.com" },
    }),
    publicError(error, fallback) {
      return {
        statusCode: error.statusCode || 500,
        payload: { error: error.publicMessage || fallback },
      };
    },
    readJson: async (req) => req.body,
    sendJson(res, statusCode, payload) {
      res.statusCode = statusCode;
      res.payload = payload;
    },
  });
  const restorePlus = installStub("lib/plus-access.js", {
    requirePlusAccess: plusError,
  });
  const restoreUsage = installStub("lib/plus-usage.js", {
    consumePlusGeneration: async () => {
      throw new Error("generation must not start");
    },
  });
  const restoreDb = installStub("lib/db.js", {
    query: async () => {
      explanationCacheReads += 1;
      return [{ question_id: 21810 }];
    },
  });
  const restoreKv = installStub("lib/db-kv.js", {
    readJson: async () => {
      translationCacheReads += 1;
      return { questionText: "cached" };
    },
    writeJson: async () => {},
  });

  const explanationPath = require.resolve(
    path.join(root, "api/explanation.js"),
  );
  const translationPath = require.resolve(
    path.join(root, "api/translation.js"),
  );
  delete require.cache[explanationPath];
  delete require.cache[translationPath];

  try {
    const explanationHandler = require(explanationPath);
    const explanationResponse = responseRecorder();
    await explanationHandler(
      { method: "POST", body: { questionId: 21810 }, headers: {} },
      explanationResponse,
    );
    assert.equal(explanationResponse.statusCode, 402);
    assert.equal(explanationCacheReads, 0);

    const translationHandler = require(translationPath);
    const translationResponse = responseRecorder();
    await translationHandler(
      {
        method: "POST",
        body: {
          questionId: 21810,
          language: { code: "en", label: "Inglese" },
          explanation: "",
        },
        headers: {},
      },
      translationResponse,
    );
    assert.equal(translationResponse.statusCode, 402);
    assert.equal(translationCacheReads, 0);
  } finally {
    delete require.cache[explanationPath];
    delete require.cache[translationPath];
    restoreKv();
    restoreDb();
    restoreUsage();
    restorePlus();
    restoreUserStore();
  }
});
