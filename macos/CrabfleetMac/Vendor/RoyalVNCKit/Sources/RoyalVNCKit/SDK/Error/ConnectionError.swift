#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCError {
	enum ConnectionError: Error, LocalizedError {
		case notReady
		case closed
		case closedDuringHandshake(handshakingPhase: String, underlyingError: Error?)
		case cancelled
		case failed(_ underlyingError: Error?)

		// MARK: - LocalizedError
		public var errorDescription: String? {
			// TODO: Localize
			switch self {
				case .notReady:
					return "The Connection is not ready."
				case .closed:
					return "The Connection was closed."
				case .closedDuringHandshake(let handshakingPhase, let underlyingError):
					return VNCError.combinedErrorDescription("The Connection was closed during the \"\(handshakingPhase)\" handshaking phase.",
															 underlyingError: underlyingError)
				case .cancelled:
					return "The Connection was cancelled."
				case .failed(let underlyingError):
					return VNCError.combinedErrorDescription("The Connection failed.",
															 underlyingError: underlyingError)
			}
		}
	}
}
