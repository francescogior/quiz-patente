const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("anonymous visitors receive one persistent demo question and a passwordless gate", () => {
  const app = read("app.js");
  const html = read("index.html");

  assert.match(app, /DEMO_STORAGE_KEY = "quiz-patente-demo-v1"/);
  assert.match(
    app,
    /restoreDemoSession\(\) \?\? createExam\(\{ mode: "demo", count: 1 \}\)/,
  );
  assert.match(app, /if \(state\.mode === "demo"\) \{\s*finishExam\("demo"\);/);
  assert.match(
    app,
    /if \(state\.mode === "demo"\) \{\s*persistSession\(\);\s*renderResults\(\);/,
  );
  assert.match(
    app,
    /function startNewExam\(\) \{\s*if \(!authState\.user\) \{\s*promptDemoRegistration\(\);/,
  );
  assert.match(html, /id="demoRegistrationCard"/);
  assert.match(html, /id="demoRegisterButton"/);
  assert.match(html, /id="emailLoginForm"/);
  assert.match(html, /autocomplete="one-time-code"/);
});

test("full local quiz sessions are scoped to the authenticated account", () => {
  const app = read("app.js");
  assert.match(app, /STORAGE_KEY_PREFIX = "quiz-patente-session-v2"/);
  assert.match(
    app,
    /return userId \? `\$\{STORAGE_KEY_PREFIX\}:\$\{userId\}` : null/,
  );
  assert.match(app, /state = restoreSession\(\) \?\? createExam\(\)/);
  assert.match(
    app,
    /state = restoreSession\(\) \?\? createExam\(\);\s*localStorage\.removeItem\(LEGACY_STORAGE_KEY\);\s*localStorage\.removeItem\(DEMO_STORAGE_KEY\);\s*persistSession\(\)/,
  );
  assert.match(app, /localStorage\.removeItem\(DEMO_STORAGE_KEY\)/);
});

test("expired authenticated sessions immediately return to the anonymous demo", () => {
  const app = read("app.js");

  assert.match(app, /function resetToAnonymousDemo\(\)/);
  assert.match(
    app,
    /if \(error\.status === 401\) \{\s*resetToAnonymousDemo\(\);/,
  );
  assert.match(
    app,
    /state = createExam\(\{ mode: "demo", count: 1 \}\);\s*persistSession\(\)/,
  );
});

test("late protected responses cannot mutate a newer account", () => {
  const app = read("app.js");

  assert.match(app, /const requestContext = captureAuthContext\(\)/);
  assert.match(
    app,
    /if \(error\.stale \|\| !isCurrentAuthContext\(requestContext\)\)/,
  );
  assert.match(
    app,
    /if \(!isCurrentAuthContext\(requestContext\)\) throw staleRequestError\(\)/,
  );
  assert.match(
    app,
    /storePlusTokenForUser\(requestContext\.userId, response\.token\)/,
  );
  assert.match(app, /const requestPlusToken =/);
  assert.match(
    app,
    /plusState\.token !== requestPlusToken \|\|\s*accessEpoch !== requestAccessEpoch/,
  );
});

test("Free stays Italian-only and does not mount explanation panels", () => {
  const app = read("app.js");
  const html = read("index.html");

  assert.match(
    app,
    /if \(\s*!authState\.user \|\|\s*!hasActivePlus\(\) \|\|\s*!language \|\|\s*language\.code === "it"\s*\)/,
  );
  assert.match(
    app,
    /els\.questionPlusButton\.hidden = !isSignedIn \|\| hasPlus/,
  );
  assert.match(
    app,
    /if \(state\.mode !== "demo" && authState\.user && !hasActivePlus\(\)\)/,
  );
  assert.match(
    app,
    /if \(hasActivePlus\(\)\) \{\s*const explanation = createAiExplanationPanel/,
  );
  assert.match(html, /id="translationUpgrade"/);
  assert.match(
    html,
    /La versione Free usa il testo ministeriale originale in italiano/,
  );
});

test("Plus cache reads are protected before either API returns content", () => {
  const explanation = read("api/explanation.js");
  const translation = read("api/translation.js");

  assert.ok(
    explanation.indexOf("authenticateRequest(req)") <
      explanation.indexOf("findCachedExplanation"),
  );
  assert.ok(
    explanation.indexOf("requirePlusAccess(req, user)") <
      explanation.indexOf("findCachedExplanation"),
  );
  assert.ok(
    translation.indexOf("requirePlusAccess(req, user)") <
      translation.indexOf("findCachedTranslation"),
  );
});

test("Plus explanations load only after an explicit details toggle", () => {
  const app = read("app.js");
  assert.doesNotMatch(app, /IntersectionObserver/);
  assert.match(app, /const panel = document\.createElement\("details"\)/);
  assert.match(app, /panel\.addEventListener\("toggle"/);
  assert.match(
    app,
    /if \(!panel\.open \|\| panel\.dataset\.explanationLoaded === "true"\) return/,
  );
  assert.match(app, /loadExplanationPanel\(panel\)/);
  assert.match(app, /const pendingExplanationLoads = new Map\(\)/);
  assert.match(app, /let request = pendingExplanationLoads\.get\(questionId\)/);
  assert.match(app, /!panel\.isConnected/);
});

test("the published copy describes the new Free and Plus boundary", () => {
  const terms = read("terms.html");
  const plusAccess = read("lib/plus-access.js");

  assert.match(
    terms,
    /Con un account\s+Free puoi svolgere le simulazioni complete in italiano/,
  );
  assert.match(
    terms,
    /Spiegazioni e traduzioni in altre lingue\s+richiedono Plus/,
  );
  assert.match(
    plusAccess,
    /Spiegazioni e traduzioni sono disponibili con Quiz Patente Plus/,
  );
});
