#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

final class VNCLogger_C: VNCLogger {
    fileprivate let context: rvnc_context_t?
    fileprivate let logHandler: rvnc_logger_delegate_log

    var isDebugLoggingEnabled: Bool = false

    fileprivate init(context: rvnc_context_t?,
                     logHandler: rvnc_logger_delegate_log) {
        self.context = context
        self.logHandler = logHandler
    }

    func logDebug(_ message: @autoclosure () -> String) {
        guard isDebugLoggingEnabled else { return }

        log(message(),
            level: RVNC_LOG_LEVEL_DEBUG)
    }

    func logInfo(_ message: String) {
        log(message,
            level: RVNC_LOG_LEVEL_INFO)
    }

    func logWarning(_ message: String) {
        log(message,
            level: RVNC_LOG_LEVEL_WARNING)
    }

    func logError(_ message: String) {
        log(message,
            level: RVNC_LOG_LEVEL_ERROR)
    }

    private func log(_ message: String,
                     level: RVNC_LOG_LEVEL) {
        message.withCString {
            logHandler(self.unretainedPointer(),
                       self.context,
                       level,
                       $0)
        }
    }
}

extension VNCLogger_C {
    func retainedPointer() -> rvnc_logger_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_logger_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_logger_t) {
        pointer.autorelease(VNCLogger_C.self)
    }

    static func fromPointer(_ pointer: rvnc_logger_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_logger_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_logger_create(_ log: rvnc_logger_delegate_log,
                               _ context: rvnc_context_t?) -> rvnc_logger_t {
    let logger = VNCLogger_C(context: context,
                             logHandler: log)

    return logger.retainedPointer()
}

@_cdecl("rvnc_logger_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_logger_destroy(_ logger: rvnc_logger_t) {
    VNCLogger_C.autoreleasePointer(logger)
}
