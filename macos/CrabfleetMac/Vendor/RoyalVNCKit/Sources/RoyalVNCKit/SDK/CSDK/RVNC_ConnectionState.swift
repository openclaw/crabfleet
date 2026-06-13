#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension VNCConnection.Status {
    var cConnectionStatus: RVNC_CONNECTION_STATUS {
        switch self {
            case .disconnected:
                RVNC_CONNECTION_STATUS_DISCONNECTED
            case .connecting:
                RVNC_CONNECTION_STATUS_CONNECTING
            case .connected:
                RVNC_CONNECTION_STATUS_CONNECTED
            case .disconnecting:
                RVNC_CONNECTION_STATUS_DISCONNECTING
        }
    }
}

extension VNCConnection.ConnectionState {
    func retainedPointer() -> rvnc_connection_state_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_connection_state_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_connection_state_t) {
        pointer.autorelease(VNCConnection.ConnectionState.self)
    }

    static func fromPointer(_ pointer: rvnc_connection_state_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_connection_state_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_destroy(_ connectionState: rvnc_connection_state_t) {
    VNCConnection.ConnectionState.autoreleasePointer(connectionState)
}

@_cdecl("rvnc_connection_state_status_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_status_get(_ connectionState: rvnc_connection_state_t) -> RVNC_CONNECTION_STATUS {
    let connectionStateSwift = VNCConnection.ConnectionState.fromPointer(connectionState)
    let status = connectionStateSwift.status
    let cStatus = status.cConnectionStatus

    return cStatus
}

@_cdecl("rvnc_connection_state_error_description_get_copy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_error_description_get_copy(_ connectionState: rvnc_connection_state_t) -> UnsafeMutablePointer<CChar>? {
    let connectionStateSwift = VNCConnection.ConnectionState.fromPointer(connectionState)
    let error = connectionStateSwift.error

    guard let error else {
        return nil
    }

    let errorDescription = error.humanReadableDescription
    let errorDescriptionC = errorDescription.duplicateCString()

    return errorDescriptionC
}

@_cdecl("rvnc_connection_state_error_should_display_to_user_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_error_should_display_to_user_get(_ connectionState: rvnc_connection_state_t) -> Bool {
    let connectionStateSwift = VNCConnection.ConnectionState.fromPointer(connectionState)
    let error = connectionStateSwift.error

    guard let vncError = error as? VNCError else {
        return false
    }

    return vncError.shouldDisplayToUser
}

@_cdecl("rvnc_connection_state_error_is_authentication_error_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_error_is_authentication_error_get(_ connectionState: rvnc_connection_state_t) -> Bool {
    let connectionStateSwift = VNCConnection.ConnectionState.fromPointer(connectionState)
    let error = connectionStateSwift.error

    guard let vncError = error as? VNCError else {
        return false
    }

    return vncError.isAuthenticationError
}
