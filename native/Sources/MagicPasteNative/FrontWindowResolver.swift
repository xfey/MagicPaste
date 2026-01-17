import AppKit
import ApplicationServices

struct AppleScriptWindowInfo {
    let title: String
    let appName: String
}

final class FrontWindowResolver {
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

    func resolve() -> WindowMeta? {
        let frontApp = NSWorkspace.shared.frontmostApplication
        let frontPid = frontApp?.processIdentifier
        let scriptInfo = fetchViaAppleScript()
        let windows = fetchWindowSnapshots()

        if let windows,
           let match = matchWindow(in: windows,
                                   preferredPid: frontPid,
                                   preferredOwner: scriptInfo?.appName ?? frontApp?.localizedName,
                                   preferredTitle: scriptInfo?.title) {
            let appForMatch = app(for: match.pid, hinted: frontApp)
            return buildMeta(from: match,
                             app: appForMatch,
                             preferredTitle: scriptInfo?.title,
                             fallbackProcessName: scriptInfo?.appName)
        }

        if let windows,
           let match = matchWindow(in: windows,
                                   preferredPid: frontPid,
                                   preferredOwner: frontApp?.localizedName,
                                   preferredTitle: nil) {
            let appForMatch = app(for: match.pid, hinted: frontApp)
            return buildMeta(from: match,
                             app: appForMatch,
                             preferredTitle: nil,
                             fallbackProcessName: nil)
        }

        if let windows,
           let match = matchWindow(in: windows,
                                   preferredPid: nil,
                                   preferredOwner: nil,
                                   preferredTitle: nil) {
            let appForMatch = NSRunningApplication(processIdentifier: match.pid)
            return buildMeta(from: match,
                             app: appForMatch,
                             preferredTitle: nil,
                             fallbackProcessName: nil)
        }

        if let scriptInfo,
           let title = normalized(scriptInfo.title) {
            let resolvedAppName = normalized(frontApp?.localizedName)
                ?? normalized(scriptInfo.appName)
                ?? frontApp?.localizedName
                ?? scriptInfo.appName
            return WindowMeta(appName: resolvedAppName,
                              title: title,
                              bundleIdentifier: frontApp?.bundleIdentifier)
        }

        return nil
    }

    private func fetchWindowSnapshots() -> [WindowSnapshot]? {
        guard let rawList = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[CFString: Any]] else {
            return nil
        }
        return rawList.compactMap(WindowSnapshot.init)
    }

    private func matchWindow(in windows: [WindowSnapshot],
                             preferredPid: pid_t?,
                             preferredOwner: String?,
                             preferredTitle: String?) -> WindowSnapshot? {
        let usable = windows.filter { isUsable(record: $0) }
        let normalizedTitle = normalized(preferredTitle)?.lowercased()

        if let pid = preferredPid {
            let pidMatches = usable.filter { $0.pid == pid }
            if let match = choose(from: pidMatches, preferredTitle: normalizedTitle) {
                return match
            }
        }

        if let owner = normalized(preferredOwner)?.lowercased() {
            let ownerMatches = usable.filter { $0.ownerName.lowercased() == owner }
            if let match = choose(from: ownerMatches, preferredTitle: normalizedTitle) {
                return match
            }
        }

        let fallback = usable.filter { !ignoredOwners.contains($0.ownerName) }
        if let match = choose(from: fallback, preferredTitle: normalizedTitle) {
            return match
        }
        return fallback.first ?? usable.first
    }

    private func choose(from records: [WindowSnapshot], preferredTitle: String?) -> WindowSnapshot? {
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

    private func app(for pid: pid_t, hinted frontApp: NSRunningApplication?) -> NSRunningApplication? {
        if let hinted = frontApp, hinted.processIdentifier == pid {
            return hinted
        }
        return NSRunningApplication(processIdentifier: pid)
    }

    private func buildMeta(from record: WindowSnapshot,
                           app: NSRunningApplication?,
                           preferredTitle: String?,
                           fallbackProcessName: String?) -> WindowMeta {
        let finalTitle: String
        if let title = normalized(preferredTitle) {
            finalTitle = title
        } else if let recordTitle = normalized(record.title) {
            finalTitle = recordTitle
        } else if let accessibility = fetchAccessibilityTitle(pid: record.pid) {
            finalTitle = accessibility
        } else {
            finalTitle = ""
        }
        let finalAppName = normalized(app?.localizedName)
            ?? normalized(fallbackProcessName)
            ?? app?.localizedName
            ?? fallbackProcessName
            ?? record.ownerName
        return WindowMeta(appName: finalAppName,
                          title: finalTitle,
                          bundleIdentifier: app?.bundleIdentifier)
    }

    private func fetchViaAppleScript() -> AppleScriptWindowInfo? {
        guard let script = NSAppleScript(source: appleScriptSource) else {
            print("[FrontWindowResolver] 无法创建 AppleScript")
            return nil
        }
        var error: NSDictionary?
        let output = script.executeAndReturnError(&error)
        if let error {
            print("[FrontWindowResolver] AppleScript 执行失败 \(error)")
            return nil
        }
        if output.numberOfItems >= 2 {
            let title = output.atIndex(1)?.stringValue ?? ""
            let appName = output.atIndex(2)?.stringValue ?? ""
            if normalized(title) != nil || normalized(appName) != nil {
                return AppleScriptWindowInfo(title: title, appName: appName)
            }
        } else if let single = output.stringValue, normalized(single) != nil {
            return AppleScriptWindowInfo(title: single, appName: "")
        }
        return nil
    }

    private func isUsable(record: WindowSnapshot) -> Bool {
        if record.layer != 0 { return false }
        if record.alpha < 0.05 { return false }
        if record.bounds.width < 40 || record.bounds.height < 40 { return false }
        return true
    }

    private func fetchAccessibilityTitle(pid: pid_t) -> String? {
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

    private struct WindowSnapshot {
        let ownerName: String
        let title: String
        let pid: pid_t
        let layer: Int
        let alpha: Double
        let bounds: CGRect

        init?(info: [CFString: Any]) {
            guard let ownerName = info[kCGWindowOwnerName] as? String,
                  let pid = info[kCGWindowOwnerPID] as? pid_t else {
                return nil
            }
            self.ownerName = ownerName
            self.pid = pid
            self.title = (info[kCGWindowName] as? String) ?? ""
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
}
