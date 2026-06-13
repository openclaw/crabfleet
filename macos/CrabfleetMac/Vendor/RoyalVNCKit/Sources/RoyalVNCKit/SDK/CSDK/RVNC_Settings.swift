#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

@_implementationOnly import RoyalVNCKitC

extension RVNC_INPUTMODE {
    var swiftInputMode: VNCConnection.Settings.InputMode {
        switch self {
            case RVNC_INPUTMODE_NONE:
                .none
            case RVNC_INPUTMODE_FORWARDKEYBOARDSHORTCUTSIFNOTINUSELOCALLY:
                .forwardKeyboardShortcutsIfNotInUseLocally
            case RVNC_INPUTMODE_FORWARDKEYBOARDSHORTCUTSEVENIFINUSELOCALLY:
                .forwardKeyboardShortcutsEvenIfInUseLocally
            case RVNC_INPUTMODE_FORWARDALLKEYBOARDSHORTCUTSANDHOTKEYS:
                .forwardAllKeyboardShortcutsAndHotKeys
            default:
                fatalError("Invalid input mode: \(self)")
        }
    }
}

extension RVNC_COLORDEPTH {
    var swiftColorDepth: VNCConnection.Settings.ColorDepth {
        switch self {
            case RVNC_COLORDEPTH_8BIT:
                .depth8Bit
            case RVNC_COLORDEPTH_16BIT:
                .depth16Bit
            case RVNC_COLORDEPTH_24BIT:
                .depth24Bit
            default:
                fatalError("Invalid color depth: \(self)")
        }
    }
}

extension VNCConnection.Settings {
    func retainedPointer() -> rvnc_settings_t {
        .retainedPointerFrom(self)
    }

    func unretainedPointer() -> rvnc_settings_t {
        .unretainedPointerFrom(self)
    }

    static func autoreleasePointer(_ pointer: rvnc_settings_t) {
        pointer.autorelease(VNCConnection.Settings.self)
    }

    static func fromPointer(_ pointer: rvnc_settings_t) -> Self {
        pointer.unretainedInstance()
    }
}

@_cdecl("rvnc_settings_create")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_settings_create(_ isDebugLoggingEnabled: Bool,
                                 _ hostname: UnsafePointer<CChar>,
                                 _ port: UInt16,
                                 _ isShared: Bool,
                                 _ isScalingEnabled: Bool,
                                 _ useDisplayLink: Bool,
                                 _ inputMode: RVNC_INPUTMODE,
                                 _ isClipboardRedirectionEnabled: Bool,
                                 _ colorDepth: RVNC_COLORDEPTH,
                                 _ frameEncodings: rvnc_frame_encodings_t?) -> rvnc_settings_t {
    let hostnameStr = String(cString: hostname)

    let inputModeSwift = inputMode.swiftInputMode
    let colorDepthSwift = colorDepth.swiftColorDepth
    let frameEncodingsSwift: [VNCFrameEncodingType]

    if let frameEncodings {
        frameEncodingsSwift = VNCFrameEncodings_C.fromPointer(frameEncodings)
            .frameEncodings
    } else {
        frameEncodingsSwift = .default
    }

    let settings = VNCConnection.Settings(isDebugLoggingEnabled: isDebugLoggingEnabled,
                                          hostname: hostnameStr,
                                          port: port,
                                          isShared: isShared,
                                          isScalingEnabled: isScalingEnabled,
                                          useDisplayLink: useDisplayLink,
                                          inputMode: inputModeSwift,
                                          isClipboardRedirectionEnabled: isClipboardRedirectionEnabled,
                                          colorDepth: colorDepthSwift,
                                          frameEncodings: frameEncodingsSwift)

    return settings.retainedPointer()
}

@_cdecl("rvnc_settings_destroy")
@_spi(RoyalVNCKitC)
@available(*, unavailable)
public func rvnc_settings_destroy(_ settings: rvnc_settings_t) {
    VNCConnection.Settings.autoreleasePointer(settings)
}
