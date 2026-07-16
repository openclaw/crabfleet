#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

public enum VNCAudioMessage: Equatable, Sendable {
	case config(channels: UInt8, sampleRate: UInt32, magicCookie: Data)
	case packet(timestampMs: UInt32, payload: Data)
	case stop
}

@MainActor
public protocol VNCAudioDelegate: AnyObject {
	func connection(_ connection: VNCConnection, didReceiveAudio message: VNCAudioMessage)
}

extension VNCConnection {
	func notifyAudioDelegateAboutMessage(_ message: VNCAudioMessage) async {
		await MainActor.run { [weak self] in
			guard let self, let delegate = self.audioDelegate else { return }
			delegate.connection(self, didReceiveAudio: message)
		}
	}
}
