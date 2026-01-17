const { app, BrowserWindow, globalShortcut, ipcMain, Menu, Tray, nativeImage, screen } = require("electron");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");

const DEFAULT_WS_URL = process.env.MAGIC_PASTE_WS || "ws://127.0.0.1:8123/ws";
const DEFAULT_HTTP_URL = process.env.MAGIC_PASTE_HTTP || "http://127.0.0.1:8123";
let resolvedHttpUrl = DEFAULT_HTTP_URL;
let resolvedWsUrl = DEFAULT_WS_URL;

process.env.MAGIC_PASTE_WS_RESOLVED = resolvedWsUrl;
process.env.MAGIC_PASTE_HTTP_RESOLVED = resolvedHttpUrl;

const IS_MAC = process.platform === "darwin";

let overlayWindow;
let settingsWindow;
let guideWindow;
let tray;
let trayHintWindow;
let trayHintTimer;
let previousFrontmostApp = null;
let currentLocale = "en-US";
let appState = { hasShownGuide: false };
let stateFilePath;
let isQuitting = false;
let backendProcess;
let backendPort;
let backendSettingsPath;
let backendStartedByUs = false;
let backendLogStream;

const TRANSLATIONS = {
  "en-US": {
    trayGuide: "User Guide",
    trayOpen: "Open Settings",
    trayQuit: "Quit",
    settingsTitle: "Magic Paste Settings",
    guideTitle: "Magic Paste Guide",
    menuAbout: "About Magic Paste",
    menuGuide: "User Guide",
    menuSettings: "Settings...",
    trayHint: "Click the menu icon to open Settings",
    backendUnavailable: "Backend is not running. Start Magic Paste daemon: python -m magic_paste.main daemon",
  },
  "zh-CN": {
    trayGuide: "使用指引",
    trayOpen: "打开设置",
    trayQuit: "退出",
    settingsTitle: "Magic Paste 设置",
    guideTitle: "Magic Paste 使用指引",
    menuAbout: "关于 Magic Paste",
    menuGuide: "使用指引",
    menuSettings: "设置...",
    trayHint: "点击图标打开设置",
    backendUnavailable: "后端未运行，请先启动 Magic Paste daemon：python -m magic_paste.main daemon",
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

const setResolvedUrls = (httpUrl, wsUrl) => {
  resolvedHttpUrl = httpUrl || DEFAULT_HTTP_URL;
  resolvedWsUrl = wsUrl || DEFAULT_WS_URL;
  process.env.MAGIC_PASTE_HTTP_RESOLVED = resolvedHttpUrl;
  process.env.MAGIC_PASTE_WS_RESOLVED = resolvedWsUrl;
};

const getSettingsEndpoint = () => `${resolvedHttpUrl.replace(/\/$/, "")}/settings`;

const escapeAppleScriptString = (value) => String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');

const runAppleScriptSync = (script) => {
  if (!IS_MAC) {
    return null;
  }
  try {
    const result = spawnSync("/usr/bin/osascript", ["-e", script], { encoding: "utf8" });
    if (result.error) {
      console.warn("AppleScript 执行失败：", result.error.message || result.error);
      return null;
    }
    if (typeof result.status === "number" && result.status !== 0) {
      const stderr = (result.stderr || "").trim();
      if (stderr) {
        console.warn("AppleScript 返回错误：", stderr);
      }
      return null;
    }
    return (result.stdout || "").trim();
  } catch (error) {
    console.warn("AppleScript 执行异常：", error.message);
    return null;
  }
};

const captureFrontmostApp = () => {
  if (!IS_MAC) {
    previousFrontmostApp = null;
    return;
  }
  const script = `
    tell application "System Events"
      set frontApp to first application process whose frontmost is true
      set appName to name of frontApp
      try
        set bundleId to bundle identifier of frontApp
      on error
        set bundleId to ""
      end try
    end tell
    return appName & "\n" & bundleId
  `;
  const output = runAppleScriptSync(script);
  if (!output) {
    previousFrontmostApp = null;
    return;
  }
  const [nameLine = "", bundleLine = ""] = output.split("\n");
  previousFrontmostApp = {
    name: nameLine.trim(),
    bundleId: bundleLine.trim(),
  };
};

const restorePreviousAppFocus = () => {
  if (!IS_MAC) {
    overlayWindow?.blur();
    return;
  }
  const target = previousFrontmostApp;
  previousFrontmostApp = null;
  if (!target || (!target.name && !target.bundleId)) {
    if (typeof app.hide === "function") {
      app.hide();
    }
    return;
  }
  const script = target.bundleId
    ? `tell application id "${escapeAppleScriptString(target.bundleId)}" to activate`
    : `tell application "${escapeAppleScriptString(target.name)}" to activate`;
  const ok = runAppleScriptSync(script);
  if (!ok && typeof app.hide === "function") {
    app.hide();
  }
};

const WINDOW_SIZE = { width: 480, height: 420 };
const GUIDE_WINDOW_WIDTH_SCALE = 1.5;
const GUIDE_WINDOW_HEIGHT_SCALE = 1.1;
const GUIDE_WINDOW_SIZE = {
  width: Math.round(WINDOW_SIZE.width * GUIDE_WINDOW_WIDTH_SCALE),
  height: Math.round(WINDOW_SIZE.height * GUIDE_WINDOW_HEIGHT_SCALE),
};
const HOTKEY = process.env.MAGIC_PASTE_HOTKEY || "CommandOrControl+Shift+V";
let currentHotkey = HOTKEY;
const TRAY_HINT_DURATION_MS = 10_000;
const TRAY_HINT_MIN_WIDTH = 220;
const TRAY_HINT_MAX_WIDTH = 420;
const TRAY_HINT_HEIGHT = 52;
const TRAY_HINT_CHAR_WIDTH = 7;
const TRAY_HINT_PADDING = 32;
const BACKEND_HOST = "127.0.0.1";
const BACKEND_HEALTH_TIMEOUT_MS = 800;
const BACKEND_STARTUP_TIMEOUT_MS = 6000;

const hideDockIcon = () => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
};

const createOverlayWindow = () => {
  writeBackendLog("create overlay window");
  overlayWindow = new BrowserWindow({
    width: WINDOW_SIZE.width,
    height: WINDOW_SIZE.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    fullscreenable: false,
    hasShadow: false,
    roundedCorners: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    useContentSize: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  overlayWindow.setAlwaysOnTop(true, "screen-saver");
  overlayWindow.setVisibleOnAllWorkspaces(true);
  overlayWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  attachWindowLogger("overlay", overlayWindow);
};

const getOverlayDimensions = () => {
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    const [width, height] = overlayWindow.getSize();
    return { width, height };
  }
  return { width: WINDOW_SIZE.width, height: WINDOW_SIZE.height };
};

const getOverlayPosition = () => {
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const padding = 8;
  const offsetX = 14;
  const offsetY = 12;
  const { width, height } = getOverlayDimensions();
  let x = Math.round(cursor.x + offsetX);
  let y = Math.round(cursor.y + offsetY);

  const maxX = display.bounds.x + display.bounds.width - width - padding;
  const maxY = display.bounds.y + display.bounds.height - height - padding;
  x = Math.max(display.bounds.x + padding, Math.min(x, maxX));
  y = Math.max(display.bounds.y + padding, Math.min(y, maxY));
  return { x, y };
};

const showOverlayWindow = () => {
  if (!overlayWindow) {
    createOverlayWindow();
  }
  const shouldCapture = !overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible();
  if (shouldCapture) {
    captureFrontmostApp();
  }
  const { x, y } = getOverlayPosition();
  overlayWindow.setPosition(x, y);
  overlayWindow.show();
  overlayWindow.focus();
  overlayWindow.webContents.send("overlay:trigger");
  writeBackendLog("overlay:trigger sent");
};

const createSettingsWindow = () => {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    settingsWindow.focus();
    return;
  }
  writeBackendLog("create settings window");
  settingsWindow = new BrowserWindow({
    width: 480,
    height: 480,
    resizable: false,
    title: tr("settingsTitle"),
    hasShadow: false,
    roundedCorners: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 10, y: 10 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  settingsWindow.setMenu(null);
  settingsWindow.loadFile(path.join(__dirname, "renderer", "settings.html"));
  attachWindowLogger("settings", settingsWindow);
  settingsWindow.on("closed", () => {
    settingsWindow = undefined;
  });
};

const createGuideWindow = () => {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.focus();
    return;
  }
  writeBackendLog("create guide window");
  guideWindow = new BrowserWindow({
    width: GUIDE_WINDOW_SIZE.width,
    height: GUIDE_WINDOW_SIZE.height,
    resizable: false,
    title: tr("guideTitle"),
    hasShadow: false,
    roundedCorners: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 10, y: 10 },
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  guideWindow.setMenu(null);
  guideWindow.loadFile(path.join(__dirname, "renderer", "index.html"), {
    query: { mode: "guide" },
  });
  attachWindowLogger("guide", guideWindow);
  guideWindow.on("closed", () => {
    guideWindow = undefined;
    if (!isQuitting) {
      showTrayHint();
    }
  });
};

const showGuideWindow = () => {
  if (guideWindow && !guideWindow.isDestroyed()) {
    guideWindow.show();
    guideWindow.focus();
    return;
  }
  createGuideWindow();
};

const buildTray = () => {
  if (!tray) {
    const iconPath = path.join(__dirname, "assets", "trayTemplate.png");
    let icon = nativeImage.createFromPath(iconPath);
    if (icon && !icon.isEmpty()) {
      icon.setTemplateImage(true);
    }
    if (!icon || icon.isEmpty()) {
      icon = nativeImage.createFromNamedImage("NSTouchBarRecordStartTemplate", [16, 18, 32]);
    }
    if (!icon || icon.isEmpty()) {
      icon = nativeImage.createFromDataURL(
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAA4AAAAOCAYAAAAfSC3RAAAAQ0lEQVQ4T2NkwA7+C4l/BmBmYGD4n4GB4T8GBoaGNAMjI8MwMDCAiAFMDAx/gzgY/rP4TwQmBoYGL4P4n4GBgYGABzNHCrOOKSMAAAAASUVORK5CYII="
      );
    }
    tray = new Tray(icon);
    tray.on("click", () => {
      hideTrayHint();
      tray.popUpContextMenu();
    });
  }
  const menu = Menu.buildFromTemplate([
    { label: tr("trayGuide"), click: () => showGuideWindow() },
    { label: tr("trayOpen"), click: () => createSettingsWindow() },
    { type: "separator" },
    { label: tr("trayQuit"), role: "quit" },
  ]);
  tray.setToolTip(`Magic Paste (${currentHotkey})`);
  tray.setContextMenu(menu);
};

const hideTrayHint = () => {
  if (trayHintTimer) {
    clearTimeout(trayHintTimer);
    trayHintTimer = undefined;
  }
  if (trayHintWindow && !trayHintWindow.isDestroyed()) {
    trayHintWindow.close();
  }
  trayHintWindow = undefined;
};

const showTrayHint = () => {
  if (!IS_MAC || !tray) {
    return;
  }
  hideTrayHint();
  const message = tr("trayHint");
  const hintSize = estimateTrayHintSize(message);
  trayHintWindow = new BrowserWindow({
    width: hintSize.width,
    height: hintSize.height,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: true,
    alwaysOnTop: true,
    backgroundColor: "#00000000",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  trayHintWindow.setIgnoreMouseEvents(true);
  trayHintWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  trayHintWindow.loadFile(path.join(__dirname, "renderer", "tray_hint.html"), {
    query: { text: message },
  });
  const bounds = tray.getBounds();
  const anchor = {
    x: bounds.x + bounds.width / 2,
    y: bounds.y + bounds.height,
  };
  const display = screen.getDisplayNearestPoint(anchor);
  const area = display.workArea || display.bounds;
  const padding = 6;
  let x = Math.round(anchor.x - hintSize.width / 2);
  let y = Math.round(anchor.y + padding);
  const minX = area.x + padding;
  const maxX = area.x + area.width - hintSize.width - padding;
  const minY = area.y + padding;
  const maxY = area.y + area.height - hintSize.height - padding;
  x = Math.max(minX, Math.min(x, maxX));
  y = Math.max(minY, Math.min(y, maxY));
  trayHintWindow.setPosition(x, y, false);
  trayHintWindow.once("ready-to-show", () => {
    trayHintWindow?.showInactive();
  });
  trayHintTimer = setTimeout(() => {
    hideTrayHint();
  }, TRAY_HINT_DURATION_MS);
};

const registerHotkey = () => {
  if (!currentHotkey) {
    return;
  }
  const registered = globalShortcut.register(currentHotkey, () => {
    writeBackendLog(`hotkey triggered: ${currentHotkey}`);
    showOverlayWindow();
  });
  if (!registered) {
    console.warn("无法注册全局热键", currentHotkey);
    writeBackendLog(`hotkey register failed: ${currentHotkey}`);
  } else {
    writeBackendLog(`hotkey registered: ${currentHotkey}`);
  }
};

const unregisterHotkey = () => {
  if (currentHotkey) {
    globalShortcut.unregister(currentHotkey);
  }
  globalShortcut.unregisterAll();
};

const updateHotkey = (nextHotkey) => {
  if (!nextHotkey || nextHotkey === currentHotkey) {
    return;
  }
  unregisterHotkey();
  currentHotkey = nextHotkey;
  registerHotkey();
  tray?.setToolTip(`Magic Paste (${currentHotkey})`);
};

const buildApplicationMenu = () => {
  if (!IS_MAC) {
    Menu.setApplicationMenu(null);
    return;
  }
  app.setAboutPanelOptions({
    applicationName: app.getName(),
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    credits: "",
  });
  const template = [
    {
      label: app.getName(),
      submenu: [
        { label: tr("menuAbout"), role: "about" },
        { label: tr("menuGuide"), click: () => showGuideWindow() },
        { label: tr("menuSettings"), click: () => createSettingsWindow() },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { label: tr("trayQuit"), role: "quit" },
      ],
    },
    { role: "editMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
};

const getStateFilePath = () => {
  if (!stateFilePath) {
    stateFilePath = path.join(app.getPath("userData"), "state.json");
  }
  return stateFilePath;
};

const loadAppState = () => {
  try {
    const filePath = getStateFilePath();
    if (!fs.existsSync(filePath)) {
      return { hasShownGuide: false };
    }
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return { hasShownGuide: Boolean(parsed.hasShownGuide) };
    }
  } catch (error) {
    console.warn("无法读取应用状态：", error.message);
  }
  return { hasShownGuide: false };
};

const saveAppState = (nextState) => {
  try {
    const filePath = getStateFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(nextState, null, 2));
  } catch (error) {
    console.warn("无法保存应用状态：", error.message);
  }
};

const maybeShowGuideOnFirstLaunch = () => {
  appState = loadAppState();
  if (appState.hasShownGuide) {
    return;
  }
  showGuideWindow();
  appState.hasShownGuide = true;
  saveAppState(appState);
};

const fetchJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`请求失败：${response.status}`);
  }
  return response.json();
};

const formatFetchError = (error) => {
  const message = String(error?.message || "");
  const code = error?.cause?.code || error?.code;
  if (!message || /fetch failed/i.test(message) || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENOTFOUND") {
    return tr("backendUnavailable");
  }
  return message;
};

const estimateTrayHintSize = (message) => {
  const safeMessage = String(message || "");
  const estimated = Math.ceil(safeMessage.length * TRAY_HINT_CHAR_WIDTH) + TRAY_HINT_PADDING;
  const width = Math.min(TRAY_HINT_MAX_WIDTH, Math.max(TRAY_HINT_MIN_WIDTH, estimated));
  return { width, height: TRAY_HINT_HEIGHT };
};

const resolveBundledSettingsPath = () => {
  const candidates = [
    path.resolve(__dirname, "..", "..", "magic_paste", "config", "settings.yaml"),
    path.join(process.resourcesPath || "", "magic_paste", "config", "settings.yaml"),
    path.join(process.resourcesPath || "", "app.asar", "magic_paste", "config", "settings.yaml"),
  ];
  return candidates.find((candidate) => candidate && fs.existsSync(candidate));
};

const ensureUserSettingsFile = () => {
  if (!backendSettingsPath) {
    backendSettingsPath = path.join(app.getPath("userData"), "settings.yaml");
  }
  if (fs.existsSync(backendSettingsPath)) {
    return backendSettingsPath;
  }
  const bundled = resolveBundledSettingsPath();
  if (bundled && fs.existsSync(bundled)) {
    fs.mkdirSync(path.dirname(backendSettingsPath), { recursive: true });
    fs.copyFileSync(bundled, backendSettingsPath);
  }
  return backendSettingsPath;
};

const parsePortFromUrl = (urlValue, fallback = 8123) => {
  try {
    const parsed = new URL(urlValue);
    if (parsed.port) {
      return Number.parseInt(parsed.port, 10);
    }
    return parsed.protocol === "https:" ? 443 : 80;
  } catch (error) {
    return fallback;
  }
};

const fetchHealthz = async (httpUrl) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BACKEND_HEALTH_TIMEOUT_MS);
  try {
    const response = await fetch(`${httpUrl.replace(/\/$/, "")}/healthz`, { signal: controller.signal });
    return response.ok;
  } catch (error) {
    return false;
  } finally {
    clearTimeout(timer);
  }
};

