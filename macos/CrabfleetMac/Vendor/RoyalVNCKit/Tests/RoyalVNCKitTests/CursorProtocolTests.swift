import Foundation
import Testing
#if os(macOS)
import AppKit
#endif

@testable import RoyalVNCKit

struct CursorProtocolTests {
	#if os(macOS)
	@Test @MainActor
	func scalesFocusedSystemCursorWithFramebuffer() {
		let cursor = VNCCursor(
			imageData: Data(repeating: 0xFF, count: 4 * 4 * 4),
			size: VNCSize(width: 4, height: 4),
			hotspot: VNCPoint(x: 3, y: 3),
			bitsPerComponent: 8,
			bitsPerPixel: 32,
			bytesPerPixel: 4,
			isPremultiplied: true)

		let scaled = cursor.nsCursor(scale: 0.5)
		#expect(scaled.image.size == CGSize(width: 2, height: 2))
		#expect(scaled.hotSpot == CGPoint(x: 1.5, y: 1.5))
	}
	#endif

	@Test
	func advertisesAlphaBeforeClassicAndPointerPosition() throws {
		let connection = VNCConnection(settings: VNCConnection.Settings(
			isDebugLoggingEnabled: false,
			hostname: "127.0.0.1",
			port: 5900,
			isShared: true,
			isScalingEnabled: true,
			useDisplayLink: false,
			inputMode: .none,
			isClipboardRedirectionEnabled: false,
			colorDepth: .depth24Bit,
			frameEncodings: [.raw]))
		let encodings = try connection.orderedEncodingTypes()
		let alpha = try #require(encodings.firstIndex(of: VNCPseudoEncodingType.cursorWithAlpha.rawValue))
		let classic = try #require(encodings.firstIndex(of: VNCPseudoEncodingType.cursor.rawValue))
		let pointer = try #require(encodings.firstIndex(of: VNCPseudoEncodingType.pointerPosition.rawValue))

		#expect(alpha < classic)
		#expect(classic < pointer)
	}

	@Test
	func parsesHostCursorWithAlphaFixture() async throws {
		let fixture = Data([
			0, 0, 0, 1,
			0, 1, 0, 0, 0, 2, 0, 1, 0xFF, 0xFF, 0xFE, 0xC6,
			0, 0, 0, 0,
			0x11, 0x22, 0x33, 0xFF, 0x20, 0x10, 0x08, 0x80,
		])
		let result = try await parse(fixture)

		#expect(result.cursor?.imageData == Data([
			0x11, 0x22, 0x33, 0xFF, 0x20, 0x10, 0x08, 0x80,
		]))
		#expect(result.cursor?.hotspot == VNCPoint(x: 1, y: 0))
		#expect(result.cursor?.size == VNCSize(width: 2, height: 1))
	}

	@Test
	func parsesHostClassicCursorFixture() async throws {
		let fixture = Data([
			0, 0, 0, 1,
			0, 1, 0, 0, 0, 2, 0, 1, 0xFF, 0xFF, 0xFF, 0x11,
			0x33, 0x22, 0x11, 0,
			0x10, 0x20, 0x40, 0,
			0xC0,
		])
		let result = try await parse(fixture)

		#expect(result.cursor?.imageData == Data([
			0x11, 0x22, 0x33, 0xFF, 0x40, 0x20, 0x10, 0xFF,
		]))
		#expect(result.cursor?.hotspot == VNCPoint(x: 1, y: 0))
	}

	@Test
	func parsesHostPointerPositionFixture() async throws {
		let fixture = Data([
			0, 0, 0, 1,
			0, 1, 0, 0, 0, 0, 0, 0, 0xFF, 0xFF, 0xFF, 0x18,
		])
		let result = try await parse(fixture)

		#expect(result.pointerPosition == VNCPoint(x: 1, y: 0))
	}

	@Test
	func rejectsMalformedCursorRectangles() async {
		let oversizedAlpha = Data([
			0, 0, 0, 1,
			0, 0, 0, 0, 0, 129, 0, 1, 0xFF, 0xFF, 0xFE, 0xC6,
			0, 0, 0, 0,
		])
		await #expect(throws: (any Error).self) { try await parse(oversizedAlpha) }

		let malformedPointer = Data([
			0, 0, 0, 1,
			0, 1, 0, 0, 0, 1, 0, 0, 0xFF, 0xFF, 0xFF, 0x18,
		])
		await #expect(throws: (any Error).self) { try await parse(malformedPointer) }
	}

	private func parse(_ fixture: Data) async throws -> CursorFramebufferDelegate {
		let framebuffer = try VNCFramebuffer(
			logger: VNCPrintLogger(),
			size: VNCSize(width: 2, height: 1),
			screens: [],
			pixelFormat: VNCProtocol.PixelFormat(depth: 24),
			allocator: VNCFramebufferMallocAllocator())
		let delegate = CursorFramebufferDelegate()
		framebuffer.delegate = delegate
		let encodings: Encodings = [
			VNCPseudoEncodingType.cursorWithAlpha.rawValue: VNCProtocol.CursorWithAlphaEncoding(),
			VNCPseudoEncodingType.cursor.rawValue: VNCProtocol.CursorEncoding(),
			VNCPseudoEncodingType.pointerPosition.rawValue: VNCProtocol.PointerPositionEncoding(),
		]
		_ = try await VNCProtocol.FramebufferUpdate.receive(
			connection: CursorBufferConnection(Data(fixture.dropFirst())),
			framebuffer: framebuffer,
			encodings: encodings,
			logger: VNCPrintLogger())
		return delegate
	}
}

private final class CursorFramebufferDelegate: VNCFramebufferDelegate {
	var cursor: VNCCursor?
	var pointerPosition: VNCPoint?

	func framebuffer(_ framebuffer: VNCFramebuffer, didUpdateRegion updatedRegion: VNCRegion) {}
	func framebuffer(_ framebuffer: VNCFramebuffer, didUpdateDesktopName newDesktopName: String) {}
	func framebuffer(_ framebuffer: VNCFramebuffer, didUpdateCursor cursor: VNCCursor) {
		self.cursor = cursor
	}
	func framebuffer(_ framebuffer: VNCFramebuffer, didUpdatePointerPosition position: VNCPoint) {
		pointerPosition = position
	}
	func framebuffer(
		_ framebuffer: VNCFramebuffer,
		sizeDidChange newSize: VNCSize,
		screens newScreens: [VNCScreen]
	) {}
}

private final class CursorBufferConnection: NetworkConnectionReading {
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
