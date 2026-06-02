const bank = window.PATENTE_QUESTION_BANK;

const STORAGE_KEY = "quiz-patente-session-v1";
const HISTORY_KEY = "quiz-patente-history-v1";
const settings = bank?.settings ?? { examQuestions: 30, examMinutes: 20, maxErrors: 3 };
const allQuestions = bank?.questions ?? [];
const explanationCache = new Map();
const explanationTargets = new WeakMap();
const pendingExplanationLoads = new Set();

const els = {
  questionCounter: document.getElementById("questionCounter"),
  mobileQuestionCounter: document.getElementById("mobileQuestionCounter"),
  answeredCounter: document.getElementById("answeredCounter"),
  mobileAnsweredCounter: document.getElementById("mobileAnsweredCounter"),
  threshold: document.getElementById("threshold"),
  timer: document.getElementById("timer"),
  mobileTimer: document.getElementById("mobileTimer"),
  progressBar: document.getElementById("progressBar"),
  mobileProgressBar: document.getElementById("mobileProgressBar"),
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
  mobileQuestionDrawerButton: document.getElementById("mobileQuestionDrawerButton"),
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
let drawerClosingTimer = 0;
let explanationObserver = null;

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
  els.mobileQuestionDrawerButton.addEventListener("click", openQuestionDrawer);
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
  els.questionPanel.classList.toggle("has-media", Boolean(question.image));
  els.questionPanel.classList.toggle("no-media", !question.image);
  els.questionPanel.classList.toggle("has-answer", answer !== null);
  els.questionCounter.textContent = `${state.currentIndex + 1}/${state.questions.length}`;
  els.mobileQuestionCounter.textContent = `${state.currentIndex + 1}/${state.questions.length}`;
  els.answeredCounter.textContent = `${answeredCount}/${state.questions.length}`;
  els.mobileAnsweredCounter.textContent = `${answeredCount}/${state.questions.length}`;
  const progress = `${(answeredCount / state.questions.length) * 100}%`;
  els.progressBar.style.width = progress;
  els.mobileProgressBar.style.width = progress;
  els.questionTopic.textContent = question.topic;
  els.questionText.textContent = question.text;

  if (question.image) {
    els.questionMedia.hidden = false;
    els.questionImage.src = question.image;
    els.questionImage.alt = `Figura ministeriale per la domanda ${question.id}`;
  } else {
    els.questionMedia.hidden = false;
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
  window.clearTimeout(drawerClosingTimer);
  els.questionDrawer.hidden = false;
  els.drawerBackdrop.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("drawer-open");
    setDrawerExpanded(true);
  });
}

function closeQuestionDrawer() {
  window.clearTimeout(drawerClosingTimer);
  document.body.classList.remove("drawer-open");
  setDrawerExpanded(false);
  drawerClosingTimer = window.setTimeout(() => {
    els.questionDrawer.hidden = true;
    els.drawerBackdrop.hidden = true;
  }, 260);
}

