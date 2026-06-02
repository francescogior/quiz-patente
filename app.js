const bank = window.PATENTE_QUESTION_BANK;

const STORAGE_KEY = "quiz-patente-session-v1";
const HISTORY_KEY = "quiz-patente-history-v1";
const settings = bank?.settings ?? { examQuestions: 30, examMinutes: 20, maxErrors: 3 };
const allQuestions = bank?.questions ?? [];

const els = {
  questionCounter: document.getElementById("questionCounter"),
  answeredCounter: document.getElementById("answeredCounter"),
  threshold: document.getElementById("threshold"),
  timer: document.getElementById("timer"),
  progressBar: document.getElementById("progressBar"),
  questionPanel: document.getElementById("questionPanel"),
  questionMedia: document.getElementById("questionMedia"),
  questionImage: document.getElementById("questionImage"),
  questionTopic: document.getElementById("questionTopic"),
  questionText: document.getElementById("questionText"),
  answerButtons: [...document.querySelectorAll(".answer-button")],
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  finishButton: document.getElementById("finishButton"),
  newExamButton: document.getElementById("newExamButton"),
  installButton: document.getElementById("installButton"),
  questionDrawerButton: document.getElementById("questionDrawerButton"),
  closeDrawerButton: document.getElementById("closeDrawerButton"),
  drawerBackdrop: document.getElementById("drawerBackdrop"),
  questionDrawer: document.getElementById("questionDrawer"),
  questionDots: document.getElementById("questionDots"),
  drawerQuestionDots: document.getElementById("drawerQuestionDots"),
  resultsPanel: document.getElementById("resultsPanel"),
  resultLabel: document.getElementById("resultLabel"),
  resultTitle: document.getElementById("resultTitle"),
  resultScore: document.getElementById("resultScore"),
  correctCount: document.getElementById("correctCount"),
  errorCount: document.getElementById("errorCount"),
  usedTime: document.getElementById("usedTime"),
  reviewList: document.getElementById("reviewList"),
  sourceInfo: document.getElementById("sourceInfo"),
  offlineStatus: document.getElementById("offlineStatus"),
};

let state = restoreSession() ?? createExam();
let timerId = 0;
let deferredInstallPrompt = null;

init();

function init() {
  els.threshold.textContent = `${settings.maxErrors} errori`;
  els.sourceInfo.textContent = `${formatNumber(allQuestions.length)} domande ministeriali`;

  els.answerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.answers[state.currentIndex] = button.dataset.answer === "true";
      persistSession();
      render();
    });
  });

  els.prevButton.addEventListener("click", () => moveBy(-1));
  els.nextButton.addEventListener("click", () => moveBy(1));
  els.finishButton.addEventListener("click", () => finishExam("manual"));
  els.questionDrawerButton.addEventListener("click", openQuestionDrawer);
  els.closeDrawerButton.addEventListener("click", closeQuestionDrawer);
  els.drawerBackdrop.addEventListener("click", closeQuestionDrawer);
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeQuestionDrawer();
  });
  els.newExamButton.addEventListener("click", () => {
    state = createExam();
    persistSession();
    closeQuestionDrawer();
    render();
  });

  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    els.installButton.hidden = false;
  });

  els.installButton.addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installButton.hidden = true;
  });

  registerServiceWorker();
  render();
  timerId = window.setInterval(tickTimer, 500);
}

function createExam() {
  const now = Date.now();
  const questions = sample(allQuestions, settings.examQuestions);
  return {
    id: crypto.randomUUID?.() ?? String(now),
    questions,
    answers: Array.from({ length: questions.length }, () => null),
    currentIndex: 0,
    startedAt: now,
    endsAt: now + settings.examMinutes * 60 * 1000,
    finished: false,
    finishedAt: null,
    finishReason: null,
  };
}

function restoreSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (!saved || saved.finished || Date.now() >= saved.endsAt) return null;
    if (!Array.isArray(saved.questions) || saved.questions.length === 0) return null;
    return saved;
  } catch {
    return null;
  }
}

