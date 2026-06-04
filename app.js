const bank = window.PATENTE_QUESTION_BANK;

const STORAGE_KEY = "quiz-patente-session-v1";
const HISTORY_KEY = "quiz-patente-history-v1";
const AUTH_TOKEN_KEY = "quiz-patente-auth-token-v1";
const LANGUAGE_PREF_KEY = "quiz-patente-translation-language-v1";
const settings = bank?.settings ?? { examQuestions: 30, examMinutes: 20, maxErrors: 3 };
const allQuestions = bank?.questions ?? [];
const explanationCache = new Map();
const explanationTargets = new WeakMap();
const pendingExplanationLoads = new Set();
const translationCache = new Map();
const pendingTranslations = new Map();
const ORIGINAL_LANGUAGE = { code: "it", label: "Italiano originale", custom: false };
const PRESET_LANGUAGES = [
  ORIGINAL_LANGUAGE,
  { code: "en", label: "Inglese", custom: false },
  { code: "ru", label: "Russo", custom: false },
  { code: "hy", label: "Armeno", custom: false },
  { code: "fa", label: "Persiano", custom: false },
  { code: "zh-Hans", label: "Cinese semplificato", custom: false },
  { code: "tr", label: "Turco", custom: false },
];

const els = {
  questionCounter: document.getElementById("questionCounter"),
  answeredCounter: document.getElementById("answeredCounter"),
  threshold: document.getElementById("threshold"),
  timer: document.getElementById("timer"),
  progressBar: document.getElementById("progressBar"),
  questionPanel: document.getElementById("questionPanel"),
  examControls: document.getElementById("examControls"),
  questionMedia: document.getElementById("questionMedia"),
  questionImage: document.getElementById("questionImage"),
  questionLanguageControl: document.getElementById("questionLanguageControl"),
  questionLanguageSelect: document.getElementById("questionLanguageSelect"),
  questionTopic: document.getElementById("questionTopic"),
  questionText: document.getElementById("questionText"),
  questionTranslation: document.getElementById("questionTranslation"),
  questionTranslationLabel: document.getElementById("questionTranslationLabel"),
  translatedQuestionText: document.getElementById("translatedQuestionText"),
  answerButtons: [...document.querySelectorAll(".answer-button")],
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  finishButton: document.getElementById("finishButton"),
  newExamButton: document.getElementById("newExamButton"),
  installButton: document.getElementById("installButton"),
  accountButton: document.getElementById("accountButton"),
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
  modalBackdrop: document.getElementById("modalBackdrop"),
  accountPanel: document.getElementById("accountPanel"),
  closeAccountButton: document.getElementById("closeAccountButton"),
  authSignedOut: document.getElementById("authSignedOut"),
  authSignedIn: document.getElementById("authSignedIn"),
  emailLoginForm: document.getElementById("emailLoginForm"),
  codeLoginForm: document.getElementById("codeLoginForm"),
  loginEmail: document.getElementById("loginEmail"),
  loginCode: document.getElementById("loginCode"),
  requestCodeButton: document.getElementById("requestCodeButton"),
  verifyCodeButton: document.getElementById("verifyCodeButton"),
  authStatus: document.getElementById("authStatus"),
  accountEmail: document.getElementById("accountEmail"),
  signOutButton: document.getElementById("signOutButton"),
  progressTotal: document.getElementById("progressTotal"),
  progressPassed: document.getElementById("progressPassed"),
  progressAverage: document.getElementById("progressAverage"),
  accountLanguageSelect: document.getElementById("accountLanguageSelect"),
  customLanguageField: document.getElementById("customLanguageField"),
  customLanguageInput: document.getElementById("customLanguageInput"),
  translationPreferenceStatus: document.getElementById("translationPreferenceStatus"),
  progressList: document.getElementById("progressList"),
  adminPanel: document.getElementById("adminPanel"),
  refreshAdminButton: document.getElementById("refreshAdminButton"),
  adminUsersTotal: document.getElementById("adminUsersTotal"),
  adminTestsTotal: document.getElementById("adminTestsTotal"),
  adminPassedTotal: document.getElementById("adminPassedTotal"),
  adminAvgErrors: document.getElementById("adminAvgErrors"),
  adminTabs: document.getElementById("adminTabs"),
  adminContent: document.getElementById("adminContent"),
};

