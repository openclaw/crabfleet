import ApplicationServices
import Carbon.HIToolbox
import Foundation

protocol RemoteInputForwarding: Sendable {
  func keyEvent(down: Bool, keysym: UInt32)
  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16)
  func updateFrameSize(width: Int, height: Int)
}

extension RemoteInputForwarding {
  func updateFrameSize(width: Int, height: Int) {}
}

final class MacRemoteInputController: RemoteInputForwarding, @unchecked Sendable {
  private let descriptor: CapturedDisplayDescriptor
  private let eventQueue = DispatchQueue(
    label: "org.openclaw.crabfleet.remote-input",
    qos: .userInteractive
  )
  private let frameSizeLock = NSLock()
  private var frameWidth: Int
  private var frameHeight: Int
  private var previousButtonMask: UInt8 = 0

  init(descriptor: CapturedDisplayDescriptor) {
    self.descriptor = descriptor
    frameWidth = descriptor.frameWidth
    frameHeight = descriptor.frameHeight
  }

  /// Keeps pointer scaling aligned with the announced framebuffer size after
  /// a client-requested desktop resize.
  func updateFrameSize(width: Int, height: Int) {
    frameSizeLock.lock()
    frameWidth = width
    frameHeight = height
    frameSizeLock.unlock()
  }

  static var isAccessibilityGranted: Bool {
    AXIsProcessTrusted()
  }

  @discardableResult
  static func requestAccessibility() -> Bool {
    let options =
      [
        kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
      ] as CFDictionary
    return AXIsProcessTrustedWithOptions(options)
  }

  func keyEvent(down: Bool, keysym: UInt32) {
    eventQueue.async { [self] in
      guard Self.isAccessibilityGranted else { return }
      let event: CGEvent?
      if let keyCode = Self.keyCode(for: keysym) {
        event = CGEvent(keyboardEventSource: eventSource(), virtualKey: keyCode, keyDown: down)
      } else if let scalar = UnicodeScalar(keysym) {
        let candidate = CGEvent(keyboardEventSource: eventSource(), virtualKey: 0, keyDown: down)
        var codeUnits = Array(String(scalar).utf16)
        candidate?.keyboardSetUnicodeString(
          stringLength: codeUnits.count,
          unicodeString: &codeUnits
        )
        event = candidate
      } else {
        event = nil
      }
      event?.post(tap: .cghidEventTap)
    }
  }

  func pointerEvent(buttonMask: UInt8, x: UInt16, y: UInt16) {
    eventQueue.async { [self] in
      guard Self.isAccessibilityGranted else { return }
      let location = mappedLocation(x: x, y: y)
      let changedButtons = previousButtonMask ^ buttonMask
      var postedButtonChange = false

      for button in Self.mouseButtons where changedButtons & button.mask != 0 {
        let isDown = buttonMask & button.mask != 0
        let type = isDown ? button.downType : button.upType
        CGEvent(
          mouseEventSource: eventSource(),
          mouseType: type,
          mouseCursorPosition: location,
          mouseButton: button.button
        )?.post(tap: .cghidEventTap)
        postedButtonChange = true
      }

      if !postedButtonChange {
        let moveType: CGEventType
        if buttonMask & 0x01 != 0 {
          moveType = .leftMouseDragged
        } else if buttonMask & 0x04 != 0 {
          moveType = .rightMouseDragged
        } else if buttonMask & 0x02 != 0 {
          moveType = .otherMouseDragged
        } else {
          moveType = .mouseMoved
        }
        CGEvent(
          mouseEventSource: eventSource(),
          mouseType: moveType,
          mouseCursorPosition: location,
          mouseButton: .left
        )?.post(tap: .cghidEventTap)
      }

      let newWheelBits = buttonMask & ~previousButtonMask
      if newWheelBits & 0x08 != 0 { postScroll(vertical: 1, horizontal: 0) }
      if newWheelBits & 0x10 != 0 { postScroll(vertical: -1, horizontal: 0) }
      if newWheelBits & 0x20 != 0 { postScroll(vertical: 0, horizontal: 1) }
      if newWheelBits & 0x40 != 0 { postScroll(vertical: 0, horizontal: -1) }
      previousButtonMask = buttonMask
    }
  }

  private func eventSource() -> CGEventSource? {
    CGEventSource(stateID: .hidSystemState)
  }

  private func mappedLocation(x: UInt16, y: UInt16) -> CGPoint {
    frameSizeLock.lock()
    let currentFrameWidth = frameWidth
    let currentFrameHeight = frameHeight
    frameSizeLock.unlock()
    let width = max(currentFrameWidth - 1, 1)
    let height = max(currentFrameHeight - 1, 1)
    let xRatio = min(max(CGFloat(x) / CGFloat(width), 0), 1)
    let yRatio = min(max(CGFloat(y) / CGFloat(height), 0), 1)
    return CGPoint(
      x: descriptor.displayBounds.minX + xRatio * descriptor.displayBounds.width,
      y: descriptor.displayBounds.minY + yRatio * descriptor.displayBounds.height
    )
  }

  private func postScroll(vertical: Int32, horizontal: Int32) {
    CGEvent(
      scrollWheelEvent2Source: eventSource(),
      units: .line,
      wheelCount: 2,
      wheel1: vertical,
      wheel2: horizontal,
      wheel3: 0
    )?.post(tap: .cghidEventTap)
  }

