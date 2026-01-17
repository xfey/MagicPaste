import AppKit

struct WindowMeta: Codable {
    let appName: String
    let title: String
    let bundleIdentifier: String?
}

final class ContextWatcher {
    private let captureHandler: (WindowMeta, ClipboardPayload?, Data?) -> Void
    private let windowResolver = FrontWindowResolver()

    init(onSnapshot: @escaping (WindowMeta, ClipboardPayload?, Data?) -> Void) {
        self.captureHandler = onSnapshot
    }

    func captureOnce() {
        print("[ContextWatcher] capture triggered")
        guard let meta = windowResolver.resolve() else {
            print("[ContextWatcher] 无法获取当前窗口")
            return
        }
        let payload = ClipboardBridge.captureClipboard()
        let screenshot = takeScreenshot()
        print("[ContextWatcher] 捕获上下文 window=\(meta.appName) \(meta.title) clipboardType=\(payload?.type.rawValue ?? "none")")
        captureHandler(meta, payload, screenshot)
    }

    private func takeScreenshot() -> Data? {
        guard let screen = NSScreen.main,
              let cgImage = CGWindowListCreateImage(screen.frame, .optionOnScreenOnly, kCGNullWindowID, [.bestResolution]) else {
            return nil
        }
        let bitmapRep = NSBitmapImageRep(cgImage: cgImage)
        return bitmapRep.representation(using: .png, properties: [:])
    }
}
