const CONFIG = (window.magicPaste && window.magicPaste.config) || {};
const WS_URL = CONFIG.wsURL || "ws://127.0.0.1:8123/ws";
const IS_GUIDE_MODE = new URLSearchParams(window.location.search || "").get("mode") === "guide";
const DEFAULT_HOTKEY = "CommandOrControl+Shift+V";
const log = (label, payload) => {
  const message = payload === undefined ? String(label) : `${label} ${JSON.stringify(payload)}`;
  if (window.magicPaste && typeof window.magicPaste.log === "function") {
    window.magicPaste.log(message);
  }
  console.log(message);
};

log("[overlay] boot", { wsURL: WS_URL, httpURL: CONFIG.httpURL || "" });

window.addEventListener("error", (event) => {
  log("[overlay] error", {
    message: event.message,
    file: event.filename,
    line: event.lineno,
    column: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  log("[overlay] unhandledrejection", String(event.reason || ""));
});

const BASE_WIDTH = 480;
const MIN_HEIGHT = 240;
const MAX_HEIGHT = 520;
const LOADING_WIDTH = 140;
const LOADING_HEIGHT = 40;

const TRANSLATIONS = {
  "en-US": {
    overlayHint: "W/S to move · A to close · D to paste",
    guideHint: "W/S to move · A to close · D to paste",
    guideActionPrev: "Selected previous item",
    guideActionNext: "Selected next item",
    guideActionPaste: "Paste successful",
    guideActionClose: "Close window",
    guideHotkeyLine: "Use {hotkey} to wake up the interface",
    guideSetupHint: "Before first use, set your model settings",
    guide: {
      localeLabel: "Language",
      help: {
        move: "Move selection",
        close: "Close",
        confirm: "Paste",
      },
    },
    overlay: {
      loading: "Casting clipboard magic",
      empty: "Waiting for candidates...",
      previewPlaceholder: "No content",
      previewLoading: "Loading...",
    },
    status: {
      connected: "Connected to server",
      disconnected: "Disconnected, retrying…",
      submitting: "Task submitted…",
      running: "Model processing…",
      completed: "Generation finished",
      errorPrefix: "⚠️ ",
      copying: "Writing to clipboard…",
      pasted: "Auto-paste completed",
      copied: "Copied to clipboard; paste manually",
      settingsUpdated: "Settings updated",
    },
  },
  "zh-CN": {
    overlayHint: "W/S 选择 · A 关闭 · D 粘贴",
    guideHint: "W/S 选择 · A 关闭 · D 粘贴",
    guideActionPrev: "选择上一项",
    guideActionNext: "选择下一项",
    guideActionPaste: "粘贴成功",
    guideActionClose: "关闭窗口",
    guideHotkeyLine: "使用 {hotkey} 唤醒界面",
    guideSetupHint: "初次使用前，请先设置大模型相关参数",
    guide: {
      localeLabel: "语言",
      help: {
        move: "选择项目",
        close: "关闭窗口",
        confirm: "粘贴内容",
      },
    },
    overlay: {
      loading: "剪贴板施法中",
      empty: "等待候选...",
      previewPlaceholder: "暂无内容",
      previewLoading: "加载中…",
    },
    status: {
      connected: "已连接服务器",
      disconnected: "与服务断开，尝试重连…",
      submitting: "任务已提交…",
      running: "模型判定中…",
      completed: "生成完成",
      errorPrefix: "⚠️ ",
      copying: "写入剪贴板…",
      pasted: "已自动粘贴完成",
      copied: "已写入剪贴板，请手动粘贴",
      settingsUpdated: "设置已更新",
    },
  },
};

const normalizeLocale = (lang) => {
  if (!lang) return "en-US";
  if (TRANSLATIONS[lang]) return lang;
  const primary = String(lang).split("-")[0];
  const hit = Object.keys(TRANSLATIONS).find((code) => code.startsWith(primary));
  return hit || "en-US";
};

// default to English; will be overridden by settings or navigator
let currentLocale = "en-US";

const overlayShell = document.getElementById("overlay-shell");
const stageShell = document.getElementById("stage-shell");
const loadingCard = document.getElementById("loading-card");
const loadingDots = document.getElementById("loading-dots");
const candidateList = document.getElementById("candidate-list");
const previewText = document.getElementById("preview-text");
const stageHint =
  document.getElementById("stage-hint") || document.getElementById("stage-note");
const guideHint = document.getElementById("guide-hint");
const guideHintAction = document.getElementById("guide-hint-action");
const guideHotkey = document.getElementById("guide-hotkey");
const guideSetupHint = document.getElementById("guide-setup-hint");
const guideLocaleSelect = document.getElementById("guide-locale-select");
const guideClose = document.getElementById("guide-close");
const emptyHint = document.getElementById("empty-hint");
const FINAL_EVENT_TYPES = new Set(["run_completed", "paste_ready", "error"]);

let socket;
let requestId = null;
let hasPendingTrigger = false;
let selectedCandidate = null;
let candidates = [];
const previewState = new Map();
let overlayHidden = false;
let confirmInFlight = false;
let pendingResize = null;
let resizeHandle = null;
let lastAppliedSize = null;
let isLoading = false;
let loadingInterval = null;
let loadingDotCount = 1;
let pendingCancel = false;
const staleRequestIds = new Set();
let hintResetTimer = null;
let guideHotkeyRaw = DEFAULT_HOTKEY;

const tr = (key) => {
  const locale = currentLocale || "en-US";
  const dict = TRANSLATIONS[locale] || TRANSLATIONS["en-US"];
  const parts = key.split(".");
  let cursor = dict;
  for (const part of parts) {
    if (cursor && Object.prototype.hasOwnProperty.call(cursor, part)) {
      cursor = cursor[part];
    } else {
      return TRANSLATIONS["en-US"][key] || key;
    }
  }
  if (typeof cursor === "string") return cursor;
  return TRANSLATIONS["en-US"][key] || key;
};

const applyStaticTexts = () => {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (!key) return;
    node.textContent = tr(key);
  });
};

