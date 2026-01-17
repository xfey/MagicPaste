import AppKit
import CoreGraphics
import ApplicationServices

struct WindowRecord {
    let ownerName: String
    let title: String
    let pid: pid_t
    let layer: Int
    let alpha: Double
    let bounds: CGRect

    init(ownerName: String, title: String, pid: pid_t, layer: Int, alpha: Double, bounds: CGRect) {
        self.ownerName = ownerName
        self.title = title
        self.pid = pid
        self.layer = layer
        self.alpha = alpha
        self.bounds = bounds
    }

    init?(info: [CFString: Any]) {
        guard let ownerName = info[kCGWindowOwnerName] as? String,
              let pid = info[kCGWindowOwnerPID] as? pid_t else {
            return nil
        }

        self.ownerName = ownerName
        self.title = (info[kCGWindowName] as? String) ?? ""
        self.pid = pid
        self.layer = (info[kCGWindowLayer] as? Int) ?? 0
        self.alpha = (info[kCGWindowAlpha] as? Double) ?? 0

        if let boundsDict = info[kCGWindowBounds] as? [String: CGFloat] {
            let x = boundsDict["X"] ?? 0
            let y = boundsDict["Y"] ?? 0
            let width = boundsDict["Width"] ?? 0
            let height = boundsDict["Height"] ?? 0
            self.bounds = CGRect(x: x, y: y, width: width, height: height)
        } else {
            self.bounds = .zero
        }
    }
}

struct AppleScriptInfo {
    let title: String
    let appName: String
}

final class WindowInspector {
    private let ignoredOwners: Set<String> = [
        "Window Server",
        "Dock",
        "程序坞",
        "控制中心",
        "BarGemini",
        "TokenBurner",
        "TextInputMenuAgent"
    ]

    private let appleScriptSource = """
    tell application "System Events"
        set frontProcesses to application processes whose frontmost is true
        if (count of frontProcesses) = 0 then return {"", ""}
        tell (first item of frontProcesses)
            set processName to name
            set windowTitle to ""
            try
                set windowTitle to name of window 1
            end try
            return {windowTitle, processName}
        end tell
    end tell
    """