let state = restoreSession() ?? createExam();
let authState = { token: localStorage.getItem(AUTH_TOKEN_KEY), user: null, progress: null };
let adminState = { data: null, view: "users", loading: false, error: "" };
let translationState = { language: restoreLanguagePreference() };
let timerId = 0;
let deferredInstallPrompt = null;
let drawerClosingTimer = 0;
let accountClosingTimer = 0;
let explanationObserver = null;
let customLanguageTimer = 0;

init();

function init() {
  els.threshold.textContent = `${settings.maxErrors} errori`;

  els.answerButtons.forEach((button) => {
    button.addEventListener("click", () => {
      answerCurrentQuestion(button.dataset.answer === "true");
    });
  });

  els.prevButton.addEventListener("click", () => moveBy(-1));
  els.nextButton.addEventListener("click", () => moveBy(1));
  els.finishButton.addEventListener("click", () => finishExam("manual"));
  els.questionDrawerButton.addEventListener("click", openQuestionDrawer);
  els.closeDrawerButton.addEventListener("click", closeQuestionDrawer);
  els.drawerBackdrop.addEventListener("click", closeQuestionDrawer);
  els.accountButton.addEventListener("click", openAccountPanel);
  els.closeAccountButton.addEventListener("click", closeAccountPanel);
  els.modalBackdrop.addEventListener("click", closeAccountPanel);
  els.emailLoginForm.addEventListener("submit", requestLoginCode);
  els.codeLoginForm.addEventListener("submit", verifyLoginCode);
  els.loginCode.addEventListener("input", () => {
    els.loginCode.value = els.loginCode.value.replace(/\D/g, "").slice(0, 6);
  });
  els.signOutButton.addEventListener("click", signOut);
  els.questionLanguageSelect.addEventListener("change", handleQuestionLanguageChange);
  els.accountLanguageSelect.addEventListener("change", handleAccountLanguageChange);
  els.customLanguageInput.addEventListener("input", handleCustomLanguageInput);
  els.refreshAdminButton.addEventListener("click", () => loadAdminDashboard(true));
  els.adminTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-admin-view]");
    if (!tab) return;
    adminState.view = tab.dataset.adminView;
    renderAdmin();
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeQuestionDrawer();
      closeAccountPanel();
      return;
    }

    if (
      state.finished ||
      isTypingTarget(event.target) ||
      document.body.classList.contains("drawer-open") ||
      document.body.classList.contains("account-open")
    ) {
      return;
    }

    const key = event.key.toLowerCase();
    if (key === "v") {
      event.preventDefault();
      answerCurrentQuestion(true);
    }
    if (key === "f") {
      event.preventDefault();
      answerCurrentQuestion(false);
    }
  });
  els.newExamButton.addEventListener("click", startNewExam);

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
  initAuth();
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

function restoreLanguagePreference() {
  try {
    const saved = JSON.parse(localStorage.getItem(LANGUAGE_PREF_KEY) || "null");
    if (!saved || typeof saved !== "object") return ORIGINAL_LANGUAGE;
    if (saved.custom && saved.label) {
      return {
        code: "custom",
        label: String(saved.label).trim().slice(0, 80),
        custom: true,
      };
    }
    return PRESET_LANGUAGES.find((language) => language.code === saved.code) || ORIGINAL_LANGUAGE;
  } catch {
    return ORIGINAL_LANGUAGE;
  }
}

function persistLanguagePreference() {
  localStorage.setItem(LANGUAGE_PREF_KEY, JSON.stringify(translationState.language));
}

function getActiveTranslationLanguage() {
  const language = translationState.language;
  if (!authState.user || !language || language.code === "it") return null;
  if (language.custom && !language.label.trim()) return null;
  return language;
}

function isCustomLanguageSelected() {
  return translationState.language?.custom || translationState.language?.code === "custom";
}

function setTranslationLanguage(language, shouldRender = true) {
  translationState.language = language || ORIGINAL_LANGUAGE;
  persistLanguagePreference();
  renderLanguageControls();
  if (!shouldRender) return;

  if (state.finished) {
    renderReviewList();
  } else {
    render();
  }
}

function handleQuestionLanguageChange(event) {
  const selected = languageFromSelectValue(event.target.value);
  if (selected?.code === "custom" && !selected.label.trim()) {
    openAccountPanel();
    els.accountLanguageSelect.value = "custom";
    els.customLanguageField.hidden = false;
    window.setTimeout(() => els.customLanguageInput.focus(), 280);
    renderLanguageControls();
    return;
  }
  setTranslationLanguage(selected);
}

