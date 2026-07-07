import AppKit
import Foundation
import Testing

@testable import CrabfleetMac

struct HostShareWireTests {
  @Test
  func extendedDesktopSizeUpdateEncodesOneScreen() throws {
    let update = try RFBWire.extendedDesktopSizeUpdate(
      reason: 1,
      status: 0,
      width: 1_280,
      height: 720
    )

    #expect(
      update == Data([
        0, 0,  // FramebufferUpdate + padding
        0, 1,  // one rectangle
        0, 1,  // x = reason (client-requested)
        0, 0,  // y = status (no error)
        0x05, 0x00,  // width 1280
        0x02, 0xD0,  // height 720
        0xFF, 0xFF, 0xFE, 0xCC,  // ExtendedDesktopSize (-308)
        1, 0, 0, 0,  // one screen + padding
        0, 0, 0, 1,  // screen id
        0, 0, 0, 0,  // position
        0x05, 0x00, 0x02, 0xD0,  // screen size
        0, 0, 0, 0,  // flags
      ])
    )
  }

  @Test
  func extendedDesktopSizeUpdateRejectsInvalidDimensions() {
    #expect(throws: (any Error).self) {
      _ = try RFBWire.extendedDesktopSizeUpdate(reason: 0, status: 0, width: 0, height: 720)
    }
    #expect(throws: (any Error).self) {
      _ = try RFBWire.extendedDesktopSizeUpdate(reason: 0, status: 0, width: 70_000, height: 720)
    }
  }

  @Test
  func legacyServerCutTextRequiresLatin1() {
    let encoded = RFBWire.legacyServerCutText(text: "héllo")

    #expect(
      encoded == Data([3, 0, 0, 0, 0, 0, 0, 5]) + Data([0x68, 0xE9, 0x6C, 0x6C, 0x6F])
    )
    #expect(RFBWire.legacyServerCutText(text: "emoji 🦀") == nil)
  }

  @Test
  func resizedDimensionsAspectFitTheSourceIntoTheRequest() {
    // Exact aspect match scales cleanly.
    let exact = MacScreenCapture.resizedDimensions(
      requestedWidth: 1_280,
      requestedHeight: 800,
      sourcePixelWidth: 2_880,
      sourcePixelHeight: 1_800
    )
    #expect(exact.width == 1_280)
    #expect(exact.height == 800)

    // Requests beyond the native pixel size never upscale.
    let capped = MacScreenCapture.resizedDimensions(
      requestedWidth: 5_000,
      requestedHeight: 5_000,
      sourcePixelWidth: 1_600,
      sourcePixelHeight: 1_000
    )
    #expect(capped.width == 1_600)
    #expect(capped.height == 1_000)

    // Tiny requests clamp to the 320×240 floor, aspect-fit within it.
    let floored = MacScreenCapture.resizedDimensions(
      requestedWidth: 100,
      requestedHeight: 100,
      sourcePixelWidth: 2_880,
      sourcePixelHeight: 1_800
    )
    #expect(floored.width == 320)
    #expect(floored.height == 200)

    let h264 = MacScreenCapture.resizedDimensions(
      requestedWidth: 4_096,
      requestedHeight: 2_304,
      sourcePixelWidth: 5_120,
      sourcePixelHeight: 2_880,
      maximumWidth: 4_096,
      maximumHeight: 2_304
    )
    #expect(h264.width == 4_096)
    #expect(h264.height == 2_304)
  }
}

