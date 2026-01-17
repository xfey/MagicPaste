import AppKit

struct ClipboardPayload: Codable {
    enum PayloadType: String, Codable {
        case text
        case image
        case files
    }

    let type: PayloadType
    let text: String?
    let imagePNGData: Data?
    let fileURLs: [URL]?
}

enum ClipboardBridge {
    static func captureClipboard() -> ClipboardPayload? {
        let pb = NSPasteboard.general
        if let string = pb.string(forType: .string) {
            return ClipboardPayload(type: .text, text: string, imagePNGData: nil, fileURLs: nil)
        }
        if let data = pb.data(forType: .png) ?? pb.data(forType: .tiff) {
            return ClipboardPayload(type: .image, text: nil, imagePNGData: data, fileURLs: nil)
        }
        if let urls = pb.readObjects(forClasses: [NSURL.self], options: nil) as? [URL], !urls.isEmpty {
            return ClipboardPayload(type: .files, text: nil, imagePNGData: nil, fileURLs: urls)
        }
        return nil
    }

    static func simulatePaste(_ payload: ClipboardPayload) {
        let pb = NSPasteboard.general
        pb.clearContents()
        switch payload.type {
        case .text:
            pb.setString(payload.text ?? "", forType: .string)
        case .image:
            if let data = payload.imagePNGData, let image = NSImage(data: data) {
                pb.clearContents()
                pb.writeObjects([image])
            }
        case .files:
            if let urls = payload.fileURLs {
                pb.writeObjects(urls as [NSPasteboardWriting])
            }
        }

        guard let source = CGEventSource(stateID: .hidSystemState) else { return }
        let keyDown = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true)
        keyDown?.flags = .maskCommand
        keyDown?.post(tap: .cghidEventTap)

        let keyUp = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false)
        keyUp?.flags = .maskCommand
        keyUp?.post(tap: .cghidEventTap)
    }
}