function persistSession() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function sample(items, count) {
  const pool = [...items];
  for (let index = pool.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [pool[index], pool[swapIndex]] = [pool[swapIndex], pool[index]];
  }
  return pool.slice(0, Math.min(count, pool.length));
}

function render() {
  if (state.finished) {
    renderResults();
    return;
  }

  const question = state.questions[state.currentIndex];
  const answer = state.answers[state.currentIndex];
  const answeredCount = state.answers.filter((item) => item !== null).length;

  els.questionPanel.hidden = false;
  els.resultsPanel.hidden = true;
  els.questionCounter.textContent = `${state.currentIndex + 1}/${state.questions.length}`;
  els.answeredCounter.textContent = `${answeredCount}/${state.questions.length}`;
  els.progressBar.style.width = `${(answeredCount / state.questions.length) * 100}%`;
  els.questionTopic.textContent = question.topic;
  els.questionText.textContent = question.text;

  if (question.image) {
    els.questionMedia.hidden = false;
    els.questionImage.src = question.image;
    els.questionImage.alt = `Figura ministeriale per la domanda ${question.id}`;
  } else {
    els.questionMedia.hidden = true;
    els.questionImage.removeAttribute("src");
    els.questionImage.alt = "";
  }

  els.answerButtons.forEach((button) => {
    button.classList.toggle("selected", answer === (button.dataset.answer === "true"));
  });

  els.prevButton.disabled = state.currentIndex === 0;
  els.nextButton.disabled = state.currentIndex === state.questions.length - 1;
  renderDots();
  tickTimer();
}

function renderDots() {
  els.questionDots.innerHTML = "";
  els.drawerQuestionDots.innerHTML = "";
  state.questions.forEach((question, index) => {
    els.questionDots.append(createDotButton(index));
    els.drawerQuestionDots.append(createDotButton(index, true));
  });
}

function createDotButton(index, closesDrawer = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "question-dot";
  button.textContent = String(index + 1);
  button.setAttribute("aria-label", `Domanda ${index + 1}`);
  button.classList.toggle("current", index === state.currentIndex);
  button.classList.toggle("answered", state.answers[index] !== null);
  button.addEventListener("click", () => {
    state.currentIndex = index;
    persistSession();
    if (closesDrawer) closeQuestionDrawer();
    render();
  });
  return button;
}

function openQuestionDrawer() {
  els.questionDrawer.hidden = false;
  els.drawerBackdrop.hidden = false;
  document.body.classList.add("drawer-open");
  els.questionDrawerButton.setAttribute("aria-expanded", "true");
}

function closeQuestionDrawer() {
  els.questionDrawer.hidden = true;
  els.drawerBackdrop.hidden = true;
  document.body.classList.remove("drawer-open");
  els.questionDrawerButton.setAttribute("aria-expanded", "false");
}

function moveBy(delta) {
  state.currentIndex = Math.min(
    Math.max(state.currentIndex + delta, 0),
    state.questions.length - 1,
  );
  persistSession();
  render();
}

function tickTimer() {
  if (state.finished) return;
  const remaining = Math.max(0, state.endsAt - Date.now());
  els.timer.textContent = formatDuration(remaining);
  if (remaining === 0) finishExam("timeout");
}

function finishExam(reason) {
  if (state.finished) return;
  state.finished = true;
  state.finishedAt = Date.now();
  state.finishReason = reason;
  persistResult();
  localStorage.removeItem(STORAGE_KEY);
  renderResults();
}

function calculateResult() {
  const errors = state.questions.reduce((total, question, index) => {
    return total + (state.answers[index] === question.correct ? 0 : 1);
  }, 0);
  const correct = state.questions.length - errors;
  return {
    errors,
    correct,
    passed: errors <= settings.maxErrors,
    usedMs: Math.max(0, (state.finishedAt ?? Date.now()) - state.startedAt),
  };
}

