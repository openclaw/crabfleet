#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCConnection {
    final class State {
		private let lock = NSLock()

		private var _disconnectRequested = false
		private var _serverProtocolVersion: VNCProtocol.ProtocolVersion?
		private var _agreedProtocolVersion: VNCProtocol.ProtocolVersion?
		private var _isTightSecurityEnabled = false
		private var _framebufferWidth: UInt16 = 0
		private var _framebufferHeight: UInt16 = 0
		private var _serverPixelFormat: VNCProtocol.PixelFormat?
		private var _pixelFormat: VNCProtocol.PixelFormat?
		private var _desktopName: String?
		private var _incrementalUpdatesEnabled = false
		private var _areFencesSupported = false
		private var _areContinuousUpdatesSupported = false
		private var _areContinuousUpdatesEnabled = false
		private var _extendedClipboardServerCaps: VNCExtendedClipboardCaps?
		private var _lastExtendedClipboardText: String?

		var disconnectRequested: Bool { withLock { _disconnectRequested } }

		var serverProtocolVersion: VNCProtocol.ProtocolVersion? {
			get { withLock { _serverProtocolVersion } }
			set { withLock { _serverProtocolVersion = newValue } }
		}

		var agreedProtocolVersion: VNCProtocol.ProtocolVersion? {
			get { withLock { _agreedProtocolVersion } }
			set { withLock { _agreedProtocolVersion = newValue } }
		}

		var isTightSecurityEnabled: Bool {
			get { withLock { _isTightSecurityEnabled } }
			set { withLock { _isTightSecurityEnabled = newValue } }
		}

		var framebufferWidth: UInt16 {
			get { withLock { _framebufferWidth } }
			set { withLock { _framebufferWidth = newValue } }
		}

		var framebufferHeight: UInt16 {
			get { withLock { _framebufferHeight } }
			set { withLock { _framebufferHeight = newValue } }
		}

		var serverPixelFormat: VNCProtocol.PixelFormat? {
			get { withLock { _serverPixelFormat } }
			set { withLock { _serverPixelFormat = newValue } }
		}

		var pixelFormat: VNCProtocol.PixelFormat? {
			get { withLock { _pixelFormat } }
			set { withLock { _pixelFormat = newValue } }
		}

		var desktopName: String? {
			get { withLock { _desktopName } }
			set { withLock { _desktopName = newValue } }
		}

		var incrementalUpdatesEnabled: Bool {
			get { withLock { _incrementalUpdatesEnabled } }
			set { withLock { _incrementalUpdatesEnabled = newValue } }
		}

		var areFencesSupported: Bool {
			get { withLock { _areFencesSupported } }
			set { withLock { _areFencesSupported = newValue } }
		}

		var areContinuousUpdatesSupported: Bool {
			get { withLock { _areContinuousUpdatesSupported } }
			set { withLock { _areContinuousUpdatesSupported = newValue } }
		}

		var areContinuousUpdatesEnabled: Bool {
			get { withLock { _areContinuousUpdatesEnabled } }
			set { withLock { _areContinuousUpdatesEnabled = newValue } }
		}

		var extendedClipboardServerCaps: VNCExtendedClipboardCaps? {
			get { withLock { _extendedClipboardServerCaps } }
			set { withLock { _extendedClipboardServerCaps = newValue } }
		}

		var lastExtendedClipboardText: String? {
			get { withLock { _lastExtendedClipboardText } }
			set { withLock { _lastExtendedClipboardText = newValue } }
		}

		func requestDisconnect() -> Bool {
			withLock {
				guard !_disconnectRequested else { return false }
				_disconnectRequested = true
				return true
			}
		}

		private func withLock<T>(_ operation: () -> T) -> T {
			lock.lock()
			defer { lock.unlock() }
			return operation()
		}
	}
}

extension VNCConnection.State {
	var isAppleRemoteDesktop: Bool {
		return serverProtocolVersion?.isAppleRemoteDesktop ?? false
	}
}
