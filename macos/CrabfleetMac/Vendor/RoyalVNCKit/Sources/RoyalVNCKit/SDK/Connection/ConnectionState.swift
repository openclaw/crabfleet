#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public extension VNCConnection {
#if canImport(ObjectiveC)
	@objc(VNCConnectionStatus)
#endif
    @frozen
	enum Status: Int {
		case disconnected
		case connecting
		case connected
		case disconnecting
	}

#if canImport(ObjectiveC)
	@objc(VNCConnectionState)
#endif
    final class ConnectionState: NSObjectOrAnyObject {
#if canImport(ObjectiveC)
		@objc
#endif
		public let status: Status

#if canImport(ObjectiveC)
		@objc
#endif
		public let error: Error?

		static let disconnected: ConnectionState = .init(status: .disconnected,
														 error: nil)

		static let disconnecting: ConnectionState = .init(status: .disconnecting,
														  error: nil)

		static let connecting: ConnectionState = .init(status: .connecting,
													   error: nil)

		static let connected: ConnectionState = .init(status: .connected,
													  error: nil)

		init(status: Status,
			 error: Error?) {
			self.status = status
			self.error = error
		}

		static func disconnected(error: Error) -> ConnectionState {
			.init(status: .disconnected,
				  error: error)
		}
	}
}
