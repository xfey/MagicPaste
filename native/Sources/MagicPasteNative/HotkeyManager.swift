import Carbon
import AppKit

final class HotkeyManager {
    struct Trigger {
        let keyCode: UInt32
        let modifiers: UInt32
    }

    private var hotKeyRef: EventHotKeyRef?
    private var eventHandler: EventHandlerRef?
    private let handler: () -> Void
    private var currentTrigger: String?

    init(handler: @escaping () -> Void) {
        self.handler = handler
        installEventHandler()
    }

    deinit {
        unregisterHotkey()
        if let eventHandler {
            RemoveEventHandler(eventHandler)
        }
    }

    @discardableResult
    func updateTrigger(_ trigger: String) -> Bool {
        print("[Hotkey] update requested \(trigger)")
        guard let parsed = HotkeyManager.parse(trigger: trigger) else {
            print("[Hotkey] \(trigger) 解析失败，格式应为 cmd+shift+v")
            return false
        }
        print("[Hotkey] registering trigger \(trigger) keyCode=\(parsed.keyCode) modifiers=\(String(parsed.modifiers, radix: 16))")
        registerHotkey(parsed)
        currentTrigger = trigger
        print("[Hotkey] 热键已更新为 \(trigger)")
        return true
    }

    private func registerHotkey(_ trigger: Trigger) {
        unregisterHotkey()
        var hotKeyID = EventHotKeyID(signature: OSType(UInt32(truncatingIfNeeded: "MPHK".hashValue)), id: UInt32(1))
        let status = RegisterEventHotKey(trigger.keyCode, trigger.modifiers, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            print("[Hotkey] 注册热键失败：\(status)")
        } else {
            print("[Hotkey] RegisterEventHotKey success -> \(trigger.keyCode)/\(String(trigger.modifiers, radix: 16))")
        }
    }

    private func unregisterHotkey() {
        if let hotKeyRef {
            UnregisterEventHotKey(hotKeyRef)
            self.hotKeyRef = nil
            print("[Hotkey] 旧热键已注销")
        }
    }

    private func installEventHandler() {
        print("[Hotkey] installing event handler")
        var eventSpec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        let callback: EventHandlerUPP = { _, _, userData in
            guard let userData else { return noErr }
            let manager = Unmanaged<HotkeyManager>.fromOpaque(userData).takeUnretainedValue()
            print("[Hotkey] fired")
            manager.handler()
            return noErr
        }

        let selfPointer = UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
        let status = InstallEventHandler(GetApplicationEventTarget(), callback, 1, &eventSpec, selfPointer, &eventHandler)
        if status != noErr {
            print("[Hotkey] 安装热键事件处理失败：\(status)")
        } else {
            print("[Hotkey] 事件处理已安装，等待按键")
        }
    }

    private static func parse(trigger: String) -> Trigger? {
        let parts = trigger.lowercased().split(separator: "+").map { String($0).trimmingCharacters(in: .whitespaces) }
        guard let last = parts.last, let keyCode = keyCode(for: last) else {
            return nil
        }
        let modifierTokens = parts.dropLast()
        var modifiers: UInt32 = 0
        for token in modifierTokens {
            switch token {
            case "cmd", "command":
                modifiers |= UInt32(cmdKey)
            case "shift":
                modifiers |= UInt32(shiftKey)
            case "ctrl", "control":
                modifiers |= UInt32(controlKey)
            case "alt", "option":
                modifiers |= UInt32(optionKey)
            default:
                continue
            }
        }
        if modifiers == 0 {
            modifiers = UInt32(cmdKey) // 默认至少包含 ⌘
        }
        return Trigger(keyCode: keyCode, modifiers: modifiers)
    }

    private static func keyCode(for key: String) -> UInt32? {
        switch key {
        case "a": return UInt32(kVK_ANSI_A)
        case "b": return UInt32(kVK_ANSI_B)
        case "c": return UInt32(kVK_ANSI_C)
        case "d": return UInt32(kVK_ANSI_D)
        case "e": return UInt32(kVK_ANSI_E)
        case "f": return UInt32(kVK_ANSI_F)
        case "g": return UInt32(kVK_ANSI_G)
        case "h": return UInt32(kVK_ANSI_H)
        case "i": return UInt32(kVK_ANSI_I)
        case "j": return UInt32(kVK_ANSI_J)
        case "k": return UInt32(kVK_ANSI_K)
        case "l": return UInt32(kVK_ANSI_L)
        case "m": return UInt32(kVK_ANSI_M)
        case "n": return UInt32(kVK_ANSI_N)
        case "o": return UInt32(kVK_ANSI_O)
        case "p": return UInt32(kVK_ANSI_P)
        case "q": return UInt32(kVK_ANSI_Q)
        case "r": return UInt32(kVK_ANSI_R)
        case "s": return UInt32(kVK_ANSI_S)
        case "t": return UInt32(kVK_ANSI_T)
        case "u": return UInt32(kVK_ANSI_U)
        case "v": return UInt32(kVK_ANSI_V)
        case "w": return UInt32(kVK_ANSI_W)
        case "x": return UInt32(kVK_ANSI_X)
        case "y": return UInt32(kVK_ANSI_Y)
        case "z": return UInt32(kVK_ANSI_Z)
        case "1": return UInt32(kVK_ANSI_1)
        case "2": return UInt32(kVK_ANSI_2)
        case "3": return UInt32(kVK_ANSI_3)
        case "4": return UInt32(kVK_ANSI_4)
        case "5": return UInt32(kVK_ANSI_5)
        case "6": return UInt32(kVK_ANSI_6)
        case "7": return UInt32(kVK_ANSI_7)
        case "8": return UInt32(kVK_ANSI_8)
        case "9": return UInt32(kVK_ANSI_9)
        case "0": return UInt32(kVK_ANSI_0)
        case "space", "spacebar": return UInt32(kVK_Space)
        case "return", "enter": return UInt32(kVK_Return)
        case "tab": return UInt32(kVK_Tab)
        default:
            return nil
        }
    }
}
