#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension VNCConnection {
    func retainedPointer() -> rvnc_connection_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_connection_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_connection_t) {
        pointer.autorelease(VNCConnection.self)
    }

    static func fromPointer(_ pointer: rvnc_connection_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_connection_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_create(_ settings: rvnc_settings_t,
                                   _ logger: rvnc_logger_t?,
                                   _ framebufferAllocator: rvnc_framebuffer_allocator_t?,
                                   _ context: rvnc_context_t?) -> rvnc_connection_t {
    let loggerSwift: VNCLogger_C?

    if let logger {
        loggerSwift = VNCLogger_C.fromPointer(logger)
    } else {
        loggerSwift = nil
    }

    let framebufferAllocatorSwift: VNCFramebufferAllocator_C?

    if let framebufferAllocator {
        framebufferAllocatorSwift = VNCFramebufferAllocator_C.fromPointer(framebufferAllocator)
    } else {
        framebufferAllocatorSwift = nil
    }

    let settingsSwift = VNCConnection.Settings.fromPointer(settings)

    let connection: VNCConnection

    if let loggerSwift {
        connection = VNCConnection(settings: settingsSwift,
                                   logger: loggerSwift,
                                   framebufferAllocator: framebufferAllocatorSwift,
                                   context: context)
    } else {
        connection = VNCConnection(settings: settingsSwift,
                                   framebufferAllocator: framebufferAllocatorSwift,
                                   context: context)
    }

    return connection.retainedPointer()
}

@_cdecl("rvnc_connection_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_destroy(_ connection: rvnc_connection_t) {
    VNCConnection.autoreleasePointer(connection)
}

@_cdecl("rvnc_connection_connect")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_connect(_ connection: rvnc_connection_t) {
    VNCConnection.fromPointer(connection)
        .connect()
}

@_cdecl("rvnc_connection_disconnect")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_disconnect(_ connection: rvnc_connection_t) {
    VNCConnection.fromPointer(connection)
        .disconnect()
}

@_cdecl("rvnc_connection_update_color_depth")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_update_color_depth(_ connection: rvnc_connection_t,
                                               _ colorDepth: RVNC_COLORDEPTH) {
    let colorDepthSwift = colorDepth.swiftColorDepth

    VNCConnection.fromPointer(connection)
        .updateColorDepth(colorDepthSwift)
}

@_cdecl("rvnc_connection_delegate_set")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_delegate_set(_ connection: rvnc_connection_t,
                                         _ connectionDelegate: rvnc_connection_delegate_t?) {
    let connectionSwift = VNCConnection.fromPointer(connection)
    let connectionDelegateSwift: VNCConnectionDelegate?

    if let connectionDelegate {
        connectionDelegateSwift = VNCConnectionDelegate_C.fromPointer(connectionDelegate)
    } else {
        connectionDelegateSwift = nil
    }

    connectionSwift.delegate = connectionDelegateSwift
}

@_cdecl("rvnc_connection_context_get")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_context_get(_ connection: rvnc_connection_t) -> rvnc_context_t? {
    let connectionSwift = VNCConnection.fromPointer(connection)
    let context = connectionSwift.context

    return context
}

@_cdecl("rvnc_connection_state_get_copy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_state_get_copy(_ connection: rvnc_connection_t) -> rvnc_connection_state_t {
    let connectionSwift = VNCConnection.fromPointer(connection)
    let connectionState = connectionSwift.connectionState
    let connectionStateC = connectionState.retainedPointer()

    return connectionStateC
}

@_cdecl("rvnc_connection_settings_get_copy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_settings_get_copy(_ connection: rvnc_connection_t) -> rvnc_settings_t {
    let connectionSwift = VNCConnection.fromPointer(connection)
    let connectionSettings = connectionSwift.settings
    let connectionSettingsC = connectionSettings.retainedPointer()

    return connectionSettingsC
}

// MARK: - Mouse Input
@_cdecl("rvnc_connection_mouse_move")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_mouse_move(_ connection: rvnc_connection_t, _ x: UInt16, _ y: UInt16) {
    VNCConnection.fromPointer(connection)
        .mouseMove(x: x, y: y)
}

@_cdecl("rvnc_connection_mouse_down")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_mouse_down(_ connection: rvnc_connection_t, _ button: RVNC_MOUSEBUTTON, _ x: UInt16, _ y: UInt16) {
    VNCConnection.fromPointer(connection)
        .mouseButtonDown(button.swiftVNCMouseButton, x: x, y: y)
}

@_cdecl("rvnc_connection_mouse_up")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_mouse_up(_ connection: rvnc_connection_t, _ button: RVNC_MOUSEBUTTON, _ x: UInt16, _ y: UInt16) {
    VNCConnection.fromPointer(connection)
        .mouseButtonUp(button.swiftVNCMouseButton, x: x, y: y)
}

@_cdecl("rvnc_connection_mouse_wheel")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_mouse_wheel(_ connection: rvnc_connection_t, _ wheel: RVNC_MOUSEWHEEL, _ x: UInt16, _ y: UInt16, _ steps: UInt32) {
    VNCConnection.fromPointer(connection)
        .mouseWheel(wheel.swiftVNCMouseWheel, x: x, y: y, steps: steps)
}

// MARK: - Keyboard Input
@_cdecl("rvnc_connection_key_down")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_key_down(_ connection: rvnc_connection_t, _ key: UInt32) {
    VNCConnection.fromPointer(connection)
        .keyDown(.init(key))
}

@_cdecl("rvnc_connection_key_up")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_connection_key_up(_ connection: rvnc_connection_t, _ key: UInt32) {
    VNCConnection.fromPointer(connection)
        .keyUp(.init(key))
}