function renderResults() {
  const result = calculateResult();
  els.questionPanel.hidden = true;
  els.resultsPanel.hidden = false;
  closeQuestionDrawer();
  els.progressBar.style.width = "100%";
  els.questionCounter.textContent = `${state.questions.length}/${state.questions.length}`;
  els.answeredCounter.textContent = `${state.answers.filter((item) => item !== null).length}/${state.questions.length}`;
  els.timer.textContent = formatDuration(Math.max(0, state.endsAt - (state.finishedAt ?? Date.now())));
  els.resultLabel.textContent = result.passed ? "Promosso" : "Respinto";
  els.resultTitle.textContent = result.passed ? "Scheda superata" : "Troppi errori";
  els.resultScore.textContent = `${result.errors} ${result.errors === 1 ? "errore" : "errori"}`;
  els.correctCount.textContent = String(result.correct);
  els.errorCount.textContent = String(result.errors);
  els.usedTime.textContent = formatDuration(result.usedMs);
  renderReviewList();
}

function renderReviewList() {
  els.reviewList.innerHTML = "";
  state.questions.forEach((question, index) => {
    const answer = state.answers[index];
    const isCorrect = answer === question.correct;

    const item = document.createElement("article");
    item.className = "review-item";
    item.classList.toggle("review-item-correct", isCorrect);

    if (question.image) {
      const image = document.createElement("img");
      image.src = question.image;
      image.alt = `Figura ministeriale per la domanda ${question.id}`;
      item.append(image);
    }

    const meta = document.createElement("div");
    meta.className = "review-meta";

    const status = document.createElement("span");
    status.className = `result-pill ${isCorrect ? "result-pill-correct" : "result-pill-error"}`;
    status.textContent = answer === null ? "Non risposta" : isCorrect ? "Corretta" : "Incorretta";

    const topic = document.createElement("span");
    topic.className = "topic-chip";
    topic.textContent = question.topic;
    meta.append(status, topic);

    const text = document.createElement("p");
    text.textContent = question.text;

    const comparison = document.createElement("div");
    comparison.className = "answer-comparison";

    comparison.append(
      createAnswerPill("Hai scelto", answer, isCorrect, answer === null),
      createAnswerPill("Corretta", question.correct, true),
    );

    const explanation = document.createElement("p");
    explanation.className = "explanation";
    explanation.textContent = explanationFor(question);

    item.append(meta, text, comparison, explanation);
    els.reviewList.append(item);
  });
}

function createAnswerPill(label, value, isCorrect, isMissing = false) {
  const pill = document.createElement("span");
  pill.className = `answer-pill ${isCorrect ? "answer-pill-correct" : "answer-pill-wrong"}`;

  const labelNode = document.createElement("small");
  labelNode.textContent = label;

  const valueNode = document.createElement("strong");
  valueNode.textContent = isMissing ? "Non data" : labelAnswer(value);

  pill.append(labelNode, valueNode);
  return pill;
}

function explanationFor(question) {
  const correct = labelAnswer(question.correct);
  return `Risposta corretta: ${correct}. La banca ministeriale pubblica risposta e figura, ma non una spiegazione testuale ufficiale per questa domanda.`;
}

function persistResult() {
  const history = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]");
  const result = calculateResult();
  history.unshift({
    date: new Date().toISOString(),
    errors: result.errors,
    correct: result.correct,
    passed: result.passed,
  });
  localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 8)));
}

function labelAnswer(value) {
  return value ? "Vero" : "Falso";
}

function formatDuration(ms) {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("it-IT").format(value);
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    els.offlineStatus.textContent = "Offline non disponibile";
    return;
  }

  try {
    await navigator.serviceWorker.register("./service-worker.js");
    els.offlineStatus.textContent = "Offline pronta";
  } catch {
    els.offlineStatus.textContent = "Solo online";
  }
}