function setDrawerExpanded(isExpanded) {
  const value = String(isExpanded);
  els.questionDrawerButton.setAttribute("aria-expanded", value);
  els.mobileQuestionDrawerButton.setAttribute("aria-expanded", value);
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
  els.mobileTimer.textContent = formatDuration(remaining);
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
  els.mobileQuestionCounter.textContent = els.questionCounter.textContent;
  els.answeredCounter.textContent = `${state.answers.filter((item) => item !== null).length}/${state.questions.length}`;
  els.mobileAnsweredCounter.textContent = els.answeredCounter.textContent;
  els.timer.textContent = formatDuration(Math.max(0, state.endsAt - (state.finishedAt ?? Date.now())));
  els.mobileTimer.textContent = els.timer.textContent;
  els.mobileProgressBar.style.width = "100%";
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
  explanationObserver?.disconnect();
  explanationObserver = null;

  state.questions.forEach((question, index) => {
    const answer = state.answers[index];
    const isCorrect = answer === question.correct;

    const item = document.createElement("article");
    item.className = "review-item";
    item.classList.toggle("review-item-error", !isCorrect);
    item.classList.toggle("review-item-correct", isCorrect);
    item.classList.toggle("review-item-with-image", Boolean(question.image));

    const meta = document.createElement("header");
    meta.className = "review-meta";

    const indexBadge = document.createElement("span");
    indexBadge.className = "review-index";
    indexBadge.textContent = `Domanda ${index + 1}`;

    const status = document.createElement("span");
    status.className = `result-pill ${isCorrect ? "result-pill-correct" : "result-pill-error"}`;
    status.textContent = answer === null ? "Non risposta" : isCorrect ? "Corretta" : "Incorretta";

    const comparison = document.createElement("div");
    comparison.className = "answer-comparison";
    comparison.append(
      createAnswerPill("Hai scelto", answer, isCorrect, answer === null),
      createAnswerPill("Corretta", question.correct, true),
    );

    const topic = document.createElement("span");
    topic.className = "topic-chip";
    topic.textContent = question.topic;
    meta.append(indexBadge, status, topic, comparison);
    item.append(meta);

    if (question.image) {
      const image = document.createElement("img");
      image.src = question.image;
      image.alt = `Figura ministeriale per la domanda ${question.id}`;
      item.append(image);
    }

    const text = document.createElement("p");
    text.className = "review-question-text";
    text.textContent = question.text;

    const explanation = createAiExplanationPanel(question, answer);

    item.append(text, explanation);
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

function createAiExplanationPanel(question, answer) {
  const panel = document.createElement("section");
  panel.className = "ai-explanation";
  panel.dataset.questionId = String(question.id);

  const header = document.createElement("div");
  header.className = "ai-explanation-header";

  const title = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = "Spiegazione";
  title.append(heading);

  const body = document.createElement("div");
  body.className = "ai-explanation-body";

  header.append(title);
  panel.append(header, body);

  const cached = explanationCache.get(question.id);
  if (cached) {
    renderAiExplanationBody(body, question, answer, cached);
  } else {
    renderExplanationSkeleton(body);
    observeExplanationPanel(panel, question, answer);
  }

  return panel;
}

function renderAiExplanationBody(body, question, answer, explanation) {
  body.innerHTML = "";

  const correctExplanation = question.correct
    ? explanation.trueExplanation
    : explanation.falseExplanation;

  const footer = document.createElement("div");
  footer.className = "ai-explanation-footer";

  const explanationText = document.createElement("p");
  explanationText.className = "single-explanation";
  explanationText.textContent = cleanExplanationText(correctExplanation);

  const reportButton = document.createElement("button");
  reportButton.className = "report-button";
  reportButton.type = "button";
  reportButton.textContent = "Segnala spiegazione";

  const reportForm = createReportForm(question.id, explanation);
  reportForm.hidden = true;

  reportButton.addEventListener("click", () => {
    reportForm.hidden = !reportForm.hidden;
  });

  footer.append(reportButton);
  body.append(explanationText, footer, reportForm);
}

function cleanExplanationText(text) {
  return String(text || "").replace(/^(vero|falso)\s*[:.-]\s*/i, "").trim();
}

function renderExplanationSkeleton(body) {
  body.innerHTML = `
    <div class="explanation-skeleton" aria-label="Caricamento spiegazione">
      <span></span>
      <span></span>
      <span></span>
    </div>
  `;
}

function observeExplanationPanel(panel, question, answer) {
  explanationTargets.set(panel, { question, answer });
  if (!("IntersectionObserver" in window)) {
    window.setTimeout(() => loadExplanationPanel(panel), 0);
    return;
  }
  if (!explanationObserver) {
    explanationObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          explanationObserver.unobserve(entry.target);
          loadExplanationPanel(entry.target);
        });
      },
      { rootMargin: "180px 0px" },
    );
  }
  explanationObserver.observe(panel);
}

async function loadExplanationPanel(panel) {
  const target = explanationTargets.get(panel);
  if (!target || pendingExplanationLoads.has(target.question.id)) return;
  const body = panel.querySelector(".ai-explanation-body");
  pendingExplanationLoads.add(target.question.id);

  try {
    const response = await fetchJson("./api/explanation", {
      method: "POST",
      body: JSON.stringify({ questionId: target.question.id }),
    });
    explanationCache.set(target.question.id, response.explanation);
    renderAiExplanationBody(body, target.question, target.answer, response.explanation);
  } catch (error) {
    body.innerHTML = "";
    const message = document.createElement("p");
    message.className = "ai-status ai-status-error";
    message.textContent =
      error.message || "Spiegazione non disponibile in questo momento.";
    body.append(message);
  } finally {
    pendingExplanationLoads.delete(target.question.id);
  }
}

function createReportForm(questionId, explanation) {
  const form = document.createElement("form");
  form.className = "report-form";

  const select = document.createElement("select");
  select.name = "reason";
  select.setAttribute("aria-label", "Motivo della segnalazione");
  [
    ["wrong", "Spiegazione sbagliata"],
    ["incomplete", "Incompleta"],
    ["unclear", "Non chiara"],
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    select.append(option);
  });

  const message = document.createElement("textarea");
  message.name = "message";
  message.rows = 3;
  message.maxLength = 600;
  message.placeholder = "Aggiungi un dettaglio, se vuoi";

  const submit = document.createElement("button");
  submit.className = "primary-button report-submit";
  submit.type = "submit";
  submit.textContent = "Invia";

  const status = document.createElement("p");
  status.className = "report-status";

  form.append(select, message, submit, status);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "Invio...";

    try {
      await fetchJson("./api/report-explanation", {
        method: "POST",
        body: JSON.stringify({
          questionId,
          reason: select.value,
          message: message.value.trim(),
          pageUrl: window.location.href,
          explanation: {
            model: explanation.model,
            promptVersion: explanation.promptVersion,
            confidence: explanation.confidence,
          },
        }),
      });
      status.textContent = "Segnalazione inviata. Grazie.";
      message.value = "";
    } catch (error) {
      status.textContent = error.message || "Invio non riuscito.";
    } finally {
      submit.disabled = false;
    }
  });

  return form;
}

async function fetchJson(url, options) {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options?.headers ?? {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || "Richiesta non riuscita.");
  }
  return payload;
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