const syncGuideLocaleSelect = () => {
  if (!guideLocaleSelect) return;
  guideLocaleSelect.value = currentLocale;
};

const setLocale = (nextLocale) => {
  const normalized = normalizeLocale(nextLocale);
  if (normalized === currentLocale) return;
  currentLocale = normalized;
  applyStaticTexts();
  syncGuideLocaleSelect();
  updateHint(IS_GUIDE_MODE ? tr("guideHint") : tr("overlayHint"));
  renderPreview();
  renderCandidates();
  if (IS_GUIDE_MODE) {
    renderGuideCandidates();
    updateGuideHotkeyLine();
  }
};

const persistLocaleSetting = async (nextLocale) => {
  if (!window.magicPaste || typeof window.magicPaste.saveSettings !== "function") {
    return false;
  }
  try {
    const response = await window.magicPaste.saveSettings({ ui: { locale: nextLocale } });
    if (!response || !response.ok) {
      console.warn("[guide] save locale failed", response?.message || "unknown error");
      return false;
    }
    const savedLocale = response.data?.settings?.ui?.locale;
    if (savedLocale) {
      setLocale(savedLocale);
    }
    return true;
  } catch (error) {
    console.warn("[guide] save locale failed", error);
    return false;
  }
};

const bootstrapLocale = async () => {
  let localeFromSettings = false;
  let settingsFetchOk = false;
  // try settings first
  try {
    if (window.magicPaste && typeof window.magicPaste.loadSettings === "function") {
      const resp = await window.magicPaste.loadSettings();
      if (resp.ok) {
        settingsFetchOk = true;
        const lang = resp.data?.settings?.ui?.locale;
        if (lang) {
          currentLocale = normalizeLocale(lang);
          localeFromSettings = true;
        }
        const hotkey = resp.data?.settings?.hotkey?.overlay;
        if (hotkey) {
          guideHotkeyRaw = hotkey;
        }
      }
    }
  } catch (error) {
    console.warn("Locale bootstrap failed:", error);
  } finally {
    // if settings were loaded but didn't provide locale, fall back to navigator
    if (settingsFetchOk && !localeFromSettings) {
      const navLang =
        (window.navigator && window.navigator.language) ||
        (window.navigator && window.navigator.userLanguage);
      if (navLang) {
        currentLocale = normalizeLocale(navLang);
      }
    }
    applyStaticTexts();
    syncGuideLocaleSelect();
    updateHint(IS_GUIDE_MODE ? tr("guideHint") : tr("overlayHint"));
  }
};

