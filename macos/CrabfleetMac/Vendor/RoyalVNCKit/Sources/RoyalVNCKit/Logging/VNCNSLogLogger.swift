#if !canImport(FoundationEssentials)
import Foundation

/// A logger that writes log messages to the system log using `NSLog`.
public final class VNCNSLogLogger: VNCLogger {
    /// Indicates whether debug-level logging is enabled.
    public var isDebugLoggingEnabled = false

    /// Creates a new instance of `VNCNSLogLogger`.
    public init() { }

    /// Logs a debug message if debug logging is enabled.
    /// - Parameter message: The debug message to log.
    public func logDebug(_ message: @autoclosure () -> String) {
        guard isDebugLoggingEnabled else { return }

        log(debugMessage(message()))
    }

    /// Logs an informational message.
    /// - Parameter message: The info message to log.
    public func logInfo(_ message: String) {
        log(infoMessage(message))
    }

    /// Logs a warning message.
    /// - Parameter message: The warning message to log.
    public func logWarning(_ message: String) {
        log(warningMessage(message))
    }

    /// Logs an error message.
    /// - Parameter message: The error message to log.
    public func logError(_ message: String) {
        log(errorMessage(message))
    }
}

private extension VNCNSLogLogger {
    func log(_ message: String) {
        NSLog(message)
    }
}
#endif
