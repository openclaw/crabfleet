// swiftlint:disable line_length

#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ExtendedDesktopSizeEncoding: VNCReceivablePseudoEncoding {
		let encodingType = VNCPseudoEncodingType.extendedDesktopSize.rawValue
	}
}

extension VNCProtocol.ExtendedDesktopSizeEncoding {
	enum Reason: UInt16 {
		/// The screen layout was changed via non-RFB means on the server. For example the server may have provided means for server-side applications to manipulate the screen layout. This code is also used when the client sends a non-incremental FrameBufferUpdateRequest to learn the server's current state.
		case changedViaNonRFBMeans = 0

		/// The client receiving this message requested a change of the screen layout. The change may or may not have happened depending on server policy or available resources. The status code in the y-position field must be used to determine which.
		case changedBecauseClientRequestedIt = 1

		/// Another client requested a change of the screen layout and the server approved it. A rectangle with this code is never sent if the server denied the request.
		case changedBecauseAnotherClientRequestedIt = 2
	}

	enum UserRequestedChangeStatus: UInt16 {
		case noError = 0
		case resizeIsAdministrativelyProhibited = 1
		case outOfResources = 2
		case invalidScreenLayout = 3
		case requestForwardedMightCompleteAsyncronously = 4
	}
}

extension VNCProtocol.ExtendedDesktopSizeEncoding {
	func receive(_ rectangle: VNCProtocol.Rectangle,
				 framebuffer: VNCFramebuffer,
				 connection: NetworkConnectionReading,
				 logger: VNCLogger) async throws {
		let reasonNum = rectangle.xPosition
		let userRequestedChangeStatusNum = rectangle.yPosition

		// If reason is nil, it indicates a server-side change
		_ = Reason(rawValue: reasonNum)
		_ = UserRequestedChangeStatus(rawValue: userRequestedChangeStatusNum)

		let newSize = rectangle.region.size

		let numberOfScreens = try await connection.readUInt8()
		try await connection.readPadding(length: 3)

		var screens = [VNCProtocol.Screen]()

		for _ in 0..<numberOfScreens {
			let screen = try await VNCProtocol.Screen.receive(connection: connection)

			screens.append(screen)
		}

		framebuffer.resize(to: newSize,
						   screens: screens)
	}
}

// swiftlint:enable line_length