const hideOverlayWindow = () => {
  if (overlayHidden) {
    return Promise.resolve();
  }
  overlayHidden = true;
  const api = window.magicPaste && window.magicPaste.hideOverlay;
  if (typeof api === "function") {
    try {
      const maybe = api();
      if (maybe && typeof maybe.then === "function") {
        return maybe.catch(() => {});
      }
      return Promise.resolve();
    } catch (error) {
      console.warn("overlay hide failed:", error);
    }
  }
  return Promise.resolve();
};

const setStatus = (text) => {
  console.debug("[overlay status]", text);
};

const markActiveRequestStale = () => {
  if (requestId) {
    staleRequestIds.add(requestId);
    requestId = null;
  }
};

const shouldIgnoreEventForRequest = (type, requestIdentifier) => {
  if (!requestIdentifier) {
    return false;
  }
  if (pendingCancel) {
    sendMessage("cancel_run", { request_id: requestIdentifier });
    staleRequestIds.add(requestIdentifier);
    pendingCancel = false;
    return true;
  }
  if (staleRequestIds.has(requestIdentifier)) {
    if (FINAL_EVENT_TYPES.has(type)) {
      staleRequestIds.delete(requestIdentifier);
    }
    return true;
  }
  if (requestId && requestIdentifier !== requestId) {
    staleRequestIds.add(requestIdentifier);
    if (FINAL_EVENT_TYPES.has(type)) {
      staleRequestIds.delete(requestIdentifier);
    }
    return true;
  }
  if (!requestId) {
    requestId = requestIdentifier;
  }
  return false;
};

const renderConfidenceBars = (confidence) => {
  if (!confidence) return "";
  const level = String(confidence || "").toLowerCase();
  const palette = {
    high: ["var(--success)", "var(--success)", "var(--success)"],
    medium: ["#d07b00", "#d07b00", "#bfbfbf"],
    low: ["var(--error)", "#bfbfbf", "#bfbfbf"],
  };
  const colors = palette[level] || ["#bfbfbf", "#bfbfbf", "#bfbfbf"];
  const bars = colors
    .map((color) => `<span class="bar" style="background:${color}"></span>`)
    .join("");
  return `<div class="confidence-bars" aria-label="${confidence}">${bars}</div>`;
};

const getSelectedCandidate = () => candidates.find((c) => c.id === selectedCandidate) || null;

const updateHint = (text) => {
  const target = IS_GUIDE_MODE ? guideHint : stageHint;
  if (target && text) {
    target.textContent = text;
  }
};

const setTemporaryHint = (text, timeout = 1200) => {
  if (IS_GUIDE_MODE) {
    return;
  }
  if (!text) return;
  updateHint(text);
  if (hintResetTimer) {
    clearTimeout(hintResetTimer);
  }
  hintResetTimer = setTimeout(() => {
    updateHint(tr("overlayHint"));
  }, timeout);
};

const flashGuideKeys = (keys) => {
  if (!Array.isArray(keys)) return;
  keys.forEach((key) => {
    const nodes = document.querySelectorAll(`.key[data-key="${key}"]`);
    nodes.forEach((node) => {
      node.classList.add("active");
      setTimeout(() => {
        node.classList.remove("active");
      }, 160);
    });
  });
};

const flashGuideHelp = (group, duration = 200) => {
  if (!group) return;
  const target = document.querySelector(`.key-help[data-help="${group}"]`);
  if (!target) return;
  target.classList.add("active");
  setTimeout(() => {
    target.classList.remove("active");
  }, duration);
};

const mapGuideKey = (key) => {
  if (!key) return null;
  switch (key) {
    case "w":
    case "W":
    case "ArrowUp":
      return "w";
    case "s":
    case "S":
    case "ArrowDown":
      return "s";
    case "a":
    case "A":
    case "ArrowLeft":
      return "a";
    case "d":
    case "D":
    case "ArrowRight":
      return "d";
    default:
      return null;
  }
};

const mapGuideAuxKey = (key) => {
  return null;
};

const startLoadingDots = () => {
  if (!loadingDots) return;
  loadingDots.textContent = ".";
  loadingDotCount = 1;
  if (loadingInterval) {
    clearInterval(loadingInterval);
  }
  loadingInterval = setInterval(() => {
    loadingDotCount = (loadingDotCount % 3) + 1;
    loadingDots.textContent = ".".repeat(loadingDotCount);
  }, 380);
};

const stopLoadingDots = () => {
  if (loadingInterval) {
    clearInterval(loadingInterval);
    loadingInterval = null;
  }
  loadingDotCount = 1;
};

