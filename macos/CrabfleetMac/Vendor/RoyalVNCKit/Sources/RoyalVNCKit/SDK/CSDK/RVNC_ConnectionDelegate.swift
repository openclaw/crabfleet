#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension VNCConnectionDelegate_C {
    func retainedPointer() -> rvnc_connection_delegate_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_connection_delegate_t {
        .unretainedPointerFrom(self)
    }

    static func fromPointer(_ pointer: rvnc_connection_delegate_t) -> Self {
        pointer.unretainedInstance()
    }

    static func autoreleasePointer(_ pointer: rvnc_connection_delegate_t) {
        pointer.autorelease(VNCConnectionDelegate_C.self)
    }
}

@_cdecl("rvnc_connection_delegate_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_delegate_create(
    _ connectionStateDidChange: rvnc_connection_delegate_connection_state_did_change,
    _ authenticate: rvnc_connection_delegate_authenticate,
    _ didCreateFramebuffer: rvnc_connection_delegate_did_create_framebuffer,
    _ didResizeFramebuffer: rvnc_connection_delegate_did_resize_framebuffer,
    _ didUpdateFramebuffer: rvnc_connection_delegate_did_update_framebuffer,
    _ didUpdateCursor: rvnc_connection_delegate_did_update_cursor
) -> rvnc_connection_delegate_t {
    let delegate = VNCConnectionDelegate_C(
        connectionStateDidChange: connectionStateDidChange,
        authenticate: authenticate,
        didCreateFramebuffer: didCreateFramebuffer,
        didResizeFramebuffer: didResizeFramebuffer,
        didUpdateFramebuffer: didUpdateFramebuffer,
        didUpdateCursor: didUpdateCursor
    )

    return delegate.retainedPointer()
}

@_cdecl("rvnc_connection_delegate_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_delegate_destroy(_ connectionDelegate: rvnc_connection_delegate_t) {
    VNCConnectionDelegate_C.autoreleasePointer(connectionDelegate)
}

final class VNCConnectionDelegate_C {
    let connectionStateDidChange: rvnc_connection_delegate_connection_state_did_change
    let authenticate: rvnc_connection_delegate_authenticate
    let didCreateFramebuffer: rvnc_connection_delegate_did_create_framebuffer
    let didResizeFramebuffer: rvnc_connection_delegate_did_resize_framebuffer
    let didUpdateFramebuffer: rvnc_connection_delegate_did_update_framebuffer
    let didUpdateCursor: rvnc_connection_delegate_did_update_cursor

    init(
        connectionStateDidChange: rvnc_connection_delegate_connection_state_did_change,
        authenticate: rvnc_connection_delegate_authenticate,
        didCreateFramebuffer: rvnc_connection_delegate_did_create_framebuffer,
        didResizeFramebuffer: rvnc_connection_delegate_did_resize_framebuffer,
        didUpdateFramebuffer: rvnc_connection_delegate_did_update_framebuffer,
        didUpdateCursor: rvnc_connection_delegate_did_update_cursor
    ) {
        self.connectionStateDidChange = connectionStateDidChange
        self.authenticate = authenticate
        self.didCreateFramebuffer = didCreateFramebuffer
        self.didResizeFramebuffer = didResizeFramebuffer
        self.didUpdateFramebuffer = didUpdateFramebuffer
        self.didUpdateCursor = didUpdateCursor
    }
}

extension VNCConnectionDelegate_C: VNCConnectionDelegate {
    func connection(_ connection: VNCConnection,
                    stateDidChange connectionState: VNCConnection.ConnectionState) {
        self.connectionStateDidChange(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            connectionState.unretainedPointer()
        )
    }

    func connection(_ connection: VNCConnection,
                    credentialFor authenticationType: VNCAuthenticationType,
                    completion: @escaping ((any VNCCredential)?) -> Void) {
        let authRequest = VNCAuthenticationRequest_C(authenticationType: authenticationType,
                                                     completionHandler: completion)

        let authRequestC = authRequest.retainedPointer()

        self.authenticate(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            authRequestC
        )
    }

    func connection(_ connection: VNCConnection,
                    didCreateFramebuffer framebuffer: VNCFramebuffer) {
        self.didCreateFramebuffer(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            framebuffer.unretainedPointer()
        )
    }

    func connection(_ connection: VNCConnection,
                    didResizeFramebuffer framebuffer: VNCFramebuffer) {
        self.didResizeFramebuffer(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            framebuffer.unretainedPointer()
        )
    }

    func connection(_ connection: VNCConnection,
                    didUpdateFramebuffer framebuffer: VNCFramebuffer,
                    x: UInt16, y: UInt16,
                    width: UInt16, height: UInt16) {
        self.didUpdateFramebuffer(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            framebuffer.unretainedPointer(),
            x,
            y,
            width,
            height
        )
    }

    func connection(_ connection: VNCConnection,
                    didUpdateCursor cursor: VNCCursor) {
        self.didUpdateCursor(
            connection.unretainedPointer(),
            .init(OpaquePointer(connection.context)),
            cursor.unretainedPointer()
        )
    }
}
