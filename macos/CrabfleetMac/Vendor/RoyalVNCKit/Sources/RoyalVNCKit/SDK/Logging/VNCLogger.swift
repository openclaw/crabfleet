#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCLogger)
#endif
public protocol VNCLogger: AnyObject {
#if canImport(ObjectiveC)
    @objc
#endif
	var isDebugLoggingEnabled: Bool { get set }

#if canImport(ObjectiveC)
    @objc
#endif
	func logDebug(_ message: @autoclosure () -> String)

#if canImport(ObjectiveC)
    @objc
#endif
	func logInfo(_ message: String)

#if canImport(ObjectiveC)
    @objc
#endif
	func logWarning(_ message: String)

#if canImport(ObjectiveC)
    @objc
#endif
	func logError(_ message: String)
}

private struct VNCLoggerConstants {
	static let prefixDebug = "DEBUG"
	static let prefixInfo = "INFO"
	static let prefixWarning = "WARNING"
	static let prefixError = "ERROR"
}

extension VNCLogger {
	func debugMessage(_ message: String) -> String {
		prefixedMessage(message,
						prefix: VNCLoggerConstants.prefixDebug)
	}

	func infoMessage(_ message: String) -> String {
		prefixedMessage(message,
						prefix: VNCLoggerConstants.prefixInfo)
	}

	func warningMessage(_ message: String) -> String {
		prefixedMessage(message,
						prefix: VNCLoggerConstants.prefixWarning)
	}

	func errorMessage(_ message: String) -> String {
		prefixedMessage(message,
						prefix: VNCLoggerConstants.prefixError)
	}

	func prefixedMessage(_ message: String,
						 prefix: String) -> String {
		"\(prefix) - \(message)"
	}
}
