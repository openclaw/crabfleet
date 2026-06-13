#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public enum VNCError: Error, LocalizedError {
	case `protocol`(_ underlyingError: ProtocolError)
	case authentication(_ underlyingError: AuthenticationError)
	case connection(_ underlyingError: ConnectionError)

	public var isAuthenticationError: Bool {
		switch self {
			case .authentication:
				return true
			default:
				break
		}

		return false
	}

	public var shouldDisplayToUser: Bool {
		switch self {
			case .connection(let underlyingError):
				switch underlyingError {
					case .cancelled:
						return false
					case .closed:
						return false
					default:
						break
				}
			default:
				break
		}

		return true
	}

	// MARK: - LocalizedError
	public var errorDescription: String? {
		// TODO: Localize
		switch self {
			case .protocol(let underlyingError):
				return Self.combinedErrorDescription("A Protocol error occurred.",
													 underlyingError: underlyingError)

			case .authentication(let underlyingError):
				return Self.combinedErrorDescription("Authentication failed.",
													 underlyingError: underlyingError)

			case .connection(let underlyingError):
				return Self.combinedErrorDescription("The Connection was closed.",
													 underlyingError: underlyingError)
		}
	}
}

extension VNCError {
	static func combinedErrorDescription(_ baseErrorDescription: String,
										 underlyingError: Error?) -> String {
		let underlyingErrorDescription = underlyingError?.humanReadableDescription ?? ""

		guard underlyingErrorDescription != baseErrorDescription else {
			return baseErrorDescription
		}

		let fullDescription = "\(baseErrorDescription)\(underlyingErrorDescription.isEmpty ? "" : " \(underlyingErrorDescription)")"

		return fullDescription
	}
}

#if canImport(ObjectiveC)
@objc(VNCErrorUtils)
// swiftlint:disable:next type_name
public final class _ObjC_VNCErrorUtils: NSObject {
    @objc
	public static func shouldDisplayErrorToUser(_ error: Error) -> Bool {
		guard let vncError = error as? VNCError else {
			return false
		}

		let should = vncError.shouldDisplayToUser

		return should
	}

    @objc
	public static func isAuthenticationError(_ error: Error) -> Bool {
		guard let vncError = error as? VNCError else {
			return false
		}

		switch vncError {
			case .authentication:
				return true
			default:
				return false
		}
	}
}
#endif