  static func keyCode(for keysym: UInt32) -> CGKeyCode? {
    if let ascii = UnicodeScalar(keysym), ascii.isASCII {
      let character = Character(String(ascii).lowercased())
      if let code = asciiKeyCodes[character] { return code }
    }

    switch keysym {
    case 0xFF08: return CGKeyCode(kVK_Delete)
    case 0xFF09: return CGKeyCode(kVK_Tab)
    case 0xFF0D: return CGKeyCode(kVK_Return)
    case 0xFF1B: return CGKeyCode(kVK_Escape)
    case 0xFF50: return CGKeyCode(kVK_Home)
    case 0xFF51: return CGKeyCode(kVK_LeftArrow)
    case 0xFF52: return CGKeyCode(kVK_UpArrow)
    case 0xFF53: return CGKeyCode(kVK_RightArrow)
    case 0xFF54: return CGKeyCode(kVK_DownArrow)
    case 0xFF55: return CGKeyCode(kVK_PageUp)
    case 0xFF56: return CGKeyCode(kVK_PageDown)
    case 0xFF57: return CGKeyCode(kVK_End)
    case 0xFF63: return CGKeyCode(kVK_Help)
    case 0xFFFF: return CGKeyCode(kVK_ForwardDelete)
    case 0xFFE1: return CGKeyCode(kVK_Shift)
    case 0xFFE2: return CGKeyCode(kVK_RightShift)
    case 0xFFE3: return CGKeyCode(kVK_Control)
    case 0xFFE4: return CGKeyCode(kVK_RightControl)
    case 0xFFE7, 0xFFEB: return CGKeyCode(kVK_Command)
    case 0xFFE8, 0xFFEC: return CGKeyCode(kVK_RightCommand)
    case 0xFFE9: return CGKeyCode(kVK_Option)
    case 0xFFEA: return CGKeyCode(kVK_RightOption)
    case 0xFFBE...0xFFC9:
      let functionKeys: [CGKeyCode] = [
        CGKeyCode(kVK_F1), CGKeyCode(kVK_F2), CGKeyCode(kVK_F3), CGKeyCode(kVK_F4),
        CGKeyCode(kVK_F5), CGKeyCode(kVK_F6), CGKeyCode(kVK_F7), CGKeyCode(kVK_F8),
        CGKeyCode(kVK_F9), CGKeyCode(kVK_F10), CGKeyCode(kVK_F11), CGKeyCode(kVK_F12),
      ]
      return functionKeys[Int(keysym - 0xFFBE)]
    default:
      return nil
    }
  }

  private static let asciiKeyCodes: [Character: CGKeyCode] = [
    "a": CGKeyCode(kVK_ANSI_A), "b": CGKeyCode(kVK_ANSI_B),
    "c": CGKeyCode(kVK_ANSI_C), "d": CGKeyCode(kVK_ANSI_D),
    "e": CGKeyCode(kVK_ANSI_E), "f": CGKeyCode(kVK_ANSI_F),
    "g": CGKeyCode(kVK_ANSI_G), "h": CGKeyCode(kVK_ANSI_H),
    "i": CGKeyCode(kVK_ANSI_I), "j": CGKeyCode(kVK_ANSI_J),
    "k": CGKeyCode(kVK_ANSI_K), "l": CGKeyCode(kVK_ANSI_L),
    "m": CGKeyCode(kVK_ANSI_M), "n": CGKeyCode(kVK_ANSI_N),
    "o": CGKeyCode(kVK_ANSI_O), "p": CGKeyCode(kVK_ANSI_P),
    "q": CGKeyCode(kVK_ANSI_Q), "r": CGKeyCode(kVK_ANSI_R),
    "s": CGKeyCode(kVK_ANSI_S), "t": CGKeyCode(kVK_ANSI_T),
    "u": CGKeyCode(kVK_ANSI_U), "v": CGKeyCode(kVK_ANSI_V),
    "w": CGKeyCode(kVK_ANSI_W), "x": CGKeyCode(kVK_ANSI_X),
    "y": CGKeyCode(kVK_ANSI_Y), "z": CGKeyCode(kVK_ANSI_Z),
    "0": CGKeyCode(kVK_ANSI_0), "1": CGKeyCode(kVK_ANSI_1),
    "2": CGKeyCode(kVK_ANSI_2), "3": CGKeyCode(kVK_ANSI_3),
    "4": CGKeyCode(kVK_ANSI_4), "5": CGKeyCode(kVK_ANSI_5),
    "6": CGKeyCode(kVK_ANSI_6), "7": CGKeyCode(kVK_ANSI_7),
    "8": CGKeyCode(kVK_ANSI_8), "9": CGKeyCode(kVK_ANSI_9),
    " ": CGKeyCode(kVK_Space), "-": CGKeyCode(kVK_ANSI_Minus),
    "=": CGKeyCode(kVK_ANSI_Equal), "[": CGKeyCode(kVK_ANSI_LeftBracket),
    "]": CGKeyCode(kVK_ANSI_RightBracket), "\\": CGKeyCode(kVK_ANSI_Backslash),
    ";": CGKeyCode(kVK_ANSI_Semicolon), "'": CGKeyCode(kVK_ANSI_Quote),
    ",": CGKeyCode(kVK_ANSI_Comma), ".": CGKeyCode(kVK_ANSI_Period),
    "/": CGKeyCode(kVK_ANSI_Slash), "`": CGKeyCode(kVK_ANSI_Grave),
  ]

  private static let mouseButtons: [MouseButtonMapping] = [
    .init(mask: 0x01, button: .left, downType: .leftMouseDown, upType: .leftMouseUp),
    .init(mask: 0x02, button: .center, downType: .otherMouseDown, upType: .otherMouseUp),
    .init(mask: 0x04, button: .right, downType: .rightMouseDown, upType: .rightMouseUp),
  ]
}

private struct MouseButtonMapping {
  let mask: UInt8
  let button: CGMouseButton
  let downType: CGEventType
  let upType: CGEventType
}