const findFreePort = () =>
  new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, BACKEND_HOST, () => {
      const address = server.address();
      server.close(() => {
        resolve(address && typeof address === "object" ? address.port : 0);
      });
    });
  });

const resolveBackendPythonPath = () => {
  if (process.env.MAGIC_PASTE_PYTHON) {
    return process.env.MAGIC_PASTE_PYTHON;
  }
  const archFolder = process.arch === "x64" ? "x64" : "arm64";
  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "python", archFolder, "bin", "python3"));
    candidates.push(path.join(process.resourcesPath, "python", archFolder, "bin", "python"));
    candidates.push(path.join(process.resourcesPath, "python", archFolder, "python.exe"));
  }
  candidates.push("python3");
  candidates.push("python");
  return candidates.find((candidate) => (candidate.includes(path.sep) ? fs.existsSync(candidate) : true)) || "python3";
};

const resolveBackendPythonPathEnv = () => {
  const override = process.env.MAGIC_PASTE_BACKEND_ROOT;
  if (override) {
    return override;
  }
  const packagedRoot = process.resourcesPath ? path.join(process.resourcesPath, "magic_paste") : "";
  if (packagedRoot && fs.existsSync(packagedRoot)) {
    return process.resourcesPath;
  }
  const devRoot = path.resolve(__dirname, "..", "..");
  if (fs.existsSync(path.join(devRoot, "magic_paste"))) {
    return devRoot;
  }
  return "";
};

