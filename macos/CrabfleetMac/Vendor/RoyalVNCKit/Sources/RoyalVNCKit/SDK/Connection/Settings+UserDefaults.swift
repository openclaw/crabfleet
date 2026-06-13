#if !os(Linux) && !os(Windows) && !os(Android)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCConnection.Settings {
#if canImport(ObjectiveC)
	@objc
#endif
	func saveToUserDefaults() {
		Self.standardUserDefaultsStorage.save(settings: self)
	}

#if canImport(ObjectiveC)
	@objc
#endif
	static func fromUserDefaults() -> VNCConnection.Settings {
		standardUserDefaultsStorage.load()
	}

#if canImport(ObjectiveC)
	@objc
#endif
	var cachedUsername: String {
		get {
			Self.credentialsKeychain.username(forHostname: hostname,
											  port: port)
		}
		set {
			Self.credentialsKeychain.setUsername(newValue,
												 forHostname: hostname,
												 port: port)
		}
	}

#if canImport(ObjectiveC)
	@objc
#endif
	var cachedPassword: String {
		get {
			Self.credentialsKeychain.password(forHostname: hostname,
											  port: port)
		}
		set {
			Self.credentialsKeychain.setPassword(newValue,
												 forHostname: hostname,
												 port: port)
		}
	}
}

private extension VNCConnection.Settings {
	static var standardUserDefaultsStorage = UserDefaultsStorage(defaults: .standard)
	static var credentialsKeychain = CredentialsKeychain()

    final class UserDefaultsStorage {
		let defaults: UserDefaults

		private let isDebugLoggingEnabledKey = "isDebugLoggingEnabled"
		private let hostnameKey = "hostname"
		private let portKey = "port"
		private let isSharedKey = "isShared"
		private let isScalingEnabledKey = "isScalingEnabled"
		private let useDisplayLinkKey = "useDisplayLink"
		private let inputModeKey = "inputMode"
		private let isClipboardRedirectionEnabledKey = "isClipboardRedirectionEnabled"
		private let colorDepthKey = "colorDepth"
		private let frameEncodingsKey = "frameEncodings"

		init(defaults: UserDefaults) {
			self.defaults = defaults

			registerDefaults()
		}

		func registerDefaults() {
			defaults.register(defaults: [
				isDebugLoggingEnabledKey: false,
				hostnameKey: "",
				portKey: 5900,
				isSharedKey: true,
				isScalingEnabledKey: false,
				useDisplayLinkKey: false,
				inputModeKey: InputMode.forwardKeyboardShortcutsIfNotInUseLocally.rawValue,
				isClipboardRedirectionEnabledKey: true,
				colorDepthKey: ColorDepth.depth24Bit.rawValue,
				frameEncodingsKey: VNCFrameEncodingType.defaultFrameEncodings.encode()
			])
		}

		var isDebugLoggingEnabled: Bool {
			get { defaults.bool(forKey: isDebugLoggingEnabledKey) }
			set { defaults.set(newValue, forKey: isDebugLoggingEnabledKey) }
		}

		var hostname: String {
			get { defaults.string(forKey: hostnameKey) ?? "" }
			set { defaults.set(newValue, forKey: hostnameKey) }
		}

		var port: UInt16 {
			get { .init(defaults.integer(forKey: portKey)) }
			set { defaults.set(newValue, forKey: portKey) }
		}

		var isShared: Bool {
			get { defaults.bool(forKey: isSharedKey) }
			set { defaults.set(newValue, forKey: isSharedKey) }
		}

		var isScalingEnabled: Bool {
			get { defaults.bool(forKey: isScalingEnabledKey) }
			set { defaults.set(newValue, forKey: isScalingEnabledKey) }
		}

		var useDisplayLink: Bool {
			get { defaults.bool(forKey: useDisplayLinkKey) }
			set { defaults.set(newValue, forKey: useDisplayLinkKey) }
		}

		var inputMode: InputMode {
			get { .init(rawValue: .init(defaults.integer(forKey: inputModeKey))) ?? .forwardKeyboardShortcutsIfNotInUseLocally }
			set { defaults.set(newValue.rawValue, forKey: inputModeKey) }
		}

		var isClipboardRedirectionEnabled: Bool {
			get { defaults.bool(forKey: isClipboardRedirectionEnabledKey) }
			set { defaults.set(newValue, forKey: isClipboardRedirectionEnabledKey) }
		}

		var frameEncodings: [VNCFrameEncodingType] {
			get {
				guard let encodedValue = defaults.stringArray(forKey: frameEncodingsKey) else {
					return VNCFrameEncodingType.defaultFrameEncodings
				}

				let encs = [VNCFrameEncodingType].decode(encodedValue)

				return encs
			}
			set {
				let encodedValue = newValue.encode()

				defaults.set(encodedValue, forKey: frameEncodingsKey)
			}
		}

		var colorDepth: ColorDepth {
			get { .init(rawValue: .init(defaults.integer(forKey: colorDepthKey))) ?? .depth24Bit }
			set { defaults.set(newValue.rawValue, forKey: colorDepthKey) }
		}

		func save(settings: VNCConnection.Settings) {
			isDebugLoggingEnabled = settings.isDebugLoggingEnabled
			hostname = settings.hostname
			port = settings.port
			isShared = settings.isShared
			isScalingEnabled = settings.isScalingEnabled
			useDisplayLink = settings.useDisplayLink
			inputMode = settings.inputMode
			isClipboardRedirectionEnabled = settings.isClipboardRedirectionEnabled
			colorDepth = settings.colorDepth
			frameEncodings = settings.frameEncodings
		}

		func load() -> VNCConnection.Settings {
			.init(isDebugLoggingEnabled: isDebugLoggingEnabled,
				  hostname: hostname,
				  port: port,
				  isShared: isShared,
				  isScalingEnabled: isScalingEnabled,
				  useDisplayLink: useDisplayLink,
				  inputMode: inputMode,
				  isClipboardRedirectionEnabled: isClipboardRedirectionEnabled,
				  colorDepth: colorDepth,
				  frameEncodings: frameEncodings)
		}
	}
}
#endif