function handleAccountLanguageChange(event) {
  const selected = languageFromSelectValue(event.target.value);
  if (selected?.code === "custom") {
    const label = els.customLanguageInput.value.trim();
    setTranslationLanguage({ code: "custom", label, custom: true }, false);
    els.customLanguageField.hidden = false;
    els.translationPreferenceStatus.textContent = label
      ? `Usero ${label} come lingua di traduzione.`
      : "Scrivi il nome della lingua personalizzata.";
    if (!label) els.customLanguageInput.focus();
    if (label) setTranslationLanguage({ code: "custom", label, custom: true });
    return;
  }
  setTranslationLanguage(selected);
}

function handleCustomLanguageInput() {
  window.clearTimeout(customLanguageTimer);
  customLanguageTimer = window.setTimeout(() => {
    if (!isCustomLanguageSelected()) return;
    const label = els.customLanguageInput.value.trim().slice(0, 80);
    setTranslationLanguage({ code: "custom", label, custom: true });
  }, 360);
}

function languageFromSelectValue(value) {
  if (value === "custom") {
    return {
      code: "custom",
      label: translationState.language?.custom ? translationState.language.label : "",
      custom: true,
    };
  }
  return PRESET_LANGUAGES.find((language) => language.code === value) || ORIGINAL_LANGUAGE;
}

function renderLanguageControls() {
  const isSignedIn = Boolean(authState.user);
  els.questionLanguageControl.hidden = !isSignedIn;
  populateLanguageSelect(els.questionLanguageSelect, { includeCustomPlaceholder: false });
  populateLanguageSelect(els.accountLanguageSelect, { includeCustomPlaceholder: true });

  const selectValue = isCustomLanguageSelected() ? "custom" : translationState.language.code;
  els.questionLanguageSelect.value = selectValue;
  els.accountLanguageSelect.value = selectValue;
  els.customLanguageField.hidden = !isCustomLanguageSelected();
  els.customLanguageInput.value = isCustomLanguageSelected() ? translationState.language.label : "";

  if (!isSignedIn) {
    els.questionTranslation.hidden = true;
    return;
  }

  const activeLanguage = getActiveTranslationLanguage();
  if (!activeLanguage && isCustomLanguageSelected()) {
    els.translationPreferenceStatus.textContent = "Scrivi il nome della lingua personalizzata.";
  } else if (activeLanguage) {
    els.translationPreferenceStatus.textContent = `Le domande e le spiegazioni saranno tradotte in ${activeLanguage.label}.`;
  } else {
    els.translationPreferenceStatus.textContent = "Mostro il testo ministeriale originale in italiano.";
  }
}

function populateLanguageSelect(select, { includeCustomPlaceholder }) {
  const currentValue = select.value;
  select.innerHTML = "";
  PRESET_LANGUAGES.forEach((language) => {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    select.append(option);
  });

  if (includeCustomPlaceholder || translationState.language?.custom) {
    const option = document.createElement("option");
    option.value = "custom";
    option.textContent = translationState.language?.custom && translationState.language.label
      ? `Personalizzata: ${translationState.language.label}`
      : "Lingua personalizzata...";
    select.append(option);
  }

  select.value = currentValue;
}

function renderQuestionTranslation(question) {
  const language = getActiveTranslationLanguage();
  if (!language) {
    els.questionTranslation.hidden = true;
    els.translatedQuestionText.textContent = "";
    return;
  }

  const cacheKey = translationKey(question, "");
  const cached = translationCache.get(cacheKey);
  els.questionTranslation.hidden = false;
  els.questionTranslationLabel.textContent = `Traduzione in ${language.label}`;

  if (cached) {
    els.translatedQuestionText.textContent = cached.questionText;
    return;
  }

  els.translatedQuestionText.textContent = "Traduco...";
  loadTranslation(question, "").then((translation) => {
    if (state.finished || state.questions[state.currentIndex]?.id !== question.id) return;
    els.translatedQuestionText.textContent = translation.questionText;
  }).catch((error) => {
    if (state.finished || state.questions[state.currentIndex]?.id !== question.id) return;
    els.translatedQuestionText.textContent =
      error.message || "Traduzione non disponibile in questo momento.";
  });
}