const resolveBundledPythonRoot = (archFolder) => {
  if (!process.resourcesPath) {
    return "";
  }
  const root = path.join(process.resourcesPath, "python", archFolder);
  if (!fs.existsSync(root)) {
    return "";
  }
  const binDir = path.join(root, "bin");
  return fs.existsSync(binDir) ? root : "";
};

const resolveBundledPythonLibRoot = (pythonRoot) => {
  if (!pythonRoot) return "";
  const libRoot = path.join(pythonRoot, "lib");
  if (!fs.existsSync(libRoot)) return "";
  const entries = fs
    .readdirSync(libRoot)
    .filter((entry) => /^python\\d+\\.\\d+$/.test(entry))
    .sort();
  const latest = entries[entries.length - 1];
  return latest ? path.join(libRoot, latest) : "";
};

const resolveBundledSitePackages = (pythonRoot) => {
  const libRoot = resolveBundledPythonLibRoot(pythonRoot);
  if (!libRoot) return "";
  const sp = path.join(libRoot, "site-packages");
  return fs.existsSync(sp) ? sp : "";
};

const writeBackendLog = (message) => {
  if (!message) return;
  const line = `[main] ${new Date().toISOString()} ${message}\n`;
  if (backendLogStream) {
    backendLogStream.write(line);
  } else {
    console.log(line.trim());
  }
};

