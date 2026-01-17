const { contextBridge, ipcRenderer } = require("electron");

const resolved = ipcRenderer.sendSync("config:get") || {};
const WS_URL = resolved.wsURL || process.env.MAGIC_PASTE_WS_RESOLVED || "ws://127.0.0.1:8123/ws";
const HTTP_URL = resolved.httpURL || process.env.MAGIC_PASTE_HTTP_RESOLVED || "http://127.0.0.1:8123";

contextBridge.exposeInMainWorld("magicPaste", {
  config: {
    wsURL: WS_URL,
    httpURL: HTTP_URL,
  },
  log(message) {
    ipcRenderer.send("renderer:log", message);
  },
  onOverlayTrigger(callback) {
    ipcRenderer.on("overlay:trigger", callback);
  },
  hideOverlay() {
    return ipcRenderer.invoke("overlay:hide");
  },
  resizeOverlay(size) {
    return ipcRenderer.invoke("overlay:resize", size);
  },
  loadSettings() {
    return ipcRenderer.invoke("settings:load");
  },
  saveSettings(updates) {
    return ipcRenderer.invoke("settings:save", updates);
  },
  onSettingsUpdated(callback) {
    ipcRenderer.on("settings:updated", (_event, settings) => {
      if (typeof callback === "function") {
        callback(settings);
      }
    });
  },
  quitApp() {
    return ipcRenderer.invoke("app:quit");
  },
});