    func dumpAllWindows(limit: Int = 40) {
        guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[CFString: Any]] else {
            print("无法获取窗口列表")
            return
        }
        print("---- 原始窗口列表 (前 \(limit) 条，CGWindow 顺序) ----")
        for (index, info) in rawList.enumerated() where index < limit {
            if let record = WindowRecord(info: info) {
                print(recordDescription(record, index: index))
            }
        }
        print("---- End ----")
    }

    func pickActiveWindow() -> WindowRecord? {
        guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] else {
            print("CGWindowListCopyWindowInfo 失败")
            return nil
        }
        let records = rawList.compactMap(WindowRecord.init)
        let scriptInfo = fetchAppleScriptInfo()
        let frontApp = NSWorkspace.shared.frontmostApplication
        let preferredOwner = frontApp?.localizedName ?? scriptInfo?.appName

        if let match = matchWindow(in: records,
                                   preferredPid: frontApp?.processIdentifier,
                                   preferredOwner: preferredOwner,
                                   preferredTitle: scriptInfo?.title) {
            return enrich(record: match, scriptInfo: scriptInfo, frontApp: frontApp)
        }

        if let match = matchWindow(in: records,
                                   preferredPid: frontApp?.processIdentifier,
                                   preferredOwner: frontApp?.localizedName,
                                   preferredTitle: nil) {
            return enrich(record: match, scriptInfo: nil, frontApp: frontApp)
        }

        if let match = matchWindow(in: records,
                                   preferredPid: nil,
                                   preferredOwner: nil,
                                   preferredTitle: nil) {
            return enrich(record: match, scriptInfo: nil, frontApp: nil)
        }

        return nil
    }

    private func enrich(record: WindowRecord,
                        scriptInfo: AppleScriptInfo?,
                        frontApp: NSRunningApplication?) -> WindowRecord {
        let preferredTitle = normalized(scriptInfo?.title)
        let resolvedTitle = preferredTitle
            ?? normalized(record.title)
            ?? accessibilityTitle(for: record.pid)
            ?? ""
        let resolvedOwner = normalized(frontApp?.localizedName)
            ?? normalized(scriptInfo?.appName)
            ?? frontApp?.localizedName
            ?? scriptInfo?.appName
            ?? record.ownerName
        return WindowRecord(ownerName: resolvedOwner,
                            title: resolvedTitle,
                            pid: record.pid,
                            layer: record.layer,
                            alpha: record.alpha,
                            bounds: record.bounds)
    }

    private func matchWindow(in records: [WindowRecord],
                             preferredPid: pid_t?,
                             preferredOwner: String?,
                             preferredTitle: String?) -> WindowRecord? {
        let usable = records.filter { isUsable($0) }
        let normalizedTitle = normalized(preferredTitle)?.lowercased()

        if let pid = preferredPid {
            let pidMatches = usable.filter { $0.pid == pid }
            if let match = select(from: pidMatches, preferredTitle: normalizedTitle) {
                return match
            }
        }

        if let owner = normalized(preferredOwner)?.lowercased() {
            let ownerMatches = usable.filter { $0.ownerName.lowercased() == owner }
            if let match = select(from: ownerMatches, preferredTitle: normalizedTitle) {
                return match
            }
        }

        let fallback = usable.filter { !ignoredOwners.contains($0.ownerName) }
        if let match = select(from: fallback, preferredTitle: normalizedTitle) {
            return match
        }
        return fallback.first ?? usable.first
    }

    private func select(from records: [WindowRecord], preferredTitle: String?) -> WindowRecord? {
        guard !records.isEmpty else { return nil }
        if let target = preferredTitle, !target.isEmpty {
            if let exact = records.first(where: { normalized($0.title)?.lowercased() == target }) {
                return exact
            }
            if let fuzzy = records.first(where: {
                guard let candidate = normalized($0.title)?.lowercased() else { return false }
                return candidate.contains(target) || target.contains(candidate)
            }) {
                return fuzzy
            }
        }
        return records.first
    }

    private func normalized(_ text: String?) -> String? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
            return nil
        }
        return text
    }

    private func fetchAppleScriptInfo() -> AppleScriptInfo? {
        guard let script = NSAppleScript(source: appleScriptSource) else {
            return nil
        }
        var error: NSDictionary?
        let output = script.executeAndReturnError(&error)
        if let error = error {
            print("AppleScript 获取标题失败 \(error)")
            return nil
        }
        if output.numberOfItems >= 2 {
            let title = output.atIndex(1)?.stringValue ?? ""
            let appName = output.atIndex(2)?.stringValue ?? ""
            if normalized(title) != nil || normalized(appName) != nil {
                return AppleScriptInfo(title: title, appName: appName)
            }
        }
        return nil
    }

    private func accessibilityTitle(for pid: pid_t) -> String? {
        let appElement = AXUIElementCreateApplication(pid)
        var windowRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(appElement, kAXFocusedWindowAttribute as CFString, &windowRef) == .success,
              let window = windowRef else {
            return nil
        }

        var titleRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(window as! AXUIElement, kAXTitleAttribute as CFString, &titleRef) == .success else {
            return nil
        }
        return titleRef as? String
    }

    private func isUsable(_ record: WindowRecord) -> Bool {
        if record.layer != 0 { return false }
        if record.alpha < 0.05 { return false }
        if record.bounds.width < 40 || record.bounds.height < 40 { return false }
        return true
    }
}

private func recordDescription(_ record: WindowRecord, index: Int) -> String {
    return String(format: "%02d owner=%@ pid=%d layer=%d alpha=%.2f title=%@ bounds=%.0fx%.0f+%.0f+%.0f",
                  index,
                  record.ownerName,
                  record.pid,
                  record.layer,
                  record.alpha,
                  record.title.isEmpty ? "<empty>" : record.title,
                  record.bounds.width,
                  record.bounds.height,
                  record.bounds.origin.x,
                  record.bounds.origin.y)
}

let inspector = WindowInspector()
inspector.dumpAllWindows(limit: 25)
if let active = inspector.pickActiveWindow() {
    print("当前窗口 -> owner=\(active.ownerName) title=\(active.title.isEmpty ? "<empty>" : active.title) pid=\(active.pid)")
} else {
    print("无法推断当前窗口")
}