async function loadTranslation(question, explanation) {
  const language = getActiveTranslationLanguage();
  if (!language) {
    return {
      questionText: question.text,
      topic: question.topic,
      explanation,
      language: ORIGINAL_LANGUAGE,
    };
  }

  const cacheKey = translationKey(question, explanation);
  if (translationCache.has(cacheKey)) return translationCache.get(cacheKey);
  if (pendingTranslations.has(cacheKey)) return pendingTranslations.get(cacheKey);

  const promise = authFetch("./api/translation", {
    method: "POST",
    body: JSON.stringify({
      questionId: question.id,
      language,
      explanation,
    }),
  }).then((response) => {
    translationCache.set(cacheKey, response.translation);
    return response.translation;
  }).finally(() => {
    pendingTranslations.delete(cacheKey);
  });

  pendingTranslations.set(cacheKey, promise);
  return promise;
}

function translationKey(question, explanation) {
  const language = translationState.language || ORIGINAL_LANGUAGE;
  return JSON.stringify([
    question.id,
    language.code,
    language.label,
    Boolean(explanation),
    hashString(explanation || question.text),
  ]);
}

function hashString(value) {
  let hash = 0;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(16);
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
  els.examControls.hidden = false;
  els.resultsPanel.hidden = true;
  els.questionPanel.classList.toggle("has-media", Boolean(question.image));
  els.questionPanel.classList.toggle("no-media", !question.image);
  els.questionPanel.classList.toggle("has-answer", answer !== null);
  els.questionCounter.textContent = `${state.currentIndex + 1}/${state.questions.length}`;
  els.answeredCounter.textContent = `${answeredCount}/${state.questions.length}`;
  const progress = `${(answeredCount / state.questions.length) * 100}%`;
  els.progressBar.style.width = progress;
  els.questionTopic.textContent = question.topic;
  els.questionText.textContent = question.text;
  renderLanguageControls();
  renderQuestionTranslation(question);

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
  els.finishButton.classList.toggle(
    "finish-ready",
    state.currentIndex === state.questions.length - 1 && state.answers[state.currentIndex] !== null,
  );
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

function answerCurrentQuestion(value) {
  state.answers[state.currentIndex] = value;
  if (state.currentIndex < state.questions.length - 1) {
    state.currentIndex += 1;
  }
  persistSession();
  render();
}

function isTypingTarget(target) {
  return ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName) || target?.isContentEditable;
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
  els.questionDrawerButton.setAttribute("aria-expanded", String(isExpanded));
}

