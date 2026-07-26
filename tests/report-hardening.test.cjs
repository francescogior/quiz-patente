const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { buildExplanationReport } = require("../lib/explanation-report");
const { getQuestion } = require("../lib/question-bank");

const root = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

test("report payloads keep only bounded metadata and same-site page paths", () => {
  const question = getQuestion(31059);
  const report = buildExplanationReport(question, {
    reason: "wrong",
    message: "  dettaglio\u0000utile  ",
    pageUrl: "https://evil.example/steal?token=secret",
    explanation: {
      model: "gpt-5-mini",
      promptVersion: "quiz-patente-explanation-v2",
      confidence: "alta",
      injected: { arbitrary: true },
    },
  });

  assert.equal(report.question_id, question.id);
  assert.equal(report.message, "dettaglio utile");
  assert.equal(report.page_url, "");
  assert.deepEqual(report.explanation_meta, {
    model: "gpt-5-mini",
    promptVersion: "quiz-patente-explanation-v2",
    confidence: "alta",
  });
});

test("invalid report reasons are rejected instead of silently rewritten", () => {
  assert.throws(
    () => buildExplanationReport(getQuestion(31059), { reason: "send-money" }),
    (error) => error.statusCode === 400,
  );
});

test("reporting and exam writes are wired to authentication and durable throttles", () => {
  const reportApi = read("api/report-explanation.js");
  const examApi = read("api/save-exam-result.js");
  const store = read("lib/user-store.js");
  const app = read("app.js");
  assert.match(reportApi, /authenticateRequest\(req\)/);
  assert.match(reportApi, /enforceExplanationReportLimit/);
  assert.match(app, /authFetch\("\.\/api\/report-explanation"/);
  assert.match(examApi, /saveExamResult\(user, body\)/);
  assert.match(store, /enforceExamResultWriteLimit\(user\)/);
});
