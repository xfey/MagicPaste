import AppKit

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var ipc: NativeIPC?
    private var watcher: ContextWatcher?
    private var hotkeyManager: HotkeyManager?

    func applicationDidFinishLaunching(_ notification: Notification) {
        print("[Main] MagicPasteNative 启动，activationPolicy=.prohibited")

        let watcher = ContextWatcher { [weak self] window, payload, screenshot in
            guard let self else { return }
            print("[Main] 收到热键触发，开始组装 ContextSnapshot")
            let snapshot = ContextSnapshot(
                window: window,
                clipboard: payload,
                screenshot: screenshot,
                capturedAt: Date()
            )
            self.ipc?.sendSnapshot(snapshot)
        }
        self.watcher = watcher

        let hotkeyManager = HotkeyManager { [weak self] in
            print("[Main] 热键回调触发，调用 ContextWatcher.captureOnce")
            self?.watcher?.captureOnce()
        }
        self.hotkeyManager = hotkeyManager

        let ipc = NativeIPC(hotkeyManager: hotkeyManager)
        self.ipc = ipc

        print("[Main] 初始化默认热键 cmd+shift+v")
        hotkeyManager.updateTrigger("cmd+shift+v")
        ipc.connect()
    }
}

let appDelegate = AppDelegate()
let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
app.delegate = appDelegate
print("[Main] App configured, entering run loop")
app.run()
