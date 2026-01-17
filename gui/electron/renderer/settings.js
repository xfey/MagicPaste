const statusLabel = document.getElementById("settings-status");
const form = document.getElementById("settings-form");
const closeBtn = document.getElementById("close-btn");
const tabs = Array.from(document.querySelectorAll(".tab"));
const pages = Array.from(document.querySelectorAll(".page"));
let allowClose = false;
let savePromise = null;
let closing = false;
let currentLocale = "en-US";

const TRANSLATIONS = {
  "en-US": {
    "page.title": "Magic Settings",
    "page.heading": "Settings",
    "section.general": "General Magic",
    "section.model": "LLM Magic",
    "field.hotkey.global": "Your magic spell",
    "field.model.base_url": "Base URL",
    "field.model.name": "Model Name",
    "field.context.screenshot": "Use screenshot as hint (may be slower)",
    "field.model.enable_image": "Enable the magic: image -> text (need visual model)",
    "field.ui.locale": "Magician, what's your Language",
    "field.ui.input": "Advanced Magic",
    "action.quit": "Quit The Magic",
    "tab.general": "General",
    "tab.model": "Model",
    "status.idle": "Spelling magic...",
    "status.loading": "Spelling magic...",
    "status.error": "Failed",
  },
  "zh-CN": {
    "page.title": "魔法设置",
    "page.heading": "设置",
    "section.general": "通用魔法",
    "section.model": "大模型魔法",
    "field.hotkey.global": "魔法咒语",
    "field.model.base_url": "基础 URL",
    "field.model.name": "模型名称",
    "field.context.screenshot": "使用屏幕截图提升表现（魔法会变慢）",
    "field.model.enable_image": "启用图片转文本的魔法（需要视觉模型）",
    "field.ui.locale": "魔法师语言",
    "field.ui.input": "高级魔法",
    "action.quit": "退出魔法",
    "tab.general": "通用",
    "tab.model": "大模型",
    "status.idle": "施法中...",
    "status.loading": "施法中...",
    "status.error": "出错",
  },
};

const normalizeLocale = (lang) => {
  if (!lang) return "en-US";
  if (TRANSLATIONS[lang]) return lang;
  const primary = String(lang).split("-")[0];
  const hit = Object.keys(TRANSLATIONS).find((code) => code.startsWith(primary));
  return hit || "en-US";
};

const tr = (key) => {
  const dict = TRANSLATIONS[currentLocale] || TRANSLATIONS["en-US"];
  return dict[key] || TRANSLATIONS["en-US"][key] || key;
};

const applyI18n = () => {
  document.querySelectorAll("[data-i18n]").forEach((node) => {
    const key = node.getAttribute("data-i18n");
    if (key) node.textContent = tr(key);
  });
  document.title = tr("page.title");
  const localeSelect = getField("ui.locale");
  if (localeSelect) {
    localeSelect.value = currentLocale;
  }
};

const getField = (name) => form.querySelector(`[name="${name}"]`);

const syncScreenshotToggle = () => {
  const imageEnabled = getField("model.enable_image").checked;
  const screenshotCheckbox = getField("context.screenshot.enabled");
  if (!imageEnabled) {
    screenshotCheckbox.checked = false;
    screenshotCheckbox.disabled = true;
  } else {
    screenshotCheckbox.disabled = false;
  }
};

const applySettings = (settings) => {
  const model = settings.model || {};
  const hotkey = settings.hotkey || {};
  const ui = settings.ui || {};
  const context = settings.context || {};
  const contextScreenshot = (context.screenshot || {});
  const legacyTextOnly = Object.prototype.hasOwnProperty.call(model, "text_only")
    ? !model.text_only
    : undefined;
  const imageEnabled = model.enable_image ?? legacyTextOnly ?? false;
  currentLocale = normalizeLocale(ui.locale || currentLocale);
  getField("model.base_url").value = model.base_url || "";
  getField("model.name").value = model.name || "";
  getField("model.api_key").value = model.api_key || "";
  getField("hotkey.overlay").value = hotkey.overlay || "CommandOrControl+Shift+V";
  getField("ui.locale").value = ui.locale || "en-US";
  getField("model.enable_image").checked = Boolean(imageEnabled);
  getField("context.screenshot.enabled").checked =
    imageEnabled && contextScreenshot.enabled !== false;
  syncScreenshotToggle();
  applyI18n();
};

const showStatus = (text = "", isError = false) => {
  statusLabel.textContent = text;
  statusLabel.style.color = isError ? "#c62828" : "#555";
  statusLabel.classList.toggle("visible", Boolean(text));
};

const collectUpdates = () => ({
  model: {
    base_url: getField("model.base_url").value.trim(),
    name: getField("model.name").value.trim(),
    api_key: getField("model.api_key").value.trim(),
    enable_image: getField("model.enable_image").checked,
  },
  hotkey: {
    overlay: getField("hotkey.overlay").value.trim() || "CommandOrControl+Shift+V",
  },
  context: {
    screenshot: {
      enabled: getField("context.screenshot.enabled").checked,
    },
  },
  ui: {
    locale: getField("ui.locale").value || "en-US",
  },
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
});

const loadSettings = async () => {
  showStatus(tr("status.loading"));
  try {
    const response = await window.magicPaste.loadSettings();
    if (!response.ok) {
      throw new Error(response.message || "加载失败");
    }
    applySettings(response.data.settings || {});
    showStatus("");
  } catch (error) {
    console.error("[settings] load failed", error);
    showStatus(error.message, true);
  }
};

const persistSettings = async () => {
  if (savePromise) return savePromise;
  savePromise = (async () => {
    showStatus("");
    try {
      const response = await window.magicPaste.saveSettings(collectUpdates());
      if (!response.ok) {
        throw new Error(response.message || "保存失败");
      }
      showStatus("");
      return true;
    } catch (error) {
      console.error("[settings] save failed", error);
      showStatus(error.message, true);
      return false;
    } finally {
      savePromise = null;
    }
  })();
  return savePromise;
};

const requestClose = async () => {
  if (closing) return;
  closing = true;
  const ok = await persistSettings();
  if (ok) {
    allowClose = true;
    window.close();
  } else {
    closing = false;
  }
};

if (closeBtn) {
  closeBtn.addEventListener("click", (event) => {
    event.preventDefault();
    requestClose();
  });
}

window.addEventListener("beforeunload", (event) => {
  if (allowClose) return;
  event.preventDefault();
  event.returnValue = "";
  requestClose();
});

const setActivePage = (page) => {
  pages.forEach((node) => {
    node.classList.toggle("hidden", node.dataset.page !== page);
  });
  tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.target === page);
  });
};

tabs.forEach((tab) => {
  tab.addEventListener("click", () => setActivePage(tab.dataset.target));
});

if (tabs.length) {
  setActivePage(tabs[0].dataset.target);
}

const localeSelect = getField("ui.locale");
if (localeSelect) {
  localeSelect.addEventListener("change", () => {
    currentLocale = normalizeLocale(localeSelect.value);
    applyI18n();
  });
}

const imageToggle = getField("model.enable_image");
if (imageToggle) {
  imageToggle.addEventListener("change", () => {
    syncScreenshotToggle();
  });
}

const exitBtn = document.getElementById("exit-btn");
if (exitBtn) {
  exitBtn.addEventListener("click", () => {
    if (window.magicPaste && typeof window.magicPaste.quitApp === "function") {
      window.magicPaste.quitApp();
    }
  });
}

loadSettings();
