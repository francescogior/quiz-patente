const fs = require("node:fs");
const path = require("node:path");

let cachedBank;
let cachedQuestions;

function getQuestion(questionId) {
  const id = Number(questionId);
  if (!Number.isInteger(id)) return null;
  ensureLoaded();
  return cachedQuestions.get(id) || null;
}

function getQuestionBankSettings() {
  ensureLoaded();
  return cachedBank.settings || { examQuestions: 30, examMinutes: 20, maxErrors: 3 };
}

function ensureLoaded() {
  if (cachedBank && cachedQuestions) return;
  const datasetPath = path.join(process.cwd(), "data", "questions.js");
  const source = fs.readFileSync(datasetPath, "utf8").trim();
  const prefix = "window.PATENTE_QUESTION_BANK = ";
  if (!source.startsWith(prefix)) throw new Error("Dataset non valido.");
  const json = source.slice(prefix.length).replace(/;$/, "");
  const bank = JSON.parse(json);
  if (!bank || !Array.isArray(bank.questions)) throw new Error("Dataset non valido.");
  cachedBank = bank;
  cachedQuestions = new Map(bank.questions.map((question) => [Number(question.id), question]));
}

module.exports = {
  getQuestion,
  getQuestionBankSettings,
};
