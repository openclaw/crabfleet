#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCAuthenticationType)
#endif
public enum VNCAuthenticationType: Int, Sendable {
	case vnc
	case appleRemoteDesktop
	case ultraVNCMSLogonII
}

public extension VNCAuthenticationType {
	var requiresUsername: Bool {
		switch self {
			case .vnc:
				false
			case .appleRemoteDesktop:
				true
			case .ultraVNCMSLogonII:
				true
		}
	}

	var requiresPassword: Bool {
		switch self {
			case .vnc:
				true
			case .appleRemoteDesktop:
				true
			case .ultraVNCMSLogonII:
				true
		}
	}
}

#if canImport(ObjectiveC)
@objc(VNCAuthenticationTypeUtils)
// swiftlint:disable:next type_name
public final class _ObjC_VNCAuthenticationTypeUtils: NSObject {
    @objc
	public static func authenticationTypeRequiresUsername(_ authenticationType: VNCAuthenticationType) -> Bool {
		authenticationType.requiresUsername
	}

    @objc
	public static func authenticationTypeRequiresPassword(_ authenticationType: VNCAuthenticationType) -> Bool {
		authenticationType.requiresPassword
	}
}
#endif
