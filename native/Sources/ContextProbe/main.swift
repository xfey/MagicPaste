import AppKit
import CoreGraphics
import Foundation

struct WindowPayload: Codable {
    let title: String
    let appName: String
    let bundleId: String?
}

struct ClipboardPayload: Codable {
    let kind: String
    let text: String?
    let description: String?
    let metadata: [String: String]
}

struct ScreenshotPayload: Codable {
    let data: String
    let format: String
    let width: Int
    let height: Int
    let bytes: Int
}

struct ContextOutput: Codable {
    let window: WindowPayload?
    let clipboard: ClipboardPayload?
    let screenshot: ScreenshotPayload?
    let capturedAt: Date
    let warnings: [String]
}

@main
enum ContextProbeApp {
    static func main() {
        let (window, windowWarnings) = captureWindow()
        let (clipboard, clipboardWarnings) = captureClipboard()
        let (screenshot, screenshotWarnings) = captureScreenshot()
        let payload = ContextOutput(
            window: window,
            clipboard: clipboard,
            screenshot: screenshot,
            capturedAt: Date(),
            warnings: windowWarnings + clipboardWarnings + screenshotWarnings
        )

        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.keyEncodingStrategy = .convertToSnakeCase
        encoder.outputFormatting = [.withoutEscapingSlashes]
        do {
            let data = try encoder.encode(payload)
            guard let output = String(data: data, encoding: .utf8) else {
                fputs("编码 JSON 失败\n", stderr)
                exit(1)
            }
            print(output)
        } catch {
            fputs("编码 JSON 失败: \(error)\n", stderr)
            exit(1)
        }
    }

    private static func captureWindow() -> (WindowPayload?, [String]) {
        var warnings: [String] = []
        let workspace = NSWorkspace.shared
        let frontApp = workspace.frontmostApplication
        let bundleId = frontApp?.bundleIdentifier
        let defaultAppName = frontApp?.localizedName ?? "Unknown App"

        let scriptInfo = fetchWindowViaAppleScript()
        if scriptInfo.errorMessage != nil {
            warnings.append("AppleScript 获取窗口标题失败")
        }

        let resolvedTitle = scriptInfo.title?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? frontApp?.localizedName?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? ""
        let resolvedAppName = scriptInfo.appName?.trimmingCharacters(in: .whitespacesAndNewlines)
            ?? defaultAppName

        if resolvedTitle.isEmpty {
            warnings.append("无法解析窗口标题，已返回空字符串")
        }

        let window = WindowPayload(
            title: resolvedTitle,
            appName: resolvedAppName,
            bundleId: bundleId
        )
        return (window, warnings)
    }

    private static func captureClipboard() -> (ClipboardPayload?, [String]) {
        var warnings: [String] = []
        let pasteboard = NSPasteboard.general

        if let string = pasteboard.string(forType: .string), !string.isEmpty {
            let payload = ClipboardPayload(
                kind: "text",
                text: string,
                description: nil,
                metadata: [:]
            )
            return (payload, warnings)
        }

        if let imageData = pasteboard.data(forType: .png) ?? pasteboard.data(forType: .tiff) {
            var metadata: [String: String] = ["bytes": "\(imageData.count)"]
            if let image = NSImage(data: imageData) {
                let width = Int(image.size.width.rounded())
                let height = Int(image.size.height.rounded())
                metadata["size"] = "\(width)x\(height)"
            }
            let payload = ClipboardPayload(
                kind: "image",
                text: nil,
                description: "Image clipboard",
                metadata: metadata
            )
            return (payload, warnings)
        }

        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL],
           !urls.isEmpty {
            var metadata: [String: String] = ["count": "\(urls.count)"]
            let samples = urls.prefix(5).map { $0.lastPathComponent }
            metadata["files"] = samples.joined(separator: ", ")
            let payload = ClipboardPayload(
                kind: "files",
                text: nil,
                description: "File references",
                metadata: metadata
            )
            return (payload, warnings)
        }

        warnings.append("剪贴板为空或不支持的类型")
        return (nil, warnings)
    }

    private static func captureScreenshot() -> (ScreenshotPayload?, [String]) {
        var warnings: [String] = []
        guard let cgImage = CGDisplayCreateImage(CGMainDisplayID()) else {
            warnings.append("无法捕获屏幕截图")
            return (nil, warnings)
        }
        let resizedImage = resizeIfNeeded(image: cgImage, warnings: &warnings)
        let bitmap = NSBitmapImageRep(cgImage: resizedImage)
        let width = bitmap.pixelsWide
        let height = bitmap.pixelsHigh
        let properties: [NSBitmapImageRep.PropertyKey: Any] = [
            .compressionFactor: 0.6
        ]
        guard let jpegData = bitmap.representation(using: .jpeg, properties: properties) else {
            warnings.append("截图编码失败")
            return (nil, warnings)
        }

        let payload = ScreenshotPayload(
            data: jpegData.base64EncodedString(),
            format: "jpeg",
            width: width,
            height: height,
            bytes: jpegData.count
        )
        return (payload, warnings)
    }

    private static func resizeIfNeeded(image: CGImage, warnings: inout [String]) -> CGImage {
        let maxDimension: CGFloat = 1600
        let width = CGFloat(image.width)
        let height = CGFloat(image.height)
        let longestSide = max(width, height)
        guard longestSide > maxDimension else {
            return image
        }

        let scale = maxDimension / longestSide
        let targetWidth = max(1, Int(width * scale))
        let targetHeight = max(1, Int(height * scale))
        let colorSpace = image.colorSpace ?? CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue

        guard let context = CGContext(
            data: nil,
            width: targetWidth,
            height: targetHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: colorSpace,
            bitmapInfo: bitmapInfo
        ) else {
            warnings.append("无法缩放截图，返回原始尺寸")
            return image
        }

        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: targetWidth, height: targetHeight))
        guard let scaledImage = context.makeImage() else {
            warnings.append("截图缩放失败，返回原始尺寸")
            return image
        }
        return scaledImage
    }

    private static func fetchWindowViaAppleScript() -> (title: String?, appName: String?, errorMessage: String?) {
        let source = """
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

        guard let script = NSAppleScript(source: source) else {
            return (nil, nil, "无法创建 AppleScript")
        }

        var errorDict: NSDictionary?
        let output = script.executeAndReturnError(&errorDict)
        if let errorDict {
            return (nil, nil, "AppleScript 执行失败: \(errorDict)")
        }

        if output.numberOfItems >= 2 {
            let title = output.atIndex(1)?.stringValue ?? ""
            let appName = output.atIndex(2)?.stringValue ?? ""
            return (title, appName, nil)
        } else if let single = output.stringValue {
            return (single, nil, nil)
        }

        return (nil, nil, "AppleScript 无输出")
    }
}
