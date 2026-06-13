#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCConnection {
#if canImport(ObjectiveC)
	@objc(VNCConnectionSettings)
#endif
    final class Settings: NSObjectOrAnyObject {
#if canImport(ObjectiveC)
		@objc
#endif
		public let isDebugLoggingEnabled: Bool

#if canImport(ObjectiveC)
		@objc
#endif
		public let hostname: String

#if canImport(ObjectiveC)
		@objc
#endif
		public let port: UInt16

#if canImport(ObjectiveC)
		@objc
#endif
		public let isShared: Bool

#if canImport(ObjectiveC)
		@objc
#endif
		public let isScalingEnabled: Bool

#if canImport(ObjectiveC)
		@objc
#endif
		public let useDisplayLink: Bool

#if canImport(ObjectiveC)
		@objc
#endif
		public let inputMode: InputMode

#if canImport(ObjectiveC)
		@objc
#endif
		public var isClipboardRedirectionEnabled: Bool {
			clipboardMode != .disabled
		}

#if canImport(ObjectiveC)
		@objc
#endif
		public let clipboardMode: ClipboardMode

#if canImport(ObjectiveC)
		@objc
#endif
		public let colorDepth: ColorDepth

		public let frameEncodings: [VNCFrameEncodingType]

#if canImport(ObjectiveC)
		@objc(frameEncodings)
#endif
		public var _objc_frameEncodings: [Int64] {
			frameEncodings.map({ $0.rawValue.rawValue })
		}

		public convenience init(isDebugLoggingEnabled: Bool,
					hostname: String,
					port: UInt16,
					isShared: Bool,
					isScalingEnabled: Bool,
					useDisplayLink: Bool,
					inputMode: InputMode,
					isClipboardRedirectionEnabled: Bool,
					colorDepth: ColorDepth,
					frameEncodings: [VNCFrameEncodingType]) {
			self.init(isDebugLoggingEnabled: isDebugLoggingEnabled,
					  hostname: hostname,
					  port: port,
					  isShared: isShared,
					  isScalingEnabled: isScalingEnabled,
					  useDisplayLink: useDisplayLink,
					  inputMode: inputMode,
					  clipboardMode: isClipboardRedirectionEnabled ? .systemPasteboard : .disabled,
					  colorDepth: colorDepth,
					  frameEncodings: frameEncodings)
		}

		public init(isDebugLoggingEnabled: Bool,
					hostname: String,
					port: UInt16,
					isShared: Bool,
					isScalingEnabled: Bool,
					useDisplayLink: Bool,
					inputMode: InputMode,
					clipboardMode: ClipboardMode,
					colorDepth: ColorDepth,
					frameEncodings: [VNCFrameEncodingType]) {
			self.isDebugLoggingEnabled = isDebugLoggingEnabled

			self.hostname = hostname
			self.port = port

			self.isShared = isShared

			self.isScalingEnabled = isScalingEnabled
			self.useDisplayLink = useDisplayLink

			self.inputMode = inputMode

			self.clipboardMode = clipboardMode

			self.colorDepth = colorDepth
			self.frameEncodings = frameEncodings
		}

#if canImport(ObjectiveC)
		@objc
#endif
		public convenience init(isDebugLoggingEnabled: Bool,
								hostname: String,
								port: UInt16,
								isShared: Bool,
								isScalingEnabled: Bool,
								useDisplayLink: Bool,
								inputMode: InputMode,
								isClipboardRedirectionEnabled: Bool,
								colorDepth: ColorDepth,
								frameEncodings: [Int64]) {
			let frameEncodingsSwift: [VNCFrameEncodingType] = frameEncodings.compactMap({
				guard let objcFrameEncodingType = _ObjC_VNCFrameEncodingType(rawValue: $0) else { return nil }

				return VNCFrameEncodingType.fromObjCFrameEncodingType(objcFrameEncodingType)
			})

			self.init(isDebugLoggingEnabled: isDebugLoggingEnabled,
					  hostname: hostname,
					  port: port,
					  isShared: isShared,
					  isScalingEnabled: isScalingEnabled,
					  useDisplayLink: useDisplayLink,
					  inputMode: inputMode,
					  isClipboardRedirectionEnabled: isClipboardRedirectionEnabled,
					  colorDepth: colorDepth,
					  frameEncodings: frameEncodingsSwift)
		}
	}
}

public extension VNCConnection.Settings {
#if canImport(ObjectiveC)
	@objc(VNCInputMode)
#endif
	enum InputMode: UInt32 {
		case none

		case forwardKeyboardShortcutsIfNotInUseLocally
		case forwardKeyboardShortcutsEvenIfInUseLocally
		case forwardAllKeyboardShortcutsAndHotKeys
	}

#if canImport(ObjectiveC)
	@objc(VNCColorDepth)
#endif
	enum ColorDepth: UInt8 {
		case depth8Bit = 8   // 256 Colors
		case depth16Bit = 16
		case depth24Bit = 24
	}

#if canImport(ObjectiveC)
	@objc(VNCClipboardMode)
#endif
	enum ClipboardMode: UInt8 {
		case disabled
		case systemPasteboard
		case externallyManaged
	}
}

#if os(macOS)
public extension VNCConnection.Settings.InputMode {
	var requiresAccessibilityPermissions: Bool {
		self == .forwardAllKeyboardShortcutsAndHotKeys
	}
}

#if canImport(ObjectiveC)
@objc(VNCInputModeUtils)
#endif
// swiftlint:disable:next type_name
public final class _ObjC_VNCInputModeUtils: NSObject {
#if canImport(ObjectiveC)
	@objc
#endif
	public static func inputModeRequiresAccessibilityPermissions(_ inputMode: VNCConnection.Settings.InputMode) -> Bool {
		inputMode.requiresAccessibilityPermissions
	}
}
#endif
