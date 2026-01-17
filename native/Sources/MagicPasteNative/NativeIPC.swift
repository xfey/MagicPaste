import Foundation

struct ContextSnapshot: Codable {
    let window: WindowMeta
    let clipboard: ClipboardPayload?
    let screenshot: Data?
    let capturedAt: Date
}

private struct ContextEnvelope: Codable {
    let type: String
    let snapshot: ContextSnapshot
}

private struct PasteEnvelope: Codable {
    let type: String
    let payload: ClipboardPayload?
}

private struct SettingsEnvelope: Codable {
    let type: String
    let payload: SettingsPayload
}

private struct SettingsPayload: Codable {
    let hotkey: HotkeyConfig?
}

private struct HotkeyConfig: Codable {
    let trigger: String
}

final class NativeIPC {
    private var webSocketTask: URLSessionWebSocketTask?
    private let session = URLSession(configuration: .default)
    private let hotkeyManager: HotkeyManager

    init(hotkeyManager: HotkeyManager) {
        self.hotkeyManager = hotkeyManager
    }

    func connect() {
        guard let url = URL(string: "ws://127.0.0.1:4090/native") else { return }
        webSocketTask = session.webSocketTask(with: url)
        webSocketTask?.resume()
        print("[NativeIPC] Connecting to \(url.absoluteString)")
        listen()
    }

    func sendSnapshot(_ snapshot: ContextSnapshot) {
        guard let task = webSocketTask else {
            print("[NativeIPC] sendSnapshot: 尚未连接 WebSocket，丢弃快照")
            return
        }
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let envelope = ContextEnvelope(type: "context", snapshot: snapshot)
        guard let data = try? encoder.encode(envelope) else {
            print("[NativeIPC] 快照编码失败")
            return
        }

        task.send(.data(data)) { [weak self] error in
            if let error = error {
                print("[NativeIPC] Failed to send snapshot: \(error)")
                self?.scheduleReconnect()
            } else {
                print("[NativeIPC] Snapshot sent")
            }
        }
    }

    private func listen() {
        webSocketTask?.receive { [weak self] result in
            switch result {
            case .failure(let error):
                print("[NativeIPC] WebSocket error: \(error)")
                self?.scheduleReconnect()
            case .success(let message):
                switch message {
                case .data(let data):
                    print("[NativeIPC] message received (.data, \(data.count) bytes)")
                    self?.handle(data: data)
                case .string(let text):
                    print("[NativeIPC] message received (.string, \(text.count) chars)")
                    if let data = text.data(using: .utf8) {
                        self?.handle(data: data)
                    }
                @unknown default:
                    break
                }
                self?.listen()
            }
        }
    }

    private func handle(data: Data) {
        let decoder = JSONDecoder()
        if let base = try? decoder.decode(BaseMessage.self, from: data) {
            switch base.type {
            case "paste":
                if let message = try? decoder.decode(PasteEnvelope.self, from: data),
                   let payload = message.payload {
                    print("[NativeIPC] Received paste instruction for type \(payload.type.rawValue)")
                    ClipboardBridge.simulatePaste(payload)
                }
            case "settings":
                if let settings = try? decoder.decode(SettingsEnvelope.self, from: data),
                   let trigger = settings.payload.hotkey?.trigger {
                    print("[NativeIPC] Received hotkey update \(trigger)")
                    hotkeyManager.updateTrigger(trigger)
                } else {
                    print("[NativeIPC] settings 消息解析失败")
                }
            default:
                if let text = String(data: data, encoding: .utf8) {
                    print("[NativeIPC] 收到未知消息类型 \(base.type): \(text)")
                } else {
                    print("[NativeIPC] 收到未知消息类型 \(base.type)")
                }
            }
        } else {
            print("[NativeIPC] handle(data:) 无法解析消息")
        }
    }

    private struct BaseMessage: Codable {
        let type: String
    }

    private func scheduleReconnect() {
        webSocketTask?.cancel()
        print("[NativeIPC] schedule reconnect after 2s")
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            print("[NativeIPC] reconnecting...")
            self?.connect()
        }
    }
}