const startLoadingUI = () => {
  isLoading = true;
  if (overlayShell) {
    overlayShell.classList.add("loading-mode");
  }
  if (stageShell) {
    stageShell.classList.add("hidden");
    stageShell.classList.remove("visible");
  }
  if (loadingCard) {
    loadingCard.classList.remove("hidden");
  }
  startLoadingDots();
  resizeOverlayToContent();
};

const stopLoadingUI = (options = {}) => {
  const skipReveal = Boolean(options.skipReveal);
  isLoading = false;
  stopLoadingDots();
  if (overlayShell) {
    overlayShell.classList.remove("loading-mode");
  }
  if (loadingCard) {
    loadingCard.classList.add("hidden");
  }
  if (stageShell) {
    if (skipReveal) {
      stageShell.classList.add("hidden");
      stageShell.classList.remove("visible");
    } else {
      stageShell.classList.remove("hidden");
      requestAnimationFrame(() => stageShell.classList.add("visible"));
    }
  }
  resizeOverlayToContent();
};

const cancelAndHide = () => {
  if (requestId) {
    sendMessage("cancel_run", { request_id: requestId });
    staleRequestIds.add(requestId);
    requestId = null;
    pendingCancel = false;
  } else {
    pendingCancel = true;
  }
  stopLoadingUI({ skipReveal: true });
  hideOverlayWindow();
};

const applyOverlayResize = (width, height) => {
  if (window.magicPaste && typeof window.magicPaste.resizeOverlay === "function") {
    window.magicPaste.resizeOverlay({ width, height });
  }
};

const flushPendingResize = () => {
  resizeHandle = null;
  if (!pendingResize) return;
  const next = pendingResize;
  pendingResize = null;
  if (
    lastAppliedSize &&
    lastAppliedSize.width === next.width &&
    lastAppliedSize.height === next.height
  ) {
    return;
  }
  lastAppliedSize = next;
  applyOverlayResize(next.width, next.height);
};

const scheduleOverlayResize = (width, height) => {
  const normalizedWidth = Math.round(width || BASE_WIDTH);
  const baseHeight = Math.round(height || MIN_HEIGHT);
  const normalizedHeight = isLoading ? baseHeight : Math.max(MIN_HEIGHT, baseHeight);
  const cappedHeight = isLoading ? normalizedHeight : Math.min(normalizedHeight, MAX_HEIGHT);
  if (
    pendingResize &&
    pendingResize.width === normalizedWidth &&
    pendingResize.height === cappedHeight
  ) {
    return;
  }
  pendingResize = { width: normalizedWidth, height: cappedHeight };
  if (resizeHandle !== null) {
    return;
  }
  const schedule =
    typeof window.requestAnimationFrame === "function"
      ? window.requestAnimationFrame.bind(window)
      : (cb) => setTimeout(cb, 0);
  resizeHandle = schedule(flushPendingResize);
};

const resizeOverlayToContent = () => {
  if (isLoading) {
    scheduleOverlayResize(LOADING_WIDTH, LOADING_HEIGHT);
    return;
  }
  if (!overlayShell) return;
  const desiredHeight = Math.max(
    MIN_HEIGHT,
    Math.min(Math.ceil(overlayShell.scrollHeight), MAX_HEIGHT)
  );
  scheduleOverlayResize(BASE_WIDTH, desiredHeight);
};

const connectSocket = () => {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    return;
  }
  log("[overlay] ws connect", WS_URL);
  socket = new WebSocket(WS_URL);
  socket.addEventListener("open", () => {
    log("[overlay] ws open");
    setStatus(tr("status.connected"));
    if (hasPendingTrigger) {
      triggerPipeline();
    }
  });
  socket.addEventListener("close", () => {
    log("[overlay] ws close");
    setStatus(tr("status.disconnected"));
    setTimeout(() => connectSocket(), 1000);
  });
  socket.addEventListener("message", (event) => {
    log("[overlay] ws message", event.data);
    const data = JSON.parse(event.data);
    handleServerEvent(data);
  });
  socket.addEventListener("error", () => {
    log("[overlay] ws error");
    setStatus(tr("status.disconnected"));
  });
};

const sendMessage = (type, payload = {}) => {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    log("[overlay] ws send failed", type);
    return false;
  }
  log("[overlay] ws send", type);
  socket.send(JSON.stringify({ type, payload }));
  return true;
};