const registerRendererIpcLogging = () => {
  ipcMain.on("renderer:log", (_event, message) => {
    writeBackendLog(`renderer: ${message}`);
  });
  ipcMain.on("config:get", (event) => {
    event.returnValue = {
      wsURL: resolvedWsUrl,
      httpURL: resolvedHttpUrl,
    };
  });
};

const attachWindowLogger = (name, win) => {
  if (!win || win.isDestroyed()) return;
  const tag = String(name || "window");
  win.webContents.on("did-finish-load", () => {
    writeBackendLog(`${tag}: did-finish-load url=${win.webContents.getURL()}`);
  });
  win.webContents.on("did-fail-load", (_event, code, desc, url) => {
    writeBackendLog(`${tag}: did-fail-load code=${code} desc=${desc} url=${url}`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    writeBackendLog(`${tag}: render-process-gone reason=${details?.reason || "unknown"}`);
  });
  win.webContents.on("unresponsive", () => {
    writeBackendLog(`${tag}: unresponsive`);
  });
  win.webContents.on("responsive", () => {
    writeBackendLog(`${tag}: responsive`);
  });
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    writeBackendLog(`${tag}: console[level=${level}] ${message} (${sourceId}:${line})`);
  });
};

const openBackendLogStream = () => {
  try {
    const logPath = path.join(app.getPath("userData"), "backend.log");
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const stream = fs.createWriteStream(logPath, { flags: "a" });
    stream.write(`\n[backend] ${new Date().toISOString()} log start\n`);
    return stream;
  } catch (error) {
    console.warn("无法创建后端日志文件：", error.message || error);
    return null;
  }
};

