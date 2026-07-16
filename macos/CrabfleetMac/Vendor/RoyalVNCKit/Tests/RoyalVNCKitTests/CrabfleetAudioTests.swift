import Foundation
import Testing

@testable import RoyalVNCKit

struct CrabfleetAudioTests {
	@Test
	func parsesConfigPacketAndStopFrames() async throws {
		let config = try await parse(Data([1, 1, 2, 0, 0, 0xBB, 0x80, 0, 0, 0, 2, 0x11, 0x90]))
		#expect(config == .config(channels: 2, sampleRate: 48_000, magicCookie: Data([0x11, 0x90])))

		let packet = try await parse(Data([2, 0, 0, 0, 0, 0, 42, 0, 0, 0, 2, 0xAA, 0xBB]))
		#expect(packet == .packet(timestampMs: 42, payload: Data([0xAA, 0xBB])))

		#expect(try await parse(Data([3, 0, 0])) == .stop)
	}

	@Test
	func rejectsMalformedAndOversizedFrames() async {
		await #expect(throws: (any Error).self) {
			try await parse(Data([1, 2, 2, 0, 0, 0xBB, 0x80, 0, 0, 0, 0]))
		}
		await #expect(throws: (any Error).self) {
			try await parse(Data([2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]))
		}
		await #expect(throws: (any Error).self) {
			try await parse(Data([3, 0, 1]))
		}

		let oversizedLength = VNCProtocol.CrabfleetAudio.maximumPayloadBytes + 1
		var oversizedConfig = Data([1, 1, 2, 0, 0, 0xBB, 0x80])
		appendBigEndian(oversizedLength, to: &oversizedConfig)
		oversizedConfig.append(Data(count: Int(oversizedLength)))
		await #expect(throws: (any Error).self) { try await parse(oversizedConfig) }

		var oversizedPacket = Data([2, 0, 0, 0, 0, 0, 1])
		appendBigEndian(oversizedLength, to: &oversizedPacket)
		oversizedPacket.append(Data(count: Int(oversizedLength)))
		await #expect(throws: (any Error).self) { try await parse(oversizedPacket) }
	}

	private func parse(_ data: Data) async throws -> VNCAudioMessage {
		try await VNCProtocol.CrabfleetAudio.receive(
			connection: AudioBufferConnection(data)
		).message
	}

	private func appendBigEndian(_ value: UInt32, to data: inout Data) {
		var value = value.bigEndian
		withUnsafeBytes(of: &value) { data.append(contentsOf: $0) }
	}
}

private final class AudioBufferConnection: NetworkConnectionReading {
	private let data: Data
	private var offset = 0

	init(_ data: Data) {
		self.data = data
	}

	func read(minimumLength: Int, maximumLength: Int) async throws -> Data {
		let remaining = data.count - offset
		guard minimumLength > 0, maximumLength >= minimumLength, remaining >= minimumLength else {
			throw VNCError.protocol(.noData)
		}
		let count = min(maximumLength, remaining)
		defer { offset += count }
		return data.subdata(in: offset..<(offset + count))
	}
}