const moveSelection = (delta) => {
  if (!candidates.length) {
    return;
  }
  const currentIndex = candidates.findIndex((c) => c.id === selectedCandidate);
  let nextIndex = currentIndex === -1 ? 0 : currentIndex + delta;
  if (nextIndex < 0) nextIndex = 0;
  if (nextIndex >= candidates.length) nextIndex = candidates.length - 1;
  selectedCandidate = candidates[nextIndex].id;
  renderCandidates();
  renderPreview();
};

const confirmSelection = () => {
  if (!requestId || !selectedCandidate || confirmInFlight) {
    return;
  }
  confirmInFlight = true;
  const submitConfirm = () => {
    sendMessage("confirm_candidate", { request_id: requestId, candidate_id: selectedCandidate });
    setStatus(tr("status.copying"));
  };
  hideOverlayWindow().finally(submitConfirm);
};

const triggerPipeline = () => {
  log("[overlay] trigger pipeline");
  markActiveRequestStale();
  resetUiState();
  if (socket && socket.readyState === WebSocket.OPEN) {
    sendMessage("trigger_run", {});
    hasPendingTrigger = false;
  } else {
    hasPendingTrigger = true;
    connectSocket();
  }
};

const resetUiState = () => {
  requestId = null;
  selectedCandidate = null;
  candidates = [];
  previewState.clear();
  overlayHidden = false;
  confirmInFlight = false;
  pendingCancel = false;
  startLoadingUI();
  renderCandidates();
  renderPreview();
  setStatus(tr("status.running"));
};

const renderCandidates = () => {
  candidateList.innerHTML = "";
  if (!candidates.length) {
    emptyHint.classList.remove("hidden");
    candidateList.classList.add("hidden");
    resizeOverlayToContent();
    return;
  }
  emptyHint.classList.add("hidden");
  candidateList.classList.remove("hidden");
  candidates.forEach((candidate) => {
    const bars = candidate.isManual ? "" : renderConfidenceBars(candidate.confidence);
    const li = document.createElement("li");
    li.className = `candidate-item ${candidate.isManual ? "manual" : ""} ${
      selectedCandidate === candidate.id ? "active" : ""
    }`;
    li.innerHTML = `
      <div class="candidate-head">
        <div class="candidate-title">${candidate.title}</div>
        ${bars}
      </div>
      <div class="candidate-desc">${candidate.description || ""}</div>
    `;
    li.addEventListener("click", () => {
      selectedCandidate = candidate.id;
      renderCandidates();
      renderPreview();
    });
    li.addEventListener("dblclick", () => {
      selectedCandidate = candidate.id;
      renderCandidates();
      enterStageTwo();
    });
    candidateList.appendChild(li);
  });
  const active = candidateList.querySelector(".candidate-item.active");
  if (active && typeof active.scrollIntoView === "function") {
    active.scrollIntoView({ block: "nearest" });
  }
  resizeOverlayToContent();
};

const renderPreview = () => {
  const candidate = getSelectedCandidate();
  if (!candidate) {
    previewText.textContent = tr("overlay.previewPlaceholder");
    resizeOverlayToContent();
    return;
  }
  const fallback = candidate.initialOutput || tr("overlay.previewLoading");
  const content = previewState.has(candidate.id) ? previewState.get(candidate.id) : fallback;
  previewText.textContent = (content || "").trim() || tr("overlay.previewPlaceholder");
  resizeOverlayToContent();
};

const isMacPlatform = () => {
  const platform = (window.navigator && window.navigator.platform) || "";
  return /Mac/i.test(platform);
};

const formatHotkeyLabel = (rawHotkey) => {
  if (!rawHotkey) return "";
  const mapping = {
    CommandOrControl: isMacPlatform() ? "Command" : "Ctrl",
    Command: "Command",
    Cmd: "Command",
    Control: "Ctrl",
    Ctrl: "Ctrl",
    Shift: "Shift",
    Alt: isMacPlatform() ? "Option" : "Alt",
    Option: "Option",
  };
  return String(rawHotkey)
    .split("+")
    .map((part) => {
      const trimmed = part.trim();
      return mapping[trimmed] || trimmed;
    })
    .filter(Boolean)
    .join(" + ");
};

const updateGuideHotkeyLine = () => {
  if (!guideHotkey) return;
  const label = formatHotkeyLabel(guideHotkeyRaw) || formatHotkeyLabel(DEFAULT_HOTKEY);
  const template = tr("guideHotkeyLine");
  guideHotkey.textContent = template.replace("{hotkey}", label || DEFAULT_HOTKEY);
  if (guideSetupHint) {
    guideSetupHint.textContent = tr("guideSetupHint");
  }
};