@MainActor
struct HostClipboardBridgeTests {
  @Test
  func baselinesExistingClipboardAndPushesOnlyNewLocalChanges() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("pre-existing", forType: .string)

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }

    try await Task.sleep(for: .milliseconds(60))
    #expect(recorder.values.isEmpty)

    pasteboard.clearContents()
    pasteboard.setString("host copy", forType: .string)
    try await waitUntil { recorder.values == ["host copy"] }
    #expect(bridge.currentText() == "host copy")

    bridge.detach()
  }

  @Test
  func clientTextLandsOnPasteboardWithoutEchoingBack() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()

    let recorder = PushRecorder()
    let bridge = HostClipboardBridge(pasteboard: pasteboard, pollingInterval: 0.01)
    bridge.attach { recorder.append($0) }
    try await Task.sleep(for: .milliseconds(30))

    bridge.receiveClientText("from client")
    try await waitUntil { pasteboard.string(forType: .string) == "from client" }
    #expect(bridge.currentText() == "from client")

    // Several poll cycles must not bounce the client's own text back.
    try await Task.sleep(for: .milliseconds(80))
    #expect(recorder.values.isEmpty)

    // A genuinely new local copy still goes out.
    pasteboard.clearContents()
    pasteboard.setString("newer host copy", forType: .string)
    try await waitUntil { recorder.values == ["newer host copy"] }

    bridge.detach()
  }

  private func waitUntil(
    timeout: Duration = .seconds(1),
    condition: @escaping @MainActor () -> Bool
  ) async throws {
    let clock = ContinuousClock()
    let deadline = clock.now.advanced(by: timeout)
    while clock.now < deadline {
      if condition() { return }
      try await Task.sleep(for: .milliseconds(10))
    }
    #expect(condition())
  }
}

@MainActor
struct ClipboardDirectionTests {
  @Test
  func sendOnlyKeepsRemoteTextOffTheMacPasteboard() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("local", forType: .string)

    let defaults = try ephemeralDefaults()
    let coordinator = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    coordinator.direction = .sendOnly

    let session = DirectionEndpointRecorder()
    coordinator.focus(session: session, targetID: "target")
    try await Task.sleep(for: .milliseconds(30))

    coordinator.receiveRemoteText("remote secret", from: "target")
    #expect(pasteboard.string(forType: .string) == "local")
    #expect(coordinator.hasPendingRemoteClipboard(for: "target"))
    #expect(coordinator.state == .remoteAvailable)

    // The explicit recovery action still applies remote text deliberately.
    coordinator.applyRemoteClipboard(for: "target")
    #expect(pasteboard.string(forType: .string) == "remote secret")
  }

  @Test
  func receiveOnlyNeverAutoSendsLocalChanges() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()

    let defaults = try ephemeralDefaults()
    let coordinator = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    coordinator.direction = .receiveOnly

    let session = DirectionEndpointRecorder()
    coordinator.focus(session: session, targetID: "target")
    try await Task.sleep(for: .milliseconds(30))

    pasteboard.clearContents()
    pasteboard.setString("local change", forType: .string)
    try await Task.sleep(for: .milliseconds(100))
    #expect(session.sentTexts.isEmpty)

    // The explicit toolbar action still sends deliberately.
    coordinator.sendCurrentClipboard()
    #expect(session.sentTexts == ["local change"])
  }

  @Test
  func directionPersistsThroughDefaults() throws {
    let defaults = try ephemeralDefaults()
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))

    let first = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    #expect(first.direction == .bidirectional)
    first.direction = .receiveOnly

    let second = ClipboardCoordinator(
      pasteboard: pasteboard,
      pollingInterval: 0.01,
      defaults: defaults
    )
    #expect(second.direction == .receiveOnly)
  }

  private func ephemeralDefaults() throws -> UserDefaults {
    let suiteName = "CrabfleetMacTests.\(UUID().uuidString)"
    let defaults = try #require(UserDefaults(suiteName: suiteName))
    defaults.removePersistentDomain(forName: suiteName)
    return defaults
  }
}

private final class PushRecorder: @unchecked Sendable {
  private let lock = NSLock()
  private var storage = [String]()

  var values: [String] {
    lock.lock()
    defer { lock.unlock() }
    return storage
  }

  func append(_ value: String) {
    lock.lock()
    storage.append(value)
    lock.unlock()
  }
}

private final class DirectionEndpointRecorder: ClipboardSessionEndpoint {
  var clipboardEnabled = true
  var isClipboardConnected = true
  var sentTexts = [String]()

  func sendClipboardText(_ text: String) throws {
    sentTexts.append(text)
  }
}
