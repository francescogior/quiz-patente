const bank = window.PATENTE_QUESTION_BANK;

const LEGACY_STORAGE_KEY = "quiz-patente-session-v1";
const STORAGE_KEY_PREFIX = "quiz-patente-session-v2";
const DEMO_STORAGE_KEY = "quiz-patente-demo-v1";
const HISTORY_KEY = "quiz-patente-history-v1";
const AUTH_TOKEN_KEY = "quiz-patente-auth-token-v1";
const LANGUAGE_PREF_KEY = "quiz-patente-translation-language-v1";
const PLUS_TOKEN_LEGACY_KEY = "quiz-patente-plus-token-v1";
const PLUS_TOKENS_KEY = "quiz-patente-plus-tokens-v2";
const PLUS_PENDING_SESSION_KEY = "quiz-patente-plus-pending-session-v1";
const PLUS_PENDING_CHECKOUT_URL_KEY = "quiz-patente-plus-checkout-url-v1";
const PLUS_CHECKOUT_ATTEMPT_KEY = "quiz-patente-plus-checkout-attempt-v1";
const PLUS_CHECKOUT_URL = "./api/plus-checkout";
const settings = bank?.settings ?? {
  examQuestions: 30,
  examMinutes: 20,
  maxErrors: 3,
};
const allQuestions = bank?.questions ?? [];
const questionsById = new Map(
  allQuestions.map((question) => [String(question.id), question]),
);
const explanationCache = new Map();
let explanationTargets = new WeakMap();
const pendingExplanationLoads = new Map();
const translationCache = new Map();
const pendingTranslations = new Map();
const ORIGINAL_LANGUAGE = {
  code: "it",
  label: "Italiano originale",
  custom: false,
};
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
  thresholdLabel: document.getElementById("thresholdLabel"),
  threshold: document.getElementById("threshold"),
  timerLabel: document.getElementById("timerLabel"),
  timer: document.getElementById("timer"),
  progressBar: document.getElementById("progressBar"),
  questionPanel: document.getElementById("questionPanel"),
  examControls: document.getElementById("examControls"),
  questionMedia: document.getElementById("questionMedia"),
  questionImage: document.getElementById("questionImage"),
  questionLanguageControl: document.getElementById("questionLanguageControl"),
  questionLanguageSelect: document.getElementById("questionLanguageSelect"),
  questionPlusButton: document.getElementById("questionPlusButton"),
  questionTopic: document.getElementById("questionTopic"),
  questionText: document.getElementById("questionText"),
  questionTranslation: document.getElementById("questionTranslation"),
  questionTranslationLabel: document.getElementById("questionTranslationLabel"),
  translatedQuestionText: document.getElementById("translatedQuestionText"),
  answerButtons: [...document.querySelectorAll(".answer-button")],
  prevButton: document.getElementById("prevButton"),
  nextButton: document.getElementById("nextButton"),
  finishButton: document.getElementById("finishButton"),
  questionActions: document.getElementById("questionActions"),
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
  demoRegistrationCard: document.getElementById("demoRegistrationCard"),
  demoRegisterButton: document.getElementById("demoRegisterButton"),
  modalBackdrop: document.getElementById("modalBackdrop"),
  accountPanel: document.getElementById("accountPanel"),
  accountPanelKicker: document.getElementById("accountPanelKicker"),
  accountPanelTitle: document.getElementById("accountPanelTitle"),
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
  authIntro: document.getElementById("authIntro"),
  accountEmail: document.getElementById("accountEmail"),
  signOutButton: document.getElementById("signOutButton"),
  profileTabs: document.getElementById("profileTabs"),
  profileAdminTab: document.getElementById("profileAdminTab"),
  progressTotal: document.getElementById("progressTotal"),
  progressPassed: document.getElementById("progressPassed"),
  progressAverage: document.getElementById("progressAverage"),
  revisionExamButton: document.getElementById("revisionExamButton"),
  revisionSummary: document.getElementById("revisionSummary"),
  progressChart: document.getElementById("progressChart"),
  accountLanguageSelect: document.getElementById("accountLanguageSelect"),
  translationSettings: document.getElementById("translationSettings"),
  translationUpgrade: document.getElementById("translationUpgrade"),
  translationPlusButton: document.getElementById("translationPlusButton"),
  customLanguageField: document.getElementById("customLanguageField"),
  customLanguageInput: document.getElementById("customLanguageInput"),
  translationPreferenceStatus: document.getElementById(
    "translationPreferenceStatus",
  ),
  plusStatus: document.getElementById("plusStatus"),
  plusConsentRow: document.getElementById("plusConsentRow"),
  plusConsent: document.getElementById("plusConsent"),
  plusBuyButton: document.getElementById("plusBuyButton"),
  plusResetButton: document.getElementById("plusResetButton"),
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

let authState = {
  token: localStorage.getItem(AUTH_TOKEN_KEY),
  user: null,
  progress: null,
  restoring: Boolean(localStorage.getItem(AUTH_TOKEN_KEY)),
};
let state = restoreDemoSession() ?? createExam({ mode: "demo", count: 1 });
let plusState = {
  token: null,
  active: false,
  expiresAt: null,
  loading: false,
  message: "",
  recoverable: false,
  pendingSession: localStorage.getItem(PLUS_PENDING_SESSION_KEY),
  pendingCheckoutUrl: storedStripeCheckoutUrl(),
};
let adminState = { data: null, view: "users", loading: false, error: "" };
let profileView = "summary";
let translationState = { language: restoreLanguagePreference() };
let timerId = 0;
let deferredInstallPrompt = null;
let drawerClosingTimer = 0;
let accountClosingTimer = 0;
let customLanguageTimer = 0;
let authIntent = "default";
let accessEpoch = 0;
let accountReturnFocus = null;

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
  els.accountPanel.addEventListener("keydown", trapAccountFocus);
  els.emailLoginForm.addEventListener("submit", requestLoginCode);
  els.codeLoginForm.addEventListener("submit", verifyLoginCode);
  els.loginCode.addEventListener("input", () => {
    els.loginCode.value = els.loginCode.value.replace(/\D/g, "").slice(0, 6);
  });
  els.signOutButton.addEventListener("click", signOut);
  els.revisionExamButton.addEventListener("click", startRevisionExam);
  els.profileTabs.addEventListener("click", (event) => {
    const tab = event.target.closest("[data-profile-tab]");
    if (!tab || tab.hidden) return;
    setProfileView(tab.dataset.profileTab);
  });
  els.questionLanguageSelect.addEventListener(
    "change",
    handleQuestionLanguageChange,
  );
  els.accountLanguageSelect.addEventListener(
    "change",
    handleAccountLanguageChange,
  );
  els.customLanguageInput.addEventListener("input", handleCustomLanguageInput);
  els.questionPlusButton.addEventListener("click", openPlusPanel);
  els.translationPlusButton.addEventListener("click", openPlusPanel);
  els.demoRegisterButton.addEventListener("click", promptDemoRegistration);
  els.plusBuyButton.addEventListener("click", startPlusCheckout);
  els.plusResetButton.addEventListener("click", clearPendingPlusCheckout);
  els.refreshAdminButton.addEventListener("click", () =>
    loadAdminDashboard(true),
  );
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