const getGuideCandidates = () => {
  if ((currentLocale || "").startsWith("zh")) {
    const sampleInput = "今天下午 3 点对齐需求，请准备一页项目进度简报。";
    return [
      {
        id: "guide-summary",
        title: "要点总结",
        description: "按照 Markdown 格式，整理成 3 条可执行的清单",
        initialOutput: "- 今天下午 3 点对齐需求\n- 准备一页项目进度简报\n- 用简报推动讨论",
      },
      {
        id: "guide-rewrite",
        title: "改写为更专业的表达",
        description: "保留关键信息，语气更正式",
        initialOutput: "请于今天下午 3 点参加需求对齐会议，并准备一页项目进度简报。",
      },
      {
        id: "guide-raw",
        title: "原样粘贴",
        description: "保持剪贴板内容不变",
        initialOutput: sampleInput,
      },
    ];
  }
  const sampleInput = "Let's align requirements at 3pm today. Please prepare a one-page project update.";
  return [
    {
      id: "guide-summary",
      title: "Key Summary",
      description: "Condense into three action points with Markdown format",
      initialOutput:
        "- Align requirements at 3pm today\n- Prepare a one-page project update\n- Use the update to guide the discussion",
    },
    {
      id: "guide-rewrite",
      title: "Professional Rewrite",
      description: "Keep meaning, polish the tone",
      initialOutput:
        "Please join the 3pm requirements alignment meeting and prepare a one-page project update.",
    },
    {
      id: "guide-raw",
      title: "Paste as-is",
      description: "Keep the original clipboard content",
      initialOutput: sampleInput,
    },
  ];
};

const renderGuideCandidates = () => {
  candidates = [];
  previewState.clear();
  const items = getGuideCandidates();
  items.forEach((item) => {
    upsertCandidate({
      id: item.id,
      title: item.title,
      description: item.description,
      confidence: "high",
      is_manual: true,
      initial_output: item.initialOutput,
    });
    previewState.set(item.id, item.initialOutput);
  });
  selectedCandidate = items[0]?.id || null;
  renderCandidates();
  renderPreview();
};

const initGuideMode = () => {
  stopLoadingUI();
  renderGuideCandidates();
  updateHint(tr("guideHint"));
  updateGuideHotkeyLine();
};

const upsertCandidate = (item) => {
  const normalized = {
    id: item.id,
    title: item.title,
    description: item.description,
    confidence: item.confidence,
    isManual: Boolean(item.is_manual),
    initialOutput: item.initial_output || "",
  };
  const existingIndex = candidates.findIndex((c) => c.id === normalized.id);
  if (existingIndex >= 0) {
    candidates[existingIndex] = normalized;
  } else {
    candidates.push(normalized);
  }
};

const handleServerEvent = (event) => {
  const { type, request_id: reqId, payload = {} } = event;
  if (shouldIgnoreEventForRequest(type, reqId)) {
    return;
  }

  switch (type) {
    case "ready":
      setStatus(tr("status.connected"));
      break;
    case "run_accepted":
      setStatus(tr("status.submitting"));
      break;
    case "run_started":
      setStatus(tr("status.running"));
      break;
    case "candidates":
      if (isLoading) {
        stopLoadingUI();
      }
      payload.items?.forEach((item) => {
        upsertCandidate(item);
        if (item.is_manual && item.initial_output) {
          previewState.set(item.id, item.initial_output);
        }
      });
      if (!selectedCandidate && candidates.length) {
        selectedCandidate = candidates[0].id;
      }
      renderCandidates();
      renderPreview();
      break;
    case "preview_chunk": {
      const candidateId = payload.candidate_id;
      if (!candidateId) break;
      const delta = payload.delta_text || "";
      if (delta) {
        const previous = previewState.get(candidateId) || "";
        previewState.set(candidateId, previous + delta);
        if (selectedCandidate === candidateId) {
          renderPreview();
        }
      }
      if (payload.is_final && !previewState.has(candidateId)) {
        previewState.set(candidateId, "");
      }
      break;
    }
    case "run_completed":
      if (isLoading) {
        stopLoadingUI();
      }
      setStatus(tr("status.completed"));
      break;
    case "error":
      if (isLoading) {
        stopLoadingUI();
      }
      setStatus(`${tr("status.errorPrefix")}${payload.message || ""}`);
      confirmInFlight = false;
      if (payload.fallback) {
        candidates = [];
        upsertCandidate(payload.fallback);
        selectedCandidate = payload.fallback.id;
        previewState.set(payload.fallback.id, payload.fallback.initial_output || "");
        renderCandidates();
        renderPreview();
      }
      break;
    case "paste_ready": {
      const auto = payload.auto_paste;
      setStatus(auto ? tr("status.pasted") : tr("status.copied"));
      confirmInFlight = false;
      if (!overlayHidden) {
        setTimeout(() => {
          hideOverlayWindow();
        }, 300);
      }
      break;
    }
    case "settings_updated":
      if (payload.settings && payload.settings.ui && payload.settings.ui.locale) {
        setLocale(payload.settings.ui.locale);
      }
      setStatus(tr("status.settingsUpdated"));
      break;
    default:
      break;
  }
};