const spawnBackend = (port) => {
  const python = resolveBackendPythonPath();
  const settingsPath = ensureUserSettingsFile();
  const pythonPathRoot = resolveBackendPythonPathEnv();
  const archFolder = process.arch === "x64" ? "x64" : "arm64";
  const pythonRoot =
    process.resourcesPath && python.startsWith(process.resourcesPath)
      ? resolveBundledPythonRoot(archFolder)
      : "";
  const sitePackagesRoot = pythonRoot ? resolveBundledSitePackages(pythonRoot) : "";
  const env = {
    ...process.env,
    MAGIC_PASTE_SETTINGS_PATH: settingsPath,
    PYTHONUNBUFFERED: "1",
  };
  if (pythonPathRoot) {
    const existing = env.PYTHONPATH || "";
    env.PYTHONPATH = [pythonPathRoot, sitePackagesRoot, existing].filter(Boolean).join(path.delimiter);
  } else if (sitePackagesRoot) {
    const existing = env.PYTHONPATH || "";
    env.PYTHONPATH = [sitePackagesRoot, existing].filter(Boolean).join(path.delimiter);
  }
  if (pythonRoot && fs.existsSync(pythonRoot)) {
    env.PYTHONHOME = pythonRoot;
  }
  const args = ["-m", "magic_paste.main", "daemon", "--host", BACKEND_HOST, "--port", String(port), "--settings", settingsPath];
  backendLogStream = backendLogStream || openBackendLogStream();
  writeBackendLog(`spawn backend: python=${python}`);
  writeBackendLog(`spawn backend: settings=${settingsPath}`);
  writeBackendLog(`spawn backend: args=${args.join(" ")}`);
  writeBackendLog(`spawn backend: PYTHONHOME=${env.PYTHONHOME || ""}`);
  writeBackendLog(`spawn backend: PYTHONPATH=${env.PYTHONPATH || ""}`);
  const child = spawn(python, args, {
    env,
    cwd: app.getPath("userData"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (backendLogStream) {
    if (child.stdout) {
      child.stdout.on("data", (chunk) => backendLogStream.write(chunk));
    }
    if (child.stderr) {
      child.stderr.on("data", (chunk) => backendLogStream.write(chunk));
    }
  }
  child.on("error", (error) => {
    console.warn("后端启动失败：", error.message || error);
  });
  return child;
};

const ensureBackend = async () => {
  backendLogStream = backendLogStream || openBackendLogStream();
  let baseHost = BACKEND_HOST;
  let baseProtocol = "http:";
  try {
    const parsed = new URL(DEFAULT_HTTP_URL);
    baseHost = parsed.hostname || BACKEND_HOST;
    baseProtocol = parsed.protocol || "http:";
  } catch (error) {
    baseHost = BACKEND_HOST;
    baseProtocol = "http:";
  }
  const basePort = parsePortFromUrl(DEFAULT_HTTP_URL, 8123);
  const baseHttp = `${baseProtocol}//${baseHost}:${basePort}`;
  const wsScheme = baseProtocol === "https:" ? "wss" : "ws";
  const baseWs = `${wsScheme}://${baseHost}:${basePort}/ws`;
  writeBackendLog(`ensure backend: baseHttp=${baseHttp} baseWs=${baseWs}`);
  if (await fetchHealthz(baseHttp)) {
    backendPort = basePort;
    setResolvedUrls(baseHttp, baseWs);
    ensureUserSettingsFile();
    writeBackendLog(`ensure backend: existing backend healthy at ${baseHttp}`);
    return;
  }
  let freePort;
  try {
    freePort = await findFreePort();
  } catch (error) {
    console.warn("无法获取可用端口：", error.message || error);
    writeBackendLog(`ensure backend: failed to find free port: ${error.message || error}`);
    setResolvedUrls(baseHttp, baseWs);
    return;
  }
  if (!freePort) {
    writeBackendLog("ensure backend: no free port found");
    setResolvedUrls(baseHttp, baseWs);
    return;
  }
  backendPort = freePort;
  const httpUrl = `http://${BACKEND_HOST}:${backendPort}`;
  const wsUrl = `ws://${BACKEND_HOST}:${backendPort}/ws`;
  setResolvedUrls(httpUrl, wsUrl);
  writeBackendLog(`ensure backend: spawning backend at ${httpUrl}`);
  backendProcess = spawnBackend(backendPort);
  backendStartedByUs = true;
  const startDeadline = Date.now() + BACKEND_STARTUP_TIMEOUT_MS;
  while (Date.now() < startDeadline) {
    if (await fetchHealthz(httpUrl)) {
      writeBackendLog("ensure backend: backend healthy");
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  console.warn("后端启动超时，GUI 可能无法连接");
  writeBackendLog("ensure backend: backend startup timed out");
};

const stopBackend = () => {
  if (backendProcess && backendStartedByUs) {
    try {
      backendProcess.kill();
    } catch (error) {
      console.warn("停止后端失败：", error.message || error);
    }
  }
  backendProcess = undefined;
  backendStartedByUs = false;
};

const bootstrapHotkeyFromSettings = async () => {
  try {
    const data = await fetchJson(getSettingsEndpoint());
    applyHotkeyFromSettings(data.settings || {});
  } catch (error) {
    console.warn("无法加载热键配置：", formatFetchError(error));
  }
};

const applyHotkeyFromSettings = (settings) => {
  if (!settings) return;
  if (settings.hotkey && settings.hotkey.overlay) {
    updateHotkey(settings.hotkey.overlay);
  }
  if (settings.ui && settings.ui.locale) {
    currentLocale = normalizeLocale(settings.ui.locale);
    if (tray) {
      buildTray();
    }
    buildApplicationMenu();
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      settingsWindow.setTitle(tr("settingsTitle"));
    }
    if (guideWindow && !guideWindow.isDestroyed()) {
      guideWindow.setTitle(tr("guideTitle"));
    }
  }
};

const broadcastSettingsUpdated = (settings) => {
  [overlayWindow, guideWindow, settingsWindow].forEach((win) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send("settings:updated", settings || {});
    }
  });
};

const setupIpcHandlers = () => {
  ipcMain.handle("overlay:hide", () => {
    overlayWindow?.hide();
    restorePreviousAppFocus();
    return true;
  });

  ipcMain.handle("overlay:resize", (_event, size = {}) => {
    if (!overlayWindow) return;
    const width = Math.max(260, Math.round(size.width || WINDOW_SIZE.width));
    const height = Math.max(200, Math.round(size.height || WINDOW_SIZE.height));
    overlayWindow.setContentSize(width, height, true);
  });

  ipcMain.handle("settings:load", async () => {
    try {
      const data = await fetchJson(getSettingsEndpoint());
      return { ok: true, data };
    } catch (error) {
      return { ok: false, message: formatFetchError(error) };
    }
  });

  ipcMain.handle("settings:save", async (_event, updates) => {
    try {
      const payload = { updates: updates || {} };
      const data = await fetchJson(getSettingsEndpoint(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const nextSettings = data.settings || {};
      applyHotkeyFromSettings(nextSettings);
      broadcastSettingsUpdated(nextSettings);
      return { ok: true, data };
    } catch (error) {
      return { ok: false, message: formatFetchError(error) };
    }
  });

  ipcMain.handle("app:quit", () => {
    app.quit();
    return true;
  });
};

app.whenReady().then(async () => {
  writeBackendLog("app ready");
  hideDockIcon();
  await ensureBackend();
  buildApplicationMenu();
  registerRendererIpcLogging();
  createOverlayWindow();
  buildTray();
  setupIpcHandlers();
  registerHotkey();
  bootstrapHotkeyFromSettings();
  maybeShowGuideOnFirstLaunch();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createOverlayWindow();
    }
  });
});

app.on("will-quit", () => {
  isQuitting = true;
  unregisterHotkey();
  stopBackend();
});

app.on("before-quit", () => {
  isQuitting = true;
  hideTrayHint();
});

app.on("window-all-closed", (event) => {
  if (!isQuitting) {
    event.preventDefault();
  }
});

process.on("uncaughtException", (err) => {
  console.error("Uncaught exception in Electron main process:", err);
});