function createExam(options = {}) {
  const now = Date.now();
  const mode = options.mode || "simulation";
  const fallbackId = crypto.randomUUID?.() ?? String(now);
  const sourceQuestions =
    Array.isArray(options.questions) && options.questions.length > 0
      ? options.questions
      : allQuestions;
  const questions = sample(
    sourceQuestions,
    options.count ?? settings.examQuestions,
  );
  return {
    id:
      mode === "revision"
        ? `revision-${fallbackId}`
        : mode === "demo"
          ? `demo-${fallbackId}`
          : fallbackId,
    mode,
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

function sessionStorageKey(userId = authState.user?.id) {
  return userId ? `${STORAGE_KEY_PREFIX}:${userId}` : null;
}

function restoreSession() {
  try {
    const key = sessionStorageKey();
    if (!key) return null;
    const saved = JSON.parse(localStorage.getItem(key) ?? "null");
    if (!saved || saved.finished || Date.now() >= saved.endsAt) return null;
    if (saved.mode === "demo") return null;
    if (!Array.isArray(saved.questions) || saved.questions.length === 0)
      return null;
    return saved;
  } catch {
    return null;
  }
}

function restoreDemoSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(DEMO_STORAGE_KEY) ?? "null");
    if (!saved || saved.mode !== "demo") return null;
    if (!Array.isArray(saved.questions) || saved.questions.length !== 1)
      return null;
    if (!Array.isArray(saved.answers) || saved.answers.length !== 1)
      return null;
    return saved;
  } catch {
    return null;
  }
}

function persistSession() {
  const key = state.mode === "demo" ? DEMO_STORAGE_KEY : sessionStorageKey();
  if (!key) return;
  localStorage.setItem(key, JSON.stringify(state));
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
    return (
      PRESET_LANGUAGES.find((language) => language.code === saved.code) ||
      ORIGINAL_LANGUAGE
    );
  } catch {
    return ORIGINAL_LANGUAGE;
  }
}

function persistLanguagePreference() {
  localStorage.setItem(
    LANGUAGE_PREF_KEY,
    JSON.stringify(translationState.language),
  );
}

function getActiveTranslationLanguage() {
  const language = translationState.language;
  if (
    !authState.user ||
    !hasActivePlus() ||
    !language ||
    language.code === "it"
  )
    return null;
  if (language.custom && !language.label.trim()) return null;
  return language;
}

function isCustomLanguageSelected() {
  return (
    translationState.language?.custom ||
    translationState.language?.code === "custom"
  );
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
  if (!hasActivePlus()) {
    openPlusPanel();
    return;
  }
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
  if (!hasActivePlus()) {
    openPlusPanel();
    return;
  }
  const selected = languageFromSelectValue(event.target.value);
  if (selected?.code === "custom") {
    const label = els.customLanguageInput.value.trim();
    setTranslationLanguage({ code: "custom", label, custom: true }, false);
    els.customLanguageField.hidden = false;
    els.translationPreferenceStatus.textContent = label
      ? `Userò ${label} come lingua di traduzione.`
      : "Scrivi il nome della lingua personalizzata.";
    if (!label) els.customLanguageInput.focus();
    if (label) setTranslationLanguage({ code: "custom", label, custom: true });
    return;
  }
  setTranslationLanguage(selected);
}

function handleCustomLanguageInput() {
  if (!hasActivePlus()) return;
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
      label: translationState.language?.custom
        ? translationState.language.label
        : "",
      custom: true,
    };
  }
  return (
    PRESET_LANGUAGES.find((language) => language.code === value) ||
    ORIGINAL_LANGUAGE
  );
}