function startNewExam() {
  const hasActiveProgress =
    !state.finished &&
    (state.currentIndex > 0 || state.answers.some((answer) => answer !== null));
  if (hasActiveProgress && !window.confirm("Vuoi abbandonare il test in corso e iniziarne uno nuovo?")) {
    return;
  }

  state = createExam();
  persistSession();
  closeQuestionDrawer();
  render();
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
  syncFinishedExam();
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
  els.examControls.hidden = true;
  els.resultsPanel.hidden = false;
  closeQuestionDrawer();
  els.progressBar.style.width = "100%";
  els.questionCounter.textContent = `${state.questions.length}/${state.questions.length}`;
  els.answeredCounter.textContent = `${state.answers.filter((item) => item !== null).length}/${state.questions.length}`;
  els.timer.textContent = formatDuration(Math.max(0, state.endsAt - (state.finishedAt ?? Date.now())));
  els.finishButton.classList.remove("finish-ready");
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

    const textGroup = document.createElement("div");
    textGroup.className = "review-question-copy";
    textGroup.append(text);
    const translatedQuestion = createTranslatedQuestionPanel(question);
    if (translatedQuestion) textGroup.append(translatedQuestion);

    const explanation = createAiExplanationPanel(question, answer, { collapsed: isCorrect });

    item.append(textGroup, explanation);
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

function createAiExplanationPanel(question, answer, options = {}) {
  const shouldCollapse = Boolean(options.collapsed);
  const panel = document.createElement(shouldCollapse ? "details" : "section");
  panel.className = "ai-explanation";
  panel.classList.toggle("ai-explanation-collapsible", shouldCollapse);
  panel.dataset.questionId = String(question.id);
  if (shouldCollapse) panel.dataset.lazyExplanation = "true";

  const header = document.createElement(shouldCollapse ? "summary" : "div");
  header.className = "ai-explanation-header";

  const title = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = "Spiegazione";
  title.append(heading);

  const hint = document.createElement("span");
  hint.className = "ai-explanation-hint";

  const body = document.createElement("div");
  body.className = "ai-explanation-body";

  header.append(title);
  if (shouldCollapse) header.append(hint);
  panel.append(header, body);

  const cached = explanationCache.get(question.id);
  if (cached) {
    panel.dataset.explanationLoaded = "true";
    renderAiExplanationBody(body, question, answer, cached);
  } else if (shouldCollapse) {
    renderExplanationPrompt(body);
    explanationTargets.set(panel, { question, answer });
  } else {
    renderExplanationSkeleton(body);
    observeExplanationPanel(panel, question, answer);
  }

  if (shouldCollapse) {
    updateExplanationToggleHint(panel, hint);
    panel.addEventListener("toggle", () => {
      updateExplanationToggleHint(panel, hint);
      if (!panel.open || panel.dataset.explanationLoaded === "true") return;
      renderExplanationSkeleton(body);
      loadExplanationPanel(panel);
    });
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

  const translatedExplanation = createTranslatedExplanationPanel(question, correctExplanation);

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
  body.append(explanationText);
  if (translatedExplanation) body.append(translatedExplanation);
  body.append(footer, reportForm);
}

function createTranslatedExplanationPanel(question, explanation) {
  const language = getActiveTranslationLanguage();
  if (!language) return null;

  const panel = document.createElement("section");
  panel.className = "translated-explanation";

  const label = document.createElement("span");
  label.textContent = `Traduzione in ${language.label}`;

  const text = document.createElement("p");
  text.textContent = "Traduco...";

  panel.append(label, text);

  loadTranslation(question, cleanExplanationText(explanation)).then((translation) => {
    text.textContent = translation.explanation || translation.questionText;
  }).catch((error) => {
    text.textContent = error.message || "Traduzione non disponibile in questo momento.";
  });

  return panel;
}

function createTranslatedQuestionPanel(question) {
  const language = getActiveTranslationLanguage();
  if (!language) return null;

  const panel = document.createElement("section");
  panel.className = "translated-explanation translated-question-review";

  const label = document.createElement("span");
  label.textContent = `Domanda in ${language.label}`;

  const text = document.createElement("p");
  text.textContent = "Traduco...";

  panel.append(label, text);

  loadTranslation(question, "").then((translation) => {
    text.textContent = translation.questionText;
  }).catch((error) => {
    text.textContent = error.message || "Traduzione non disponibile in questo momento.";
  });

  return panel;
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

function renderExplanationPrompt(body) {
  body.innerHTML = "";
  const message = document.createElement("p");
  message.className = "ai-status ai-status-muted";
  message.textContent = "Apri per vedere la spiegazione.";
  body.append(message);
}

function updateExplanationToggleHint(panel, hint) {
  hint.textContent = panel.open ? "Nascondi" : "Mostra";
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
  if (
    !target ||
    panel.dataset.explanationLoaded === "true" ||
    pendingExplanationLoads.has(target.question.id)
  ) {
    return;
  }
  const body = panel.querySelector(".ai-explanation-body");
  pendingExplanationLoads.add(target.question.id);

  try {
    const response = await fetchJson("./api/explanation", {
      method: "POST",
      body: JSON.stringify({ questionId: target.question.id }),
    });
    explanationCache.set(target.question.id, response.explanation);
    panel.dataset.explanationLoaded = "true";
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

async function initAuth() {
  renderAuth();
  if (!authState.token) return;

  try {
    const response = await authFetch("./api/auth-me");
    authState.user = response.user;
    authState.progress = response.progress;
    renderAuth();
  } catch {
    localStorage.removeItem(AUTH_TOKEN_KEY);
    authState = { token: null, user: null, progress: null };
    adminState = { data: null, view: "users", loading: false, error: "" };
    renderAuth();
  }
}

function openAccountPanel() {
  window.clearTimeout(accountClosingTimer);
  els.accountPanel.hidden = false;
  els.modalBackdrop.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("account-open");
  });
  if (authState.user) {
    loadProgress();
    if (authState.user.isAdmin) loadAdminDashboard();
  }
}

function closeAccountPanel() {
  window.clearTimeout(accountClosingTimer);
  document.body.classList.remove("account-open");
  accountClosingTimer = window.setTimeout(() => {
    els.accountPanel.hidden = true;
    els.modalBackdrop.hidden = true;
  }, 260);
}

async function requestLoginCode(event) {
  event.preventDefault();
  const email = els.loginEmail.value.trim().toLowerCase();
  if (!email) return;

  els.requestCodeButton.disabled = true;
  setAuthStatus("Invio codice...");

  try {
    await fetchJson("./api/auth-request", {
      method: "POST",
      body: JSON.stringify({ email }),
    });
    els.codeLoginForm.hidden = false;
    els.loginCode.focus();
    setAuthStatus("Codice inviato. Controlla la tua email.");
  } catch (error) {
    setAuthStatus(error.message || "Invio codice non riuscito.");
  } finally {
    els.requestCodeButton.disabled = false;
  }
}

async function verifyLoginCode(event) {
  event.preventDefault();
  const email = els.loginEmail.value.trim().toLowerCase();
  const code = els.loginCode.value.replace(/\D/g, "");
  if (!email || code.length !== 6) {
    setAuthStatus("Inserisci il codice a 6 cifre.");
    return;
  }

  els.verifyCodeButton.disabled = true;
  setAuthStatus("Verifica...");

  try {
    const response = await fetchJson("./api/auth-verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    authState.token = response.token;
    authState.user = response.user;
    authState.progress = response.progress;
    adminState = { data: null, view: "users", loading: false, error: "" };
    localStorage.setItem(AUTH_TOKEN_KEY, response.token);
    els.loginCode.value = "";
    setAuthStatus("");
    renderAuth();
    await syncFinishedExam();
  } catch (error) {
    setAuthStatus(error.message || "Codice non valido.");
  } finally {
    els.verifyCodeButton.disabled = false;
  }
}

async function signOut() {
  const token = authState.token;
  authState = { token: null, user: null, progress: null };
  adminState = { data: null, view: "users", loading: false, error: "" };
  localStorage.removeItem(AUTH_TOKEN_KEY);
  renderAuth();
  if (!token) return;

  try {
    await fetchJson("./api/auth-logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    // The local session is already gone; a stale remote token can expire naturally.
  }
}

function renderAuth() {
  const isSignedIn = Boolean(authState.user);
  els.accountButton.textContent = isSignedIn ? "Progressi" : "Accedi";
  els.authSignedOut.hidden = isSignedIn;
  els.authSignedIn.hidden = !isSignedIn;
  renderLanguageControls();

  if (!isSignedIn) {
    renderProgress(null);
    renderAdmin();
    return;
  }

  els.accountEmail.textContent = authState.user.email;
  renderProgress(authState.progress);
  renderAdmin();
  if (authState.user.isAdmin && !adminState.data && !adminState.loading && !adminState.error) {
    loadAdminDashboard();
  }
  if (state.finished) {
    renderReviewList();
  } else {
    renderQuestionTranslation(state.questions[state.currentIndex]);
  }
}

function setAuthStatus(message) {
  els.authStatus.textContent = message;
}

async function loadProgress() {
  if (!authState.token) return;
  try {
    const response = await authFetch("./api/user-progress");
    authState.progress = response.progress;
    renderAuth();
  } catch (error) {
    renderProgress(null, error.message || "Progressi non disponibili.");
  }
}

function renderProgress(progress, errorMessage = "") {
  const summary = progress?.summary ?? { total: 0, passed: 0, averageErrors: 0 };
  const recent = progress?.recent ?? [];

  els.progressTotal.textContent = String(summary.total);
  els.progressPassed.textContent = String(summary.passed);
  els.progressAverage.textContent = formatAverage(summary.averageErrors);
  els.progressList.innerHTML = "";

  if (errorMessage) {
    const item = document.createElement("p");
    item.className = "progress-empty";
    item.textContent = errorMessage;
    els.progressList.append(item);
    return;
  }

  if (recent.length === 0) {
    const item = document.createElement("p");
    item.className = "progress-empty";
    item.textContent = "Nessuna simulazione salvata.";
    els.progressList.append(item);
    return;
  }

  recent.forEach((exam) => {
    const item = document.createElement("article");
    item.className = "progress-item";

    const title = document.createElement("strong");
    title.textContent = formatDate(exam.finishedAt);

    const detail = document.createElement("span");
    detail.textContent = `${exam.errorCount} ${exam.errorCount === 1 ? "errore" : "errori"} · ${formatDuration(exam.usedMs)}`;

    const pill = document.createElement("span");
    pill.className = `result-pill ${exam.passed ? "result-pill-correct" : "result-pill-error"}`;
    pill.textContent = exam.passed ? "Promossa" : "Respinta";

    item.append(title, detail, pill);
    els.progressList.append(item);
  });
}

async function loadAdminDashboard(force = false) {
  if (!authState.token || !authState.user?.isAdmin) return;
  if (adminState.loading || (adminState.data && !force)) {
    renderAdmin();
    return;
  }

  adminState.loading = true;
  adminState.error = "";
  renderAdmin();

  try {
    const response = await authFetch("./api/admin-dashboard");
    adminState.data = response.admin;
  } catch (error) {
    adminState.error = error.message || "Dashboard admin non disponibile.";
  } finally {
    adminState.loading = false;
    renderAdmin();
  }
}

function renderAdmin() {
  const isAdmin = Boolean(authState.user?.isAdmin);
  els.adminPanel.hidden = !isAdmin;
  if (!isAdmin) {
    els.adminContent.innerHTML = "";
    return;
  }

  const summary = adminState.data?.summary ?? {
    users: 0,
    tests: 0,
    passedTests: 0,
    averageErrors: 0,
  };
  els.adminUsersTotal.textContent = String(summary.users || 0);
  els.adminTestsTotal.textContent = String(summary.tests || 0);
  els.adminPassedTotal.textContent = String(summary.passedTests || 0);
  els.adminAvgErrors.textContent = formatAverage(summary.averageErrors || 0);
  els.refreshAdminButton.disabled = adminState.loading;

  els.adminTabs.querySelectorAll("[data-admin-view]").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.adminView === adminState.view);
  });

  if (adminState.loading && !adminState.data) {
    renderAdminMessage("Carico dashboard...");
    return;
  }

  if (adminState.error) {
    renderAdminMessage(adminState.error);
    return;
  }

  if (!adminState.data) {
    renderAdminMessage("Dashboard non ancora caricata.");
    return;
  }

  if (adminState.view === "activity") {
    renderAdminActivity(adminState.data.activity);
    return;
  }

  if (adminState.view === "tests") {
    renderAdminTests(adminState.data.tests);
    return;
  }

  renderAdminUsers(adminState.data.users);
}

function renderAdminMessage(message) {
  els.adminContent.innerHTML = "";
  const item = document.createElement("p");
  item.className = "progress-empty";
  item.textContent = message;
  els.adminContent.append(item);
}

function renderAdminUsers(users = []) {
  els.adminContent.innerHTML = "";
  if (users.length === 0) {
    renderAdminMessage("Nessun utente iscritto.");
    return;
  }

  const list = document.createElement("div");
  list.className = "admin-list";
  users.forEach((user) => {
    const item = document.createElement("article");
    item.className = "admin-row";

    const header = document.createElement("div");
    header.className = "admin-row-header";

    const title = document.createElement("strong");
    title.textContent = user.email;

    const date = document.createElement("span");
    date.textContent = `Iscritto ${formatDate(user.createdAt)}`;

    header.append(title, date);

    const stats = document.createElement("div");
    stats.className = "admin-mini-stats";
    stats.append(
      createAdminMetric("Test", user.totalTests),
      createAdminMetric("Promossi", user.passedTests),
      createAdminMetric("Media errori", formatAverage(user.averageErrors)),
      createAdminMetric("Sessioni", user.activeSessions),
    );

    const detail = document.createElement("p");
    detail.className = "admin-detail";
    detail.textContent = [
      user.lastLoginAt ? `Ultimo accesso ${formatDate(user.lastLoginAt)}` : "Nessun accesso completato",
      user.lastTestAt ? `ultimo test ${formatDate(user.lastTestAt)}` : "nessun test",
    ].join(" · ");

    item.append(header, stats, detail);
    list.append(item);
  });
  els.adminContent.append(list);
}

function renderAdminActivity(activity = []) {
  els.adminContent.innerHTML = "";
  if (activity.length === 0) {
    renderAdminMessage("Nessuna attività recente.");
    return;
  }

  const list = document.createElement("div");
  list.className = "admin-list";
  activity.forEach((event) => {
    const item = document.createElement("article");
    item.className = "admin-row admin-activity-row";

    const badge = document.createElement("span");
    badge.className = `admin-event admin-event-${event.type}`;
    badge.textContent = event.label;

    const title = document.createElement("strong");
    title.textContent = event.email;

    const detail = document.createElement("span");
    detail.textContent = `${formatDate(event.at)} · ${event.detail}`;

    item.append(badge, title, detail);
    list.append(item);
  });
  els.adminContent.append(list);
}

function renderAdminTests(tests = []) {
  els.adminContent.innerHTML = "";
  if (tests.length === 0) {
    renderAdminMessage("Nessun test salvato.");
    return;
  }

  const list = document.createElement("div");
  list.className = "admin-list";
  tests.forEach((test) => {
    const item = document.createElement("details");
    item.className = "admin-row admin-test-row";

    const summary = document.createElement("summary");
    const left = document.createElement("span");
    left.textContent = `${test.userEmail} · ${formatDate(test.finishedAt)}`;

    const result = document.createElement("strong");
    result.className = test.passed ? "admin-pass" : "admin-fail";
    result.textContent = `${test.errorCount} ${test.errorCount === 1 ? "errore" : "errori"}`;

    summary.append(left, result);

    const stats = document.createElement("div");
    stats.className = "admin-mini-stats";
    stats.append(
      createAdminMetric("Corrette", test.correctCount),
      createAdminMetric("Tempo", formatDuration(test.usedMs)),
      createAdminMetric("Motivo", test.finishReason === "timeout" ? "Tempo" : "Manuale"),
    );

    const wrongAnswers = (test.answers || []).filter((answer) => answer.isCorrect === false);
    const answers = document.createElement("div");
    answers.className = "admin-answer-list";

    if (wrongAnswers.length === 0) {
      const itemText = document.createElement("p");
      itemText.textContent = "Nessun errore registrato in questo test.";
      answers.append(itemText);
    } else {
      wrongAnswers.slice(0, 8).forEach((answer) => {
        const itemText = document.createElement("p");
        itemText.textContent = `#${answer.questionId} ${answer.topic || "Domanda"}: scelta ${formatAdminAnswer(
          answer.answer,
        )}, corretta ${formatAdminAnswer(answer.correctAnswer)}`;
        answers.append(itemText);
      });
      if (wrongAnswers.length > 8) {
        const extra = document.createElement("p");
        extra.textContent = `+${wrongAnswers.length - 8} altri errori`;
        answers.append(extra);
      }
    }

    item.append(summary, stats, answers);
    list.append(item);
  });
  els.adminContent.append(list);
}

function createAdminMetric(label, value) {
  const item = document.createElement("span");
  const labelNode = document.createElement("small");
  labelNode.textContent = label;
  const valueNode = document.createElement("strong");
  valueNode.textContent = String(value);
  item.append(labelNode, valueNode);
  return item;
}

function formatAdminAnswer(value) {
  if (value === null || value === undefined) return "Non data";
  return labelAnswer(Boolean(value));
}

async function syncFinishedExam() {
  if (!authState.token || !state.finished) return;
  try {
    const response = await authFetch("./api/save-exam-result", {
      method: "POST",
      body: JSON.stringify(buildExamResultPayload()),
    });
    authState.progress = response.progress;
    renderAuth();
  } catch {
    // Remote progress is a convenience layer; the completed quiz remains saved locally.
  }
}

function buildExamResultPayload() {
  const result = calculateResult();
  return {
    examId: state.id,
    startedAt: new Date(state.startedAt).toISOString(),
    finishedAt: new Date(state.finishedAt ?? Date.now()).toISOString(),
    usedMs: result.usedMs,
    totalQuestions: state.questions.length,
    correctCount: result.correct,
    errorCount: result.errors,
    passed: result.passed,
    finishReason: state.finishReason || "manual",
    answers: state.questions.map((question, index) => ({
      questionId: question.id,
      topic: question.topic,
      answer: state.answers[index],
      correctAnswer: question.correct,
      isCorrect: state.answers[index] === question.correct,
    })),
  };
}

async function authFetch(url, options = {}) {
  return fetchJson(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${authState.token}`,
      ...(options.headers ?? {}),
    },
  });
}

async function fetchJson(url, options = {}) {
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

function formatAverage(value) {
  return new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: 1,
    minimumFractionDigits: value % 1 === 0 ? 0 : 1,
  }).format(value || 0);
}

function formatDate(value) {
  return new Intl.DateTimeFormat("it-IT", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch {
    // The app still works online if the browser refuses service worker registration.
  }
}
