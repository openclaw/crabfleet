#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

/// A customizable logger implementation conforming to `VNCLogger`.
/// Allows clients to provide their own handlers for debug, info, warning, and error messages.
#if canImport(ObjectiveC)
@objc(VNCCustomLogger)
#endif
public final class VNCCustomLogger: NSObjectOrAnyObject, VNCLogger {
    /// A closure type that handles a log message.
    /// - Parameter message: The log message to handle.
    public typealias LogHandler = (_ message: String) -> Void

    /// Handler for debug-level log messages.
    public let logDebugHandler: LogHandler

    /// Handler for info-level log messages.
    public let logInfoHandler: LogHandler

    /// Handler for warning-level log messages.
    public let logWarningHandler: LogHandler

    /// Handler for error-level log messages.
    public let logErrorHandler: LogHandler

    /// Indicates whether debug-level logging is enabled.
    public var isDebugLoggingEnabled = false

    /// Creates a new custom logger with the specified log handlers.
    /// - Parameters:
    ///   - logDebugHandler: Handler for debug messages.
    ///   - logInfoHandler: Handler for info messages.
    ///   - logWarningHandler: Handler for warning messages.
    ///   - logErrorHandler: Handler for error messages.
#if canImport(ObjectiveC)
    @objc(initWithLogDebugHandler:logInfoHandler:logWarningHandler:logErrorHandler:)
#endif
    public init(logDebugHandler: @escaping LogHandler,
                logInfoHandler: @escaping LogHandler,
                logWarningHandler: @escaping LogHandler,
                logErrorHandler: @escaping LogHandler) {
        self.logDebugHandler = logDebugHandler
        self.logInfoHandler = logInfoHandler
        self.logWarningHandler = logWarningHandler
        self.logErrorHandler = logErrorHandler
    }

    /// Logs a debug message if debug logging is enabled.
    /// - Parameter message: The debug message to log.
    public func logDebug(_ message: @autoclosure () -> String) {
        guard isDebugLoggingEnabled else { return }

        logDebugHandler(message())
    }

    /// Logs an informational message.
    /// - Parameter message: The info message to log.
    public func logInfo(_ message: String) {
        logInfoHandler(message)
    }

    /// Logs a warning message.
    /// - Parameter message: The warning message to log.
    public func logWarning(_ message: String) {
        logWarningHandler(message)
    }

    /// Logs an error message.
    /// - Parameter message: The error message to log.
    public func logError(_ message: String) {
        logErrorHandler(message)
    }
}