function renderLanguageControls() {
  const isSignedIn = Boolean(authState.user);
  const hasPlus = isSignedIn && hasActivePlus();
  els.questionLanguageControl.hidden = !hasPlus;
  els.questionPlusButton.hidden = !isSignedIn || hasPlus;
  els.translationSettings.hidden = !hasPlus;
  els.translationUpgrade.hidden = hasPlus;
  populateLanguageSelect(els.questionLanguageSelect, {
    includeCustomPlaceholder: false,
  });
  populateLanguageSelect(els.accountLanguageSelect, {
    includeCustomPlaceholder: true,
  });

  const selectValue = isCustomLanguageSelected()
    ? "custom"
    : translationState.language.code;
  els.questionLanguageSelect.value = selectValue;
  els.accountLanguageSelect.value = selectValue;
  els.customLanguageField.hidden = !hasPlus || !isCustomLanguageSelected();
  els.customLanguageInput.value = isCustomLanguageSelected()
    ? translationState.language.label
    : "";

  if (!hasPlus) {
    els.questionTranslation.hidden = true;
    els.translatedQuestionText.textContent = "";
    return;
  }

  const activeLanguage = getActiveTranslationLanguage();
  if (!activeLanguage && isCustomLanguageSelected()) {
    els.translationPreferenceStatus.textContent =
      "Scrivi il nome della lingua personalizzata.";
  } else if (activeLanguage) {
    els.translationPreferenceStatus.textContent = `Le domande e le spiegazioni saranno tradotte in ${activeLanguage.label}.`;
  } else {
    els.translationPreferenceStatus.textContent =
      "Mostro il testo ministeriale originale in italiano.";
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
    option.textContent =
      translationState.language?.custom && translationState.language.label
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
  loadTranslation(question, "")
    .then((translation) => {
      if (
        !getActiveTranslationLanguage() ||
        state.finished ||
        state.questions[state.currentIndex]?.id !== question.id
      )
        return;
      els.translatedQuestionText.textContent = translation.questionText;
    })
    .catch((error) => {
      if (
        !getActiveTranslationLanguage() ||
        state.finished ||
        state.questions[state.currentIndex]?.id !== question.id
      )
        return;
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
  if (pendingTranslations.has(cacheKey))
    return pendingTranslations.get(cacheKey);
  const requestUserId = authState.user?.id;
  const requestEpoch = accessEpoch;

  const promise = authFetch("./api/translation", {
    method: "POST",
    headers: plusHeaders(),
    body: JSON.stringify({
      questionId: question.id,
      language,
      explanation,
    }),
  })
    .then((response) => {
      if (
        accessEpoch === requestEpoch &&
        hasActivePlus() &&
        authState.user?.id === requestUserId
      ) {
        translationCache.set(cacheKey, response.translation);
      }
      return response.translation;
    })
    .finally(() => {
      if (accessEpoch === requestEpoch) pendingTranslations.delete(cacheKey);
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
  if (authState.restoring) {
    renderAuthLoading();
    return;
  }
  if (state.finished) {
    renderResults();
    return;
  }

  const question = state.questions[state.currentIndex];
  const answer = state.answers[state.currentIndex];
  const answeredCount = state.answers.filter((item) => item !== null).length;
  const isDemo = state.mode === "demo";

  els.questionPanel.hidden = false;
  els.examControls.hidden = false;
  els.newExamButton.disabled = false;
  els.resultsPanel.hidden = true;
  els.questionPanel.classList.remove("auth-loading-panel");
  els.demoRegistrationCard.hidden = true;
  els.questionActions.hidden = isDemo;
  els.questionDrawerButton.hidden = isDemo;
  els.thresholdLabel.textContent = isDemo ? "Accesso" : "Soglia";
  els.threshold.textContent = isDemo ? "Demo" : `${settings.maxErrors} errori`;
  els.timerLabel.textContent = "Tempo";
  els.newExamButton.textContent = authState.user ? "Nuovo test" : "Registrati";
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
    button.classList.toggle(
      "selected",
      answer === (button.dataset.answer === "true"),
    );
  });

  els.prevButton.disabled = state.currentIndex === 0;
  els.nextButton.disabled = state.currentIndex === state.questions.length - 1;
  els.finishButton.classList.toggle(
    "finish-ready",
    state.currentIndex === state.questions.length - 1 &&
      state.answers[state.currentIndex] !== null,
  );
  renderDots();
  tickTimer();
}

function renderAuthLoading() {
  els.questionPanel.hidden = false;
  els.examControls.hidden = true;
  els.resultsPanel.hidden = true;
  els.newExamButton.disabled = true;
  els.questionDrawerButton.hidden = true;
  els.questionMedia.hidden = true;
  els.questionTranslation.hidden = true;
  els.questionPanel.classList.remove("has-media", "has-answer");
  els.questionPanel.classList.add("no-media", "auth-loading-panel");
  els.questionTopic.textContent = "Account";
  els.questionText.textContent = "Ripristino il tuo accesso...";
  els.questionCounter.textContent = "—";
  els.answeredCounter.textContent = "—";
  els.timer.textContent = "—";
  els.timerLabel.textContent = "Stato";
  els.thresholdLabel.textContent = "Stato";
  els.threshold.textContent = "Accesso";
  els.progressBar.style.width = "0%";
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
  if (state.mode === "demo") {
    finishExam("demo");
    return;
  }
  if (state.currentIndex < state.questions.length - 1) {
    state.currentIndex += 1;
  }
  persistSession();
  render();
}

function isTypingTarget(target) {
  return (
    ["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName) ||
    target?.isContentEditable
  );
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
  if (!authState.user) {
    promptDemoRegistration();
    return;
  }
  if (
    hasActiveExamProgress() &&
    !window.confirm("Vuoi abbandonare il test in corso e iniziarne uno nuovo?")
  ) {
    return;
  }

  state = createExam();
  persistSession();
  closeQuestionDrawer();
  render();
}

function startRevisionExam() {
  const revisionIds = authState.progress?.revision?.questionIds ?? [];
  const revisionQuestions = revisionIds
    .map((id) => questionsById.get(String(id)))
    .filter(Boolean);

  if (revisionQuestions.length === 0) {
    window.alert("Non ci sono ancora errori salvati da ripassare.");
    return;
  }

  if (
    hasActiveExamProgress() &&
    !window.confirm("Vuoi abbandonare il test in corso e iniziare un ripasso?")
  ) {
    return;
  }

  state = createExam({
    mode: "revision",
    questions: revisionQuestions,
    count: Math.min(settings.examQuestions, revisionQuestions.length),
  });
  persistSession();
  closeAccountPanel();
  closeQuestionDrawer();
  render();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function hasActiveExamProgress() {
  return (
    !state.finished &&
    (state.currentIndex > 0 || state.answers.some((answer) => answer !== null))
  );
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
  reconcilePlusExpiry();
  if (state.finished) return;
  if (state.mode === "demo") {
    els.timer.textContent = "Libero";
    return;
  }
  const remaining = Math.max(0, state.endsAt - Date.now());
  els.timer.textContent = formatDuration(remaining);
  if (remaining === 0) finishExam("timeout");
}

function finishExam(reason) {
  if (state.finished) return;
  state.finished = true;
  state.finishedAt = Date.now();
  state.finishReason = reason;
  if (state.mode === "demo") {
    persistSession();
    renderResults();
    window.setTimeout(promptDemoRegistration, 180);
    return;
  }
  persistResult();
  syncFinishedExam();
  const key = sessionStorageKey();
  if (key) localStorage.removeItem(key);
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
    passed: state.mode === "demo" ? errors === 0 : errors <= settings.maxErrors,
    usedMs: Math.max(0, (state.finishedAt ?? Date.now()) - state.startedAt),
  };
}

function renderResults() {
  const result = calculateResult();
  const isDemo = state.mode === "demo";
  els.questionPanel.hidden = true;
  els.examControls.hidden = true;
  els.resultsPanel.hidden = false;
  els.newExamButton.disabled = false;
  els.questionActions.hidden = isDemo;
  els.questionDrawerButton.hidden = isDemo;
  els.demoRegistrationCard.hidden = !isDemo;
  els.thresholdLabel.textContent = isDemo ? "Accesso" : "Soglia";
  els.threshold.textContent = isDemo ? "Demo" : `${settings.maxErrors} errori`;
  els.timerLabel.textContent = "Tempo";
  els.newExamButton.textContent = authState.user ? "Nuovo test" : "Registrati";
  closeQuestionDrawer();
  els.progressBar.style.width = "100%";
  els.questionCounter.textContent = `${state.questions.length}/${state.questions.length}`;
  els.answeredCounter.textContent = `${state.answers.filter((item) => item !== null).length}/${state.questions.length}`;
  els.timer.textContent = isDemo
    ? "Libero"
    : formatDuration(
        Math.max(0, state.endsAt - (state.finishedAt ?? Date.now())),
      );
  els.finishButton.classList.remove("finish-ready");
  els.resultLabel.textContent = isDemo
    ? result.passed
      ? "Risposta corretta"
      : "Risposta da rivedere"
    : result.passed
      ? "Promosso"
      : "Respinto";
  if (isDemo) {
    els.resultTitle.textContent = "Demo completata";
  } else if (state.mode === "revision") {
    els.resultLabel.textContent = "Ripasso";
    els.resultTitle.textContent =
      result.errors === 0 ? "Errori sistemati" : "Ripasso completato";
  } else {
    els.resultTitle.textContent = result.passed
      ? "Scheda superata"
      : "Troppi errori";
  }
  els.resultScore.textContent = isDemo
    ? result.passed
      ? "Hai risposto correttamente"
      : "La risposta corretta è indicata sotto"
    : `${result.errors} ${result.errors === 1 ? "errore" : "errori"}`;
  els.correctCount.textContent = String(result.correct);
  els.errorCount.textContent = String(result.errors);
  els.usedTime.textContent = formatDuration(result.usedMs);
  renderReviewList();
}

function renderReviewList() {
  els.reviewList.innerHTML = "";

  if (state.mode !== "demo" && authState.user && !hasActivePlus()) {
    els.reviewList.append(createPlusUpgradePanel());
  }

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
    status.textContent =
      answer === null ? "Non risposta" : isCorrect ? "Corretta" : "Incorretta";

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

    item.append(textGroup);
    if (hasActivePlus()) {
      const explanation = createAiExplanationPanel(question, answer);
      item.append(explanation);
    }
    els.reviewList.append(item);
  });
}

function createPlusUpgradePanel() {
  const panel = document.createElement("section");
  panel.className = "tier-upgrade-card";

  const kicker = document.createElement("span");
  kicker.className = "plus-kicker";
  kicker.textContent = "Quiz Patente Plus";

  const title = document.createElement("h3");
  title.textContent = "Vuoi capire perché hai sbagliato?";

  const copy = document.createElement("p");
  copy.textContent =
    "Con Plus sblocchi le spiegazioni di ogni risposta e le traduzioni delle domande.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary-button";
  button.textContent = "Scopri Plus";
  button.addEventListener("click", openPlusPanel);

  panel.append(kicker, title, copy, button);
  return panel;
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
  const panel = document.createElement("details");
  panel.className = "ai-explanation ai-explanation-collapsible";
  panel.dataset.questionId = String(question.id);
  panel.dataset.lazyExplanation = "true";

  const header = document.createElement("summary");
  header.className = "ai-explanation-header";

  const title = document.createElement("div");
  const heading = document.createElement("h3");
  heading.textContent = "Spiegazione";
  title.append(heading);

  const hint = document.createElement("span");
  hint.className = "ai-explanation-hint";

  const body = document.createElement("div");
  body.className = "ai-explanation-body";

  header.append(title, hint);
  panel.append(header, body);

  const cached = explanationCache.get(question.id);
  if (cached) {
    panel.dataset.explanationLoaded = "true";
    renderAiExplanationBody(body, question, answer, cached);
  } else {
    renderExplanationPrompt(body);
    explanationTargets.set(panel, { question, answer });
  }

  updateExplanationToggleHint(panel, hint);
  panel.addEventListener("toggle", () => {
    updateExplanationToggleHint(panel, hint);
    if (!panel.open || panel.dataset.explanationLoaded === "true") return;
    renderExplanationSkeleton(body);
    loadExplanationPanel(panel);
  });

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

  const translatedExplanation = createTranslatedExplanationPanel(
    question,
    correctExplanation,
  );

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

  loadTranslation(question, cleanExplanationText(explanation))
    .then((translation) => {
      text.textContent = translation.explanation || translation.questionText;
    })
    .catch((error) => {
      text.textContent =
        error.message || "Traduzione non disponibile in questo momento.";
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

  loadTranslation(question, "")
    .then((translation) => {
      text.textContent = translation.questionText;
    })
    .catch((error) => {
      text.textContent =
        error.message || "Traduzione non disponibile in questo momento.";
    });

  return panel;
}

function cleanExplanationText(text) {
  return String(text || "")
    .replace(/^(vero|falso)\s*[:.-]\s*/i, "")
    .trim();
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

async function loadExplanationPanel(panel) {
  const target = explanationTargets.get(panel);
  if (
    !target ||
    !hasActivePlus() ||
    panel.dataset.explanationLoaded === "true"
  ) {
    return;
  }
  const body = panel.querySelector(".ai-explanation-body");
  const requestEpoch = accessEpoch;
  const requestUserId = authState.user?.id;
  const questionId = target.question.id;
  let request = pendingExplanationLoads.get(questionId);

  if (!request) {
    request = authFetch("./api/explanation", {
      method: "POST",
      headers: plusHeaders(),
      body: JSON.stringify({ questionId }),
    })
      .then((response) => {
        if (
          accessEpoch === requestEpoch &&
          hasActivePlus() &&
          authState.user?.id === requestUserId
        ) {
          explanationCache.set(questionId, response.explanation);
        }
        return response.explanation;
      })
      .finally(() => {
        if (pendingExplanationLoads.get(questionId) === request) {
          pendingExplanationLoads.delete(questionId);
        }
      });
    pendingExplanationLoads.set(questionId, request);
  }

  try {
    const explanation = await request;
    if (
      accessEpoch !== requestEpoch ||
      !hasActivePlus() ||
      authState.user?.id !== requestUserId ||
      !panel.isConnected
    ) {
      return;
    }
    panel.dataset.explanationLoaded = "true";
    renderAiExplanationBody(body, target.question, target.answer, explanation);
  } catch (error) {
    if (
      accessEpoch !== requestEpoch ||
      !hasActivePlus() ||
      !panel.isConnected ||
      error.stale
    )
      return;
    body.innerHTML = "";
    const message = document.createElement("p");
    message.className = "ai-status ai-status-error";
    message.textContent =
      error.message || "Spiegazione non disponibile in questo momento.";
    body.append(message);
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
      if (!authState.token) {
        throw new Error("Accedi per inviare una segnalazione.");
      }
      await authFetch("./api/report-explanation", {
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
  if (!authState.token) {
    const params = new URLSearchParams(window.location.search);
    const fragment = new URLSearchParams(
      window.location.hash.replace(/^#/, ""),
    );
    if (params.has("checkout") || fragment.has("plus_token")) {
      openAccountPanel();
      setAuthStatus(
        "Accedi per completare l’attivazione di Quiz Patente Plus.",
      );
    } else if (state.mode === "demo" && state.finished) {
      window.setTimeout(promptDemoRegistration, 180);
    }
    return;
  }

  const requestContext = captureAuthContext();
  try {
    const response = await authFetch("./api/auth-me");
    authState.user = response.user;
    authState.progress = response.progress;
    authState.restoring = false;
    plusState.token = storedPlusTokenForUser(response.user.id);
    enterAuthenticatedExperience();
    renderAuth();
    await syncPlusAccessFromLocation();
  } catch (error) {
    if (error.stale || !isCurrentAuthContext(requestContext)) return;
    localStorage.removeItem(AUTH_TOKEN_KEY);
    authState = { token: null, user: null, progress: null, restoring: false };
    adminState = { data: null, view: "users", loading: false, error: "" };
    clearPremiumContentCaches();
    renderAuth();
    render();
    if (state.mode === "demo" && state.finished) {
      window.setTimeout(promptDemoRegistration, 180);
    }
  }
}

function openAccountPanel() {
  window.clearTimeout(accountClosingTimer);
  if (els.accountPanel.hidden) accountReturnFocus = document.activeElement;
  els.accountPanel.hidden = false;
  els.modalBackdrop.hidden = false;
  requestAnimationFrame(() => {
    document.body.classList.add("account-open");
    window.setTimeout(focusAccountPanel, 80);
  });
  renderAccountPanelCopy();
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
    authIntent = "default";
    if (accountReturnFocus?.isConnected) accountReturnFocus.focus();
    accountReturnFocus = null;
  }, 260);
}

function focusAccountPanel() {
  const target = authState.user
    ? els.profileTabs.querySelector(".profile-tab.active") ||
      els.closeAccountButton
    : els.codeLoginForm.hidden
      ? els.loginEmail
      : els.loginCode;
  target?.focus();
}

function trapAccountFocus(event) {
  if (event.key !== "Tab" || els.accountPanel.hidden) return;
  const focusable = [
    ...els.accountPanel.querySelectorAll(
      "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
    ),
  ].filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function promptDemoRegistration() {
  if (authState.user) return;
  authIntent = "demo";
  openAccountPanel();
  accountReturnFocus = els.demoRegisterButton;
}

function openPlusPanel() {
  if (!authState.user) {
    promptDemoRegistration();
    return;
  }
  authIntent = "default";
  setProfileView("plus");
  openAccountPanel();
}

function renderAccountPanelCopy() {
  if (authState.user) {
    els.accountPanelKicker.textContent = hasActivePlus()
      ? "Account Plus"
      : "Account Free";
    els.accountPanelTitle.textContent = "Profilo";
    return;
  }
  const fromDemo = authIntent === "demo";
  els.accountPanelKicker.textContent = fromDemo ? "Demo completata" : "Account";
  els.accountPanelTitle.textContent = fromDemo
    ? "Continua gratis"
    : "Accedi o registrati";
  els.authIntro.textContent = fromDemo
    ? "Inserisci la tua email per iniziare le simulazioni complete in italiano. Ti invieremo un codice a sei cifre."
    : "Inserisci la tua email: ti invieremo un codice di accesso a sei cifre.";
}

function enterAuthenticatedExperience() {
  state = restoreSession() ?? createExam();
  localStorage.removeItem(LEGACY_STORAGE_KEY);
  localStorage.removeItem(DEMO_STORAGE_KEY);
  persistSession();
  closeQuestionDrawer();
  render();
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
    const cameFromDemo = state.mode === "demo";
    const response = await fetchJson("./api/auth-verify", {
      method: "POST",
      body: JSON.stringify({ email, code }),
    });
    authState.token = response.token;
    authState.user = response.user;
    authState.progress = response.progress;
    authState.restoring = false;
    plusState.token = storedPlusTokenForUser(response.user.id);
    adminState = { data: null, view: "users", loading: false, error: "" };
    localStorage.setItem(AUTH_TOKEN_KEY, response.token);
    els.loginCode.value = "";
    setAuthStatus("");
    enterAuthenticatedExperience();
    renderAuth();
    await syncPlusAccessFromLocation();
    if (cameFromDemo) {
      accountReturnFocus = els.questionPanel;
      closeAccountPanel();
    }
  } catch (error) {
    setAuthStatus(error.message || "Codice non valido.");
  } finally {
    els.verifyCodeButton.disabled = false;
  }
}

async function signOut() {
  const token = authState.token;
  resetToAnonymousDemo();
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

function resetToAnonymousDemo() {
  const previousUserId = authState.user?.id;
  authState = { token: null, user: null, progress: null, restoring: false };
  plusState = {
    token: null,
    active: false,
    expiresAt: null,
    loading: false,
    message: "",
    recoverable: false,
    pendingSession: null,
    pendingCheckoutUrl: null,
  };
  adminState = { data: null, view: "users", loading: false, error: "" };
  if (previousUserId) removePlusTokenForUser(previousUserId);
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(DEMO_STORAGE_KEY);
  localStorage.removeItem(PLUS_PENDING_SESSION_KEY);
  localStorage.removeItem(PLUS_PENDING_CHECKOUT_URL_KEY);
  localStorage.removeItem(PLUS_CHECKOUT_ATTEMPT_KEY);
  clearPremiumContentCaches();
  state = createExam({ mode: "demo", count: 1 });
  persistSession();
  closeQuestionDrawer();
  closeAccountPanel();
  renderAuth();
  render();
}

function downgradeToFree(message) {
  const userId = authState.user?.id;
  plusState.active = false;
  plusState.expiresAt = null;
  plusState.token = null;
  plusState.recoverable = false;
  plusState.message = message || "Quiz Patente Plus non è attivo.";
  if (userId) removePlusTokenForUser(userId);
  clearPremiumContentCaches();
  renderAuth();
  render();
  if (authState.user) openPlusPanel();
}

function renderAuth() {
  const isSignedIn = Boolean(authState.user);
  els.accountButton.disabled = authState.restoring;
  els.accountButton.textContent = authState.restoring
    ? "Carico..."
    : isSignedIn
      ? hasActivePlus()
        ? "Plus · Profilo"
        : "Profilo"
      : "Accedi";
  renderAccountPanelCopy();
  els.authSignedOut.hidden = isSignedIn;
  els.authSignedIn.hidden = !isSignedIn;
  els.profileAdminTab.hidden = !authState.user?.isAdmin;
  renderLanguageControls();
  renderPlus();

  if (!isSignedIn) {
    profileView = "summary";
    renderProgress(null);
    renderAdmin();
    renderProfileView();
    return;
  }

  if (!authState.user.isAdmin && profileView === "admin") {
    profileView = "summary";
  }

  els.accountEmail.textContent = authState.user.email;
  renderProgress(authState.progress);
  renderAdmin();
  renderProfileView();
  if (
    authState.user.isAdmin &&
    profileView === "admin" &&
    !adminState.data &&
    !adminState.loading &&
    !adminState.error
  ) {
    loadAdminDashboard();
  }
  if (state.finished) {
    renderReviewList();
  } else {
    renderQuestionTranslation(state.questions[state.currentIndex]);
  }
}

function setProfileView(view) {
  const allowedViews = ["summary", "tests", "translations", "plus", "admin"];
  profileView = allowedViews.includes(view) ? view : "summary";
  if (profileView === "admin" && !authState.user?.isAdmin) {
    profileView = "summary";
  }
  renderProfileView();
  if (
    profileView === "admin" &&
    authState.user?.isAdmin &&
    !adminState.data &&
    !adminState.loading &&
    !adminState.error
  ) {
    loadAdminDashboard();
  }
}

function renderProfileView() {
  els.profileTabs.querySelectorAll("[data-profile-tab]").forEach((tab) => {
    const isActive = tab.dataset.profileTab === profileView;
    tab.classList.toggle("active", isActive);
    tab.setAttribute("aria-selected", String(isActive));
  });

  els.authSignedIn.querySelectorAll("[data-profile-view]").forEach((panel) => {
    const isAdminPanel = panel.dataset.profileView === "admin";
    panel.hidden =
      panel.dataset.profileView !== profileView ||
      (isAdminPanel && !authState.user?.isAdmin);
  });
}

function plusHeaders() {
  return plusState.token ? { "X-Quizpatente-Plus": plusState.token } : {};
}

function hasActivePlus() {
  const expiresAt = new Date(plusState.expiresAt || "").getTime();
  return Boolean(
    plusState.active && Number.isFinite(expiresAt) && expiresAt > Date.now(),
  );
}

function clearPremiumContentCaches() {
  accessEpoch += 1;
  explanationCache.clear();
  translationCache.clear();
  pendingExplanationLoads.clear();
  pendingTranslations.clear();
  explanationTargets = new WeakMap();
}

function reconcilePlusExpiry() {
  if (!plusState.active || hasActivePlus()) return;
  const userId = authState.user?.id;
  plusState.active = false;
  plusState.expiresAt = null;
  plusState.token = null;
  plusState.message = "Il pass Plus è scaduto.";
  if (userId) removePlusTokenForUser(userId);
  clearPremiumContentCaches();
  renderAuth();
  render();
}

function readPlusTokenMap() {
  try {
    const value = JSON.parse(localStorage.getItem(PLUS_TOKENS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
  } catch {
    return {};
  }
}

function storedPlusTokenForUser(userId) {
  if (!userId) return null;
  return (
    readPlusTokenMap()[String(userId)] ||
    localStorage.getItem(PLUS_TOKEN_LEGACY_KEY)
  );
}

function storePlusTokenForUser(userId, token) {
  if (!userId || !token) return;
  const tokens = readPlusTokenMap();
  tokens[String(userId)] = token;
  localStorage.setItem(PLUS_TOKENS_KEY, JSON.stringify(tokens));
  localStorage.removeItem(PLUS_TOKEN_LEGACY_KEY);
}

function removePlusTokenForUser(userId) {
  if (!userId) return;
  const tokens = readPlusTokenMap();
  delete tokens[String(userId)];
  localStorage.setItem(PLUS_TOKENS_KEY, JSON.stringify(tokens));
  localStorage.removeItem(PLUS_TOKEN_LEGACY_KEY);
}

function storedStripeCheckoutUrl() {
  try {
    const value = localStorage.getItem(PLUS_PENDING_CHECKOUT_URL_KEY);
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "checkout.stripe.com"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

async function syncPlusAccessFromLocation() {
  if (!authState.user || !authState.token) return;
  const requestContext = captureAuthContext();

  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const importedToken = fragment.get("plus_token");
  const checkoutState = url.searchParams.get("checkout");
  const returnedSession = url.searchParams.get("session_id");
  if (returnedSession) {
    plusState.pendingSession = returnedSession;
    localStorage.setItem(PLUS_PENDING_SESSION_KEY, returnedSession);
  }

  if (importedToken) {
    const previousToken = plusState.token;
    plusState.token = importedToken;
    const imported = await refreshPlusAccess({ persistOnSuccess: true });
    if (imported.stale || !isCurrentAuthContext(requestContext)) return;
    if (!imported.checked) {
      plusState.token = importedToken;
      plusState.active = false;
      plusState.expiresAt = null;
      plusState.recoverable = true;
    } else if (!imported.active) {
      plusState.token = previousToken;
      plusState.active = false;
      plusState.expiresAt = null;
      plusState.recoverable = false;
      if (previousToken) {
        await refreshPlusAccess({
          persistOnSuccess: true,
          removeInvalid: true,
        });
        if (!isCurrentAuthContext(requestContext)) return;
      }
    }
    plusState.message = imported.active
      ? "Quiz Patente Plus è attivo su questo dispositivo."
      : imported.checked
        ? "Il link Plus non è valido per questo account o è scaduto."
        : "Non riesco a verificare il link ora. Puoi riprovare.";
    setProfileView("plus");
    openAccountPanel();
  } else if (checkoutState === "cancelled") {
    plusState.message = plusState.pendingCheckoutUrl
      ? "Checkout sospeso senza conferma di pagamento. Riapri la stessa sessione per continuare senza creare un secondo addebito."
      : "Checkout sospeso. Conserviamo il riferimento finché Stripe non conferma il pagamento o la scadenza.";
    plusState.recoverable = false;
    setProfileView("plus");
    openAccountPanel();
    renderPlus();
  } else if (checkoutState === "success" || plusState.pendingSession) {
    await activatePlusCheckout(plusState.pendingSession);
    if (!isCurrentAuthContext(requestContext)) return;
  } else {
    await refreshPlusAccess({ persistOnSuccess: true, removeInvalid: true });
    if (!isCurrentAuthContext(requestContext)) return;
  }

  if (importedToken || checkoutState || returnedSession) {
    ["checkout", "session_id"].forEach((key) => url.searchParams.delete(key));
    fragment.delete("plus_token");
    url.hash = fragment.toString() ? `#${fragment}` : "";
    const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
    window.history.replaceState({}, "", cleanUrl);
  }
}

async function refreshPlusAccess({
  persistOnSuccess = false,
  removeInvalid = false,
} = {}) {
  if (!authState.user) {
    plusState.active = false;
    plusState.expiresAt = null;
    plusState.recoverable = false;
    clearPremiumContentCaches();
    renderAuth();
    render();
    return { checked: true, active: false };
  }

  const requestContext = captureAccessContext();
  try {
    const response = await authFetch("./api/plus-status", {
      headers: plusHeaders(),
    });
    if (!isCurrentAccessContext(requestContext)) {
      return { checked: false, active: false, stale: true };
    }
    if (response.token) plusState.token = response.token;
    plusState.active = Boolean(response.access?.active);
    plusState.expiresAt = response.access?.expiresAt || null;
    plusState.recoverable = false;
    if (
      hasActivePlus() &&
      plusState.token &&
      (persistOnSuccess || response.token)
    ) {
      storePlusTokenForUser(requestContext.userId, plusState.token);
    }
    if (!hasActivePlus()) {
      clearPremiumContentCaches();
      if (removeInvalid) {
        removePlusTokenForUser(requestContext.userId);
        plusState.token = null;
      }
    }
    renderAuth();
    render();
    return { checked: true, active: hasActivePlus() };
  } catch (error) {
    if (
      error.stale ||
      error.accessHandled ||
      !isCurrentAccessContext(requestContext)
    ) {
      return { checked: false, active: false, stale: true };
    }
    plusState.active = false;
    plusState.expiresAt = null;
    plusState.recoverable = true;
    plusState.message = error.message || "Non riesco a verificare Plus ora.";
    clearPremiumContentCaches();
    renderAuth();
    render();
    return { checked: false, active: false };
  }
}

async function activatePlusCheckout(sessionId) {
  if (!sessionId) {
    plusState.message =
      "Riferimento del pagamento mancante. Contatta l’assistenza.";
    plusState.recoverable = false;
    renderPlus();
    return false;
  }
  const requestContext = captureAccessContext();
  plusState.loading = true;
  plusState.pendingSession = sessionId;
  localStorage.setItem(PLUS_PENDING_SESSION_KEY, sessionId);
  plusState.message = "Verifico il pagamento e attivo Plus...";
  setProfileView("plus");
  openAccountPanel();
  renderPlus();

  try {
    const response = await authFetch("./api/plus-activate", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    if (!isCurrentAccessContext(requestContext)) return false;
    plusState.token = response.token;
    plusState.active = Boolean(response.access?.active);
    plusState.expiresAt = response.access?.expiresAt || null;
    plusState.recoverable = false;
    plusState.pendingSession = null;
    plusState.pendingCheckoutUrl = null;
    plusState.message = "Pagamento confermato. Quiz Patente Plus è attivo.";
    storePlusTokenForUser(requestContext.userId, response.token);
    localStorage.removeItem(PLUS_PENDING_SESSION_KEY);
    localStorage.removeItem(PLUS_PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PLUS_CHECKOUT_ATTEMPT_KEY);
    return true;
  } catch (error) {
    if (
      error.stale ||
      error.accessHandled ||
      !isCurrentAccessContext(requestContext)
    )
      return false;
    plusState.message = error.message || "Non riesco ad attivare Plus.";
    plusState.recoverable = true;
    return false;
  } finally {
    if (isCurrentAuthContext(requestContext)) {
      plusState.loading = false;
      renderAuth();
      render();
    }
  }
}

async function startPlusCheckout() {
  if (!authState.user || !authState.token) {
    setAuthStatus("Accedi prima di acquistare Quiz Patente Plus.");
    return;
  }
  if (hasActivePlus()) return;
  if (plusState.pendingSession) {
    if (plusState.pendingCheckoutUrl) {
      window.location.assign(plusState.pendingCheckoutUrl);
      return;
    }
    await activatePlusCheckout(plusState.pendingSession);
    return;
  }
  if (plusState.recoverable) {
    await refreshPlusAccess({ persistOnSuccess: true });
    return;
  }
  if (!els.plusConsent.checked) {
    plusState.message = "Conferma l’inizio immediato dell’accesso digitale.";
    renderPlus();
    els.plusConsent.focus();
    return;
  }

  const requestContext = captureAccessContext();
  plusState.loading = true;
  plusState.message = "Apro il pagamento sicuro...";
  renderPlus();

  try {
    const attemptId =
      localStorage.getItem(PLUS_CHECKOUT_ATTEMPT_KEY) ||
      createCheckoutAttemptId();
    localStorage.setItem(PLUS_CHECKOUT_ATTEMPT_KEY, attemptId);
    const response = await authFetch(PLUS_CHECKOUT_URL, {
      method: "POST",
      body: JSON.stringify({
        attemptId,
        immediateAccessConsent: true,
      }),
    });
    if (!isCurrentAccessContext(requestContext)) throw staleRequestError();
    const checkoutUrl = new URL(response.checkoutUrl || "");
    if (
      checkoutUrl.protocol !== "https:" ||
      checkoutUrl.hostname !== "checkout.stripe.com" ||
      !response.sessionId
    ) {
      throw new Error("Link di pagamento non valido.");
    }
    plusState.pendingSession = response.sessionId;
    plusState.pendingCheckoutUrl = checkoutUrl.toString();
    localStorage.setItem(PLUS_PENDING_SESSION_KEY, response.sessionId);
    localStorage.setItem(
      PLUS_PENDING_CHECKOUT_URL_KEY,
      plusState.pendingCheckoutUrl,
    );
    window.location.assign(checkoutUrl.toString());
  } catch (error) {
    if (error.stale || !isCurrentAccessContext(requestContext)) {
      if (isCurrentAuthContext(requestContext)) {
        plusState.loading = false;
        renderPlus();
      }
      return;
    }
    plusState.loading = false;
    plusState.message = error.message || "Pagamento non disponibile ora.";
    renderPlus();
  }
}

async function clearPendingPlusCheckout() {
  const sessionId = plusState.pendingSession;
  if (!sessionId) return;
  const requestContext = captureAccessContext();

  plusState.loading = true;
  plusState.message = "Controllo che il pagamento non sia stato completato...";
  renderPlus();

  try {
    const response = await authFetch("./api/plus-checkout-reset", {
      method: "POST",
      body: JSON.stringify({ sessionId }),
    });
    if (!isCurrentAccessContext(requestContext)) return;
    if (!response.discardable) {
      throw new Error("Questo pagamento non può essere scartato.");
    }
    plusState.pendingSession = null;
    plusState.pendingCheckoutUrl = null;
    plusState.recoverable = false;
    plusState.message =
      "Stripe conferma che la sessione è scaduta. Puoi iniziare un nuovo pagamento.";
    localStorage.removeItem(PLUS_PENDING_SESSION_KEY);
    localStorage.removeItem(PLUS_PENDING_CHECKOUT_URL_KEY);
    localStorage.removeItem(PLUS_CHECKOUT_ATTEMPT_KEY);
  } catch (error) {
    if (
      error.stale ||
      error.accessHandled ||
      !isCurrentAccessContext(requestContext)
    )
      return;
    plusState.message =
      error.message ||
      "Non posso scartare questo tentativo finché il suo stato non è certo. Riprova l’attivazione o contatta l’assistenza.";
    plusState.recoverable = true;
  } finally {
    if (isCurrentAuthContext(requestContext)) {
      plusState.loading = false;
      setProfileView("plus");
      openAccountPanel();
      renderAuth();
    }
  }
}

function createCheckoutAttemptId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const random = new Uint32Array(4);
  globalThis.crypto.getRandomValues(random);
  return [...random].map((value) => value.toString(16).padStart(8, "0")).join("");
}

function renderPlus() {
  if (!els.plusStatus) return;
  const active = hasActivePlus();

  if (active) {
    const expiry = new Intl.DateTimeFormat("it-IT", {
      day: "numeric",
      month: "long",
      year: "numeric",
    }).format(new Date(plusState.expiresAt));
    els.plusStatus.textContent =
      plusState.message || `Plus attivo fino al ${expiry}.`;
    els.plusBuyButton.textContent = `Plus attivo fino al ${expiry}`;
    els.plusBuyButton.disabled = true;
    els.plusResetButton.hidden = true;
    els.plusConsentRow.hidden = true;
  } else {
    els.plusStatus.textContent =
      plusState.message ||
      "Free include simulazioni complete in italiano, storico e ripasso degli errori.";
    els.plusBuyButton.textContent = plusState.loading
      ? "Attendo..."
      : plusState.pendingSession
        ? plusState.pendingCheckoutUrl
          ? "Riapri lo stesso checkout"
          : "Riprova l’attivazione"
        : plusState.recoverable
          ? "Riprova la verifica"
          : "Attiva Plus — €3,99";
    els.plusBuyButton.disabled = plusState.loading;
    els.plusResetButton.hidden = !plusState.pendingSession || plusState.loading;
    els.plusConsentRow.hidden = Boolean(
      plusState.pendingSession || plusState.recoverable,
    );
  }
}

function setAuthStatus(message) {
  els.authStatus.textContent = message;
}

async function loadProgress() {
  if (!authState.token) return;
  const requestContext = captureAuthContext();
  try {
    const response = await authFetch("./api/user-progress");
    authState.progress = response.progress;
    renderAuth();
  } catch (error) {
    if (error.stale || !isCurrentAuthContext(requestContext)) return;
    renderProgress(null, error.message || "Progressi non disponibili.");
  }
}

function renderProgress(progress, errorMessage = "") {
  const summary = progress?.summary ?? {
    total: 0,
    passed: 0,
    averageErrors: 0,
  };
  const recent = progress?.recent ?? [];
  const revision = progress?.revision ?? {
    uniqueWrongQuestions: 0,
    totalWrongAnswers: 0,
    questionIds: [],
  };

  els.progressTotal.textContent = String(summary.total);
  els.progressPassed.textContent = String(summary.passed);
  els.progressAverage.textContent = formatAverage(summary.averageErrors);
  els.progressList.innerHTML = "";
  renderRevisionCard(revision);
  renderProgressChart(recent);

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
    item.textContent = "I tuoi test completati appariranno qui.";
    els.progressList.append(item);
    return;
  }

  recent.forEach((exam) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "progress-item";
    item.setAttribute(
      "aria-label",
      `Rivedi test del ${formatDate(exam.finishedAt)}`,
    );

    const pill = document.createElement("span");
    pill.className = `result-pill ${exam.passed ? "result-pill-correct" : "result-pill-error"}`;
    if (exam.mode === "revision") {
      pill.className = "result-pill result-pill-neutral";
      pill.textContent = "Ripasso";
    } else {
      pill.textContent = exam.passed ? "Promossa" : "Respinta";
    }

    const title = document.createElement("strong");
    title.textContent = formatDate(exam.finishedAt);

    const detail = document.createElement("span");
    detail.className = "progress-item-score";
    detail.textContent = `${exam.correctCount}/${exam.totalQuestions} corrette`;

    const meta = document.createElement("span");
    meta.className = "progress-item-meta";
    meta.textContent = `${exam.errorCount} ${exam.errorCount === 1 ? "errore" : "errori"} · ${formatDuration(exam.usedMs)}`;

    const action = document.createElement("span");
    action.className = "progress-item-action";
    action.textContent = "Rivedi";

    item.append(pill, title, detail, meta, action);
    item.addEventListener("click", () =>
      loadSavedExamReview(exam.examId, item),
    );
    els.progressList.append(item);
  });
}

function renderRevisionCard(revision) {
  const uniqueWrongQuestions = Number(revision?.uniqueWrongQuestions || 0);
  const totalWrongAnswers = Number(revision?.totalWrongAnswers || 0);
  const availableQuestions = (revision?.questionIds || [])
    .map((id) => questionsById.get(String(id)))
    .filter(Boolean).length;

  els.revisionExamButton.disabled = availableQuestions === 0;

  if (availableQuestions === 0) {
    els.revisionSummary.textContent =
      totalWrongAnswers > 0
        ? "Ho trovato errori salvati, ma non riesco a ricostruire quelle domande in questa banca dati."
        : "Completa almeno un test con qualche errore per creare un ripasso mirato.";
    return;
  }

  const plannedQuestions = Math.min(settings.examQuestions, availableQuestions);
  els.revisionSummary.textContent =
    `${uniqueWrongQuestions} ${uniqueWrongQuestions === 1 ? "domanda sbagliata" : "domande sbagliate"} ` +
    `nei test salvati. Il prossimo ripasso usera ${plannedQuestions} ` +
    `${plannedQuestions === 1 ? "domanda" : "domande"}.`;
}

function renderProgressChart(recent) {
  els.progressChart.innerHTML = "";
  if (!Array.isArray(recent) || recent.length === 0) {
    const empty = document.createElement("p");
    empty.className = "progress-chart-empty";
    empty.textContent =
      "Qui vedrai l'andamento appena avrai completato qualche test.";
    els.progressChart.append(empty);
    return;
  }

  const points = recent.slice(0, 12).reverse();
  const averageScore =
    points.reduce((sum, exam) => sum + progressScore(exam), 0) / points.length;

  const header = document.createElement("div");
  header.className = "progress-chart-header";

  const title = document.createElement("strong");
  title.textContent = "Andamento";

  const detail = document.createElement("span");
  detail.textContent = `${Math.round(averageScore * 100)}% corrette di media negli ultimi ${points.length}`;
  header.append(title, detail);

  const bars = document.createElement("div");
  bars.className = "progress-bars";

  points.forEach((exam, index) => {
    const score = progressScore(exam);
    const bar = document.createElement("span");
    bar.className = `progress-bar-point ${
      exam.mode === "revision" ? "revision" : exam.passed ? "passed" : "failed"
    }`;
    bar.style.setProperty(
      "--score",
      `${Math.max(8, Math.round(score * 100))}%`,
    );
    bar.title = `${formatDate(exam.finishedAt)}: ${exam.correctCount}/${exam.totalQuestions} corrette`;
    bar.setAttribute(
      "aria-label",
      `Test ${index + 1}: ${exam.correctCount} corrette su ${exam.totalQuestions}`,
    );
    bars.append(bar);
  });

  els.progressChart.append(header, bars);
}

function progressScore(exam) {
  const total = Number(exam?.totalQuestions || 0);
  if (!total) return 0;
  return Math.max(0, Math.min(1, Number(exam.correctCount || 0) / total));
}

async function loadSavedExamReview(examId, trigger) {
  if (
    hasActiveExamProgress() &&
    !window.confirm(
      "Vuoi abbandonare il test in corso e rivedere questa simulazione?",
    )
  ) {
    return;
  }

  const previousText = trigger?.querySelector("strong")?.textContent;
  if (trigger) {
    trigger.disabled = true;
    trigger.classList.add("loading");
    const title = trigger.querySelector("strong");
    if (title) title.textContent = "Apro il test...";
  }
  const requestContext = captureAuthContext();

  try {
    const response = await authFetch(
      `./api/exam-result?examId=${encodeURIComponent(examId)}`,
    );
    const savedState = buildSavedExamState(response.exam);
    const key = sessionStorageKey();
    if (key) localStorage.removeItem(key);
    state = savedState;
    closeAccountPanel();
    closeQuestionDrawer();
    renderResults();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    if (error.stale || !isCurrentAuthContext(requestContext)) return;
    window.alert(error.message || "Non riesco ad aprire questo test.");
  } finally {
    if (trigger) {
      trigger.disabled = false;
      trigger.classList.remove("loading");
      const title = trigger.querySelector("strong");
      if (title && previousText) title.textContent = previousText;
    }
  }
}

function buildSavedExamState(exam) {
  const savedAnswers = Array.isArray(exam?.answers) ? exam.answers : [];
  const entries = savedAnswers
    .map((answer) => ({
      question: questionsById.get(String(answer.questionId)),
      answer: answer.answer,
    }))
    .filter((entry) => entry.question);

  if (entries.length === 0) {
    throw new Error("Non riesco a ricostruire le domande di questo test.");
  }

  const finishedAt = parseDateMs(exam.finishedAt, Date.now());
  const usedMs = Math.max(0, Number(exam.usedMs || 0));
  const startedAt = parseDateMs(exam.startedAt, finishedAt - usedMs);

  return {
    id: exam.examId,
    mode: String(exam.examId || "").startsWith("revision-")
      ? "revision"
      : "simulation",
    questions: entries.map((entry) => entry.question),
    answers: entries.map((entry) => entry.answer),
    currentIndex: 0,
    startedAt,
    endsAt: startedAt + settings.examMinutes * 60 * 1000,
    finished: true,
    finishedAt,
    finishReason: exam.finishReason || "manual",
  };
}

function parseDateMs(value, fallback) {
  const date = new Date(value).getTime();
  return Number.isNaN(date) ? fallback : date;
}

async function loadAdminDashboard(force = false) {
  if (!authState.token || !authState.user?.isAdmin) return;
  if (adminState.loading || (adminState.data && !force)) {
    renderAdmin();
    return;
  }
  const requestContext = captureAuthContext();

  adminState.loading = true;
  adminState.error = "";
  renderAdmin();

  try {
    const response = await authFetch("./api/admin-dashboard");
    adminState.data = response.admin;
  } catch (error) {
    if (error.stale || !isCurrentAuthContext(requestContext)) return;
    adminState.error = error.message || "Dashboard admin non disponibile.";
  } finally {
    if (isCurrentAuthContext(requestContext)) {
      adminState.loading = false;
      renderAdmin();
    }
  }
}

function renderAdmin() {
  const isAdmin = Boolean(authState.user?.isAdmin);
  els.adminPanel.hidden = !isAdmin || profileView !== "admin";
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
      user.lastLoginAt
        ? `Ultimo accesso ${formatDate(user.lastLoginAt)}`
        : "Nessun accesso completato",
      user.lastTestAt
        ? `ultimo test ${formatDate(user.lastTestAt)}`
        : "nessun test",
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
      createAdminMetric(
        "Motivo",
        test.finishReason === "timeout" ? "Tempo" : "Manuale",
      ),
    );

    const wrongAnswers = (test.answers || []).filter(
      (answer) => answer.isCorrect === false,
    );
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

function captureAuthContext() {
  return {
    token: authState.token,
    userId: authState.user?.id ?? null,
  };
}

function isCurrentAuthContext(context) {
  return Boolean(
    context &&
      authState.token === context.token &&
      (authState.user?.id ?? null) === context.userId,
  );
}

function captureAccessContext() {
  return {
    ...captureAuthContext(),
    plusToken: plusState.token,
    epoch: accessEpoch,
  };
}

function isCurrentAccessContext(context) {
  return Boolean(
    isCurrentAuthContext(context) &&
      plusState.token === context.plusToken &&
      accessEpoch === context.epoch,
  );
}

function staleRequestError() {
  const error = new Error("Richiesta superata da un nuovo accesso.");
  error.stale = true;
  return error;
}

async function authFetch(url, options = {}) {
  const requestContext = captureAuthContext();
  const requestPlusToken =
    options.headers?.["X-Quizpatente-Plus"] ??
    options.headers?.["x-quizpatente-plus"] ??
    null;
  const requestAccessEpoch = accessEpoch;
  try {
    const payload = await fetchJson(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${requestContext.token}`,
        ...(options.headers ?? {}),
      },
    });
    if (!isCurrentAuthContext(requestContext)) throw staleRequestError();
    return payload;
  } catch (error) {
    if (error.stale || !isCurrentAuthContext(requestContext)) {
      error.stale = true;
      throw error;
    }
    if (error.status === 401) {
      resetToAnonymousDemo();
      error.accessHandled = true;
    } else if (error.status === 402) {
      if (
        plusState.token !== requestPlusToken ||
        accessEpoch !== requestAccessEpoch
      ) {
        error.stale = true;
        throw error;
      }
      downgradeToFree(error.message);
      error.accessHandled = true;
    }
    throw error;
  }
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
    const error = new Error(payload.error || "Richiesta non riuscita.");
    error.status = response.status;
    throw error;
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
  if (
    !("serviceWorker" in navigator) ||
    window.location.hostname !== "quizpatente.realb.it" ||
    window.location.protocol !== "https:"
  ) {
    return;
  }

  try {
    await navigator.serviceWorker.register("./service-worker.js");
  } catch {
    // The app still works online if the browser refuses service worker registration.
  }
}
