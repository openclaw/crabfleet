#if canImport(OSLog)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import OSLog

/// A logger that uses Apple's `OSLog` framework to emit structured log messages.
public final class VNCOSLogLogger: VNCLogger {
    /// Indicates whether debug-level log messages should be emitted.
    public var isDebugLoggingEnabled = false

    private let logger = Logger.main

    /// Creates a new `VNCOSLogLogger` instance.
    public init() { }

    /// Logs a debug-level message if debug logging is enabled.
    /// - Parameter message: The debug message to log.
    public func logDebug(_ message: @autoclosure () -> String) {
        guard isDebugLoggingEnabled else { return }

        let actualMessage = message()

        logger.info("\(actualMessage)")
    }

    /// Logs an informational message.
    /// - Parameter message: The info message to log.
    public func logInfo(_ message: String) {
        logger.notice("\(message)")
    }

    /// Logs a warning message.
    /// - Parameter message: The warning message to log.
    public func logWarning(_ message: String) {
        logger.warning("\(message)")
    }

    /// Logs an error message.
    /// - Parameter message: The error message to log.
    public func logError(_ message: String) {
        logger.error("\(message)")
    }
}

fileprivate extension Logger {
    private class ClassToGetBundle { }

    private static let bundle = Bundle(for: ClassToGetBundle.self)

    private static let subsystem = bundle.bundleIdentifier ?? "RoyalVNC"
    private static let category = bundle.infoDictionary?["CFBundleName"] as? String ?? "RoyalVNCKit"

    static let main = Logger(subsystem: subsystem, category: category)
}
#endif
