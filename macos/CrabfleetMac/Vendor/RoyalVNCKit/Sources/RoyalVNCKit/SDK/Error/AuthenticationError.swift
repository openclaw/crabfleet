#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCError {
	enum AuthenticationError: Error, LocalizedError {
		case serverOfferedNoAuthTypes(reason: String?)
		case clientCouldNotDecideOnSecurityType
		case securityHandshakingFailed(reason: String?)
		case noAuthenticationDataProvided
		case ardAuthenticationFailed
		case ultraVNCMSLogonIIAuthenticationFailed
		case encryptionFailed

		// MARK: - LocalizedError
		public var errorDescription: String? {
			// TODO: Localize
			switch self {
				case .serverOfferedNoAuthTypes(let reason):
					return combinedErrorDescription("The Server offered no authentication types.",
													reason: reason)
				case .clientCouldNotDecideOnSecurityType:
					return "The Client could not decide on a Security Type."
				case .securityHandshakingFailed(let reason):
					return combinedErrorDescription("Security handshaking failed.",
													reason: reason)
				case .noAuthenticationDataProvided:
					return "No authentication data was provided."
				case .ardAuthenticationFailed:
					return "Apple Remote Desktop authentication failed."
				case .ultraVNCMSLogonIIAuthenticationFailed:
					return "UltraVNC MS-Logon II authentication failed."
				case .encryptionFailed:
					return "Encryption failed."
			}
		}
	}
}

private extension VNCError.AuthenticationError {
	func combinedErrorDescription(_ baseErrorDescription: String,
								  reason: String?) -> String {
		let unwrappedReason: String

		if let reason = reason {
			unwrappedReason = reason
		} else {
			unwrappedReason = ""
		}

		return "\(baseErrorDescription)\(unwrappedReason.isEmpty ? "" : " Reason provided by the Server: \(unwrappedReason)")"
	}
}
