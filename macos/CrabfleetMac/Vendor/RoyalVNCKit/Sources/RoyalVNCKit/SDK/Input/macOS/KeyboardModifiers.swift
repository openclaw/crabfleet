#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

struct KeyboardModifiers {
	let leftShift: ModifierKey
	let rightShift: ModifierKey

	let leftControl: ModifierKey
	let rightControl: ModifierKey

	let leftOption: ModifierKey
	let rightOption: ModifierKey

	let leftCommand: ModifierKey
	let rightCommand: ModifierKey

	var modifierKeys: [ModifierKey] {
		[
			leftShift, rightShift,
			leftControl, rightControl,
			leftOption, rightOption,
			leftCommand, rightCommand
		]
	}

    // swiftlint:disable:next function_body_length
	init(currentFlags: NSEvent.ModifierFlags,
		 lastFlags: NSEvent.ModifierFlags) {
		var leftShiftWentDown = false
		var leftShiftWentUp = false

		var rightShiftWentDown = false
		var rightShiftWentUp = false

		var leftControlWentDown = false
		var leftControlWentUp = false

		var rightControlWentDown = false
		var rightControlWentUp = false

		var leftOptionWentDown = false
		var leftOptionWentUp = false

		var rightOptionWentDown = false
		var rightOptionWentUp = false

		var leftCommandWentDown = false
		var leftCommandWentUp = false

		var rightCommandWentDown = false
		var rightCommandWentUp = false

		if currentFlags.contains(.leftShift),
		   !lastFlags.contains(.leftShift) {
			leftShiftWentDown = true
		} else if !currentFlags.contains(.leftShift),
				  lastFlags.contains(.leftShift) {
			leftShiftWentUp = true
		}

		if currentFlags.contains(.rightShift),
		   !lastFlags.contains(.rightShift) {
			rightShiftWentDown = true
		} else if !currentFlags.contains(.rightShift),
				  lastFlags.contains(.rightShift) {
			rightShiftWentUp = true
		}

		if currentFlags.contains(.leftControl),
		   !lastFlags.contains(.leftControl) {
			leftControlWentDown = true
		} else if !currentFlags.contains(.leftControl),
				  lastFlags.contains(.leftControl) {
			leftControlWentUp = true
		}

		if currentFlags.contains(.rightControl),
		   !lastFlags.contains(.rightControl) {
			rightControlWentDown = true
		} else if !currentFlags.contains(.rightControl),
				  lastFlags.contains(.rightControl) {
			rightControlWentUp = true
		}

		if currentFlags.contains(.leftOption),
		   !lastFlags.contains(.leftOption) {
			leftOptionWentDown = true
		} else if !currentFlags.contains(.leftOption),
				  lastFlags.contains(.leftOption) {
			leftOptionWentUp = true
		}

		if currentFlags.contains(.rightOption),
		   !lastFlags.contains(.rightOption) {
			rightOptionWentDown = true
		} else if !currentFlags.contains(.rightOption),
				  lastFlags.contains(.rightOption) {
			rightOptionWentUp = true
		}

		if currentFlags.contains(.leftCommand),
		   !lastFlags.contains(.leftCommand) {
			leftCommandWentDown = true
		} else if !currentFlags.contains(.leftCommand),
				  lastFlags.contains(.leftCommand) {
			leftCommandWentUp = true
		}

		if currentFlags.contains(.rightCommand),
		   !lastFlags.contains(.rightCommand) {
			rightCommandWentDown = true
		} else if !currentFlags.contains(.rightCommand),
				  lastFlags.contains(.rightCommand) {
			rightCommandWentUp = true
		}

		self.leftShift = .init(key: CGKeyCodes.shift,
							   down: leftShiftWentDown,
							   up: leftShiftWentUp)

		self.rightShift = .init(key: CGKeyCodes.rightShift,
								down: rightShiftWentDown,
								up: rightShiftWentUp)

		self.leftControl = .init(key: CGKeyCodes.control,
								 down: leftControlWentDown,
								 up: leftControlWentUp)

		self.rightControl = .init(key: CGKeyCodes.rightControl,
								  down: rightControlWentDown,
								  up: rightControlWentUp)

		self.leftOption = .init(key: CGKeyCodes.option,
								down: leftOptionWentDown,
								up: leftOptionWentUp)

		self.rightOption = .init(key: CGKeyCodes.rightOption,
								 down: rightOptionWentDown,
								 up: rightOptionWentUp)

		self.leftCommand = .init(key: CGKeyCodes.command,
								 down: leftCommandWentDown,
								 up: leftCommandWentUp)

		self.rightCommand = .init(key: CGKeyCodes.rightCommand,
								  down: rightCommandWentDown,
								  up: rightCommandWentUp)
	}
}

extension KeyboardModifiers {
	var events: [NSEvent] {
		var evs = [NSEvent]()

		for modifierKey in modifierKeys {
			guard let event = modifierKey.event() else { continue }

			evs.append(event)
		}

		return evs
	}

	var descriptions: [String] {
		var descs = [String]()

		for modifierKey in modifierKeys {
			guard let desc = modifierKey.description else { continue }

			descs.append(desc)
		}

		return descs
	}
}

extension KeyboardModifiers {
	enum ModifierState {
		case none

		case down
		case up

		static func with(down: Bool,
						 up: Bool) -> ModifierState {
			if down && up {
				fatalError("Keyboard Modifier cannot be down and up at the same time")
			} else if down {
				return .down
			} else if up {
				return .up
			} else {
				return .none
			}
		}
	}

	struct ModifierKey {
		let key: CGKeyCode
		let state: ModifierState

		init(key: CGKeyCode,
			 state: ModifierState) {
			self.key = key
			self.state = state
		}

		init(key: CGKeyCode,
			 down: Bool,
			 up: Bool) {
			self.key = key

			self.state = .with(down: down,
							   up: up)
		}

		var description: String? {
			let upOrDown: String

			switch state {
				case .none:
					return nil
				case .down:
					upOrDown = "↓"
				case .up:
					upOrDown = "↑"
			}

			let keyDesc: String

			switch key {
				case CGKeyCodes.shift:
					keyDesc = "L⇧"
				case CGKeyCodes.rightShift:
					keyDesc = "R⇧"

				case CGKeyCodes.control:
					keyDesc = "L⋀"
				case CGKeyCodes.rightControl:
					keyDesc = "R⋀"

				case CGKeyCodes.option:
					keyDesc = "L⌥"
				case CGKeyCodes.rightOption:
					keyDesc = "R⌥"

				case CGKeyCodes.command:
					keyDesc = "L⌘"
				case CGKeyCodes.rightCommand:
					keyDesc = "R⌘"

				default:
					return nil
			}

			let desc = "\(upOrDown) \(keyDesc)"

			return desc
		}

		func event() -> NSEvent? {
			guard state != .none else {
				return nil
			}

			guard let ev = Self.createKeyEventForModifierFlags(keyCode: key,
															   isDown: state == .down) else {
				fatalError("Failed to create NSEvent for modifier flags")
			}

			return ev
		}

		private static func createKeyEventForModifierFlags(keyCode: CGKeyCode,
												   isDown: Bool) -> NSEvent? {
			let eventType: NSEvent.EventType = isDown
				? .keyDown
				: .keyUp

			return NSEvent.keyEvent(with: eventType,
									location: .zero,
									modifierFlags: [ ],
									timestamp: .zero,
									windowNumber: .zero,
									context: nil,
									characters: "",
									charactersIgnoringModifiers: "",
									isARepeat: false,
									keyCode: keyCode)
		}
	}
}
#endif