document.addEventListener("keydown", (event) => {
  if (IS_GUIDE_MODE) {
    const key = event.key;
    if (key === "s" || key === "S" || key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
      flashGuideHelp("move");
      flashGuideKeys([mapGuideKey(key), mapGuideAuxKey(key)].filter(Boolean));
    } else if (key === "w" || key === "W" || key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
      flashGuideHelp("move");
      flashGuideKeys([mapGuideKey(key), mapGuideAuxKey(key)].filter(Boolean));
    } else if (key === "a" || key === "A" || key === "ArrowLeft") {
      event.preventDefault();
      flashGuideHelp("close");
      flashGuideKeys([mapGuideKey(key), mapGuideAuxKey(key)].filter(Boolean));
    } else if (key === "d" || key === "D" || key === "ArrowRight") {
      event.preventDefault();
      flashGuideHelp("confirm");
      flashGuideKeys([mapGuideKey(key), mapGuideAuxKey(key)].filter(Boolean));
    }
    return;
  }
  if (isLoading) {
    if (event.key === "a" || event.key === "A" || event.key === "ArrowLeft") {
      event.preventDefault();
      cancelAndHide();
    }
    return;
  }
  const key = event.key;
  if (key === "s" || key === "S" || key === "ArrowDown") {
    event.preventDefault();
    moveSelection(1);
  } else if (key === "w" || key === "W" || key === "ArrowUp") {
    event.preventDefault();
    moveSelection(-1);
  } else if (key === "a" || key === "A" || key === "ArrowLeft") {
    event.preventDefault();
    hideOverlayWindow();
  } else if (key === "d" || key === "D" || key === "ArrowRight") {
    event.preventDefault();
    confirmSelection();
  }
});

if (!IS_GUIDE_MODE && window.magicPaste && typeof window.magicPaste.onOverlayTrigger === "function") {
  window.magicPaste.onOverlayTrigger(() => {
    log("[overlay] onOverlayTrigger");
    overlayHidden = false;
    confirmInFlight = false;
    bootstrapLocale();
    connectSocket();
    triggerPipeline();
  });
}

if (window.magicPaste && typeof window.magicPaste.onSettingsUpdated === "function") {
  window.magicPaste.onSettingsUpdated((settings) => {
    if (settings && settings.ui && settings.ui.locale) {
      setLocale(settings.ui.locale);
    }
    if (IS_GUIDE_MODE && settings && settings.hotkey && settings.hotkey.overlay) {
      guideHotkeyRaw = settings.hotkey.overlay;
      updateGuideHotkeyLine();
    }
  });
}

if (IS_GUIDE_MODE && guideLocaleSelect) {
  guideLocaleSelect.addEventListener("change", () => {
    const nextLocale = normalizeLocale(guideLocaleSelect.value);
    if (nextLocale === currentLocale) {
      syncGuideLocaleSelect();
      return;
    }
    setLocale(nextLocale);
    persistLocaleSetting(nextLocale);
  });
}

renderCandidates();
renderPreview();
bootstrapLocale().finally(() => {
  if (IS_GUIDE_MODE) {
    initGuideMode();
  } else {
    updateHint(tr("overlayHint"));
    resizeOverlayToContent();
  }
});

if (IS_GUIDE_MODE) {
  document.body.classList.add("guide-mode");
  if (guideClose) {
    guideClose.addEventListener("click", () => {
      window.close();
    });
  }
}
