import AppKit
import Testing

@testable import CrabfleetMac

@MainActor
struct ClipboardCoordinatorTests {
  @Test
  func stabilizesFocusedClipboardAndQuarantinesBackgroundRemoteText() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("existing secret", forType: .string)

    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let first = ClipboardEndpointRecorder()
    let second = ClipboardEndpointRecorder()

    coordinator.focus(session: first, targetID: "first")
    try await Task.sleep(for: .milliseconds(50))
    #expect(first.sentTexts.isEmpty)

    pasteboard.clearContents()
    pasteboard.setString("local change", forType: .string)
    try await waitUntil { first.sentTexts == ["local change"] }

    coordinator.receiveRemoteText("local change", from: "first")
    #expect(pasteboard.string(forType: .string) == "local change")

    coordinator.receiveRemoteText("background remote", from: "second")
    #expect(coordinator.hasPendingRemoteClipboard(for: "second"))
    #expect(pasteboard.string(forType: .string) == "local change")

    coordinator.focus(session: second, targetID: "second")
    #expect(coordinator.state == .remoteAvailable)
    #expect(pasteboard.string(forType: .string) == "local change")

    coordinator.applyRemoteClipboard(for: "second")
    #expect(pasteboard.string(forType: .string) == "background remote")
    #expect(!coordinator.hasPendingRemoteClipboard(for: "second"))
    try await Task.sleep(for: .milliseconds(50))
    #expect(second.sentTexts.isEmpty)

    coordinator.receiveRemoteText("focused remote", from: "second")
    #expect(pasteboard.string(forType: .string) == "focused remote")
    try await Task.sleep(for: .milliseconds(50))
    #expect(second.sentTexts.isEmpty)
  }

  @Test
  func coalescesRapidLocalClipboardChanges() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")

    for value in ["one", "two", "three"] {
      pasteboard.clearContents()
      pasteboard.setString(value, forType: .string)
      try await Task.sleep(for: .milliseconds(3))
    }

    try await waitUntil { endpoint.sentTexts == ["three"] }
  }

  @Test
  func delayedEchoesDoNotRegressRemoteClipboardHistory() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")

    pasteboard.clearContents()
    pasteboard.setString("A", forType: .string)
    try await waitUntil { endpoint.sentTexts == ["A"] }
    pasteboard.clearContents()
    pasteboard.setString("B", forType: .string)
    try await waitUntil { endpoint.sentTexts == ["A", "B"] }

    coordinator.receiveRemoteText("A", from: "focused")
    coordinator.receiveRemoteText("B", from: "focused")
    coordinator.applyRemoteClipboard(for: "focused")

    #expect(pasteboard.string(forType: .string) == "B")
    #expect(!coordinator.hasPendingRemoteClipboard(for: "focused"))
  }

  @Test
  func propagatesClipboardClearAfterStabilization() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")

    pasteboard.clearContents()
    pasteboard.setString("secret", forType: .string)
    try await waitUntil { endpoint.sentTexts == ["secret"] }

    pasteboard.clearContents()
    try await waitUntil { endpoint.sentTexts == ["secret", ""] }
  }

  @Test
  func deliberateLocalChangeSupersedesPendingRemoteClipboard() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()

    coordinator.receiveRemoteText("background X", from: "focused")
    coordinator.focus(session: endpoint, targetID: "focused")
    #expect(coordinator.hasPendingRemoteClipboard(for: "focused"))

    pasteboard.clearContents()
    pasteboard.setString("local B", forType: .string)
    try await waitUntil { endpoint.sentTexts == ["local B"] }
    coordinator.receiveRemoteText("local B", from: "focused")

    #expect(!coordinator.hasPendingRemoteClipboard(for: "focused"))
    coordinator.applyRemoteClipboard(for: "focused")
    #expect(pasteboard.string(forType: .string) == "local B")
  }

  @Test
  func suppressesMoreThanEightDelayedClipboardEchoes() {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")

    let values = (0..<12).map { "clipboard-\($0)" }
    for value in values {
      pasteboard.clearContents()
      pasteboard.setString(value, forType: .string)
      coordinator.sendCurrentClipboard()
    }
    for value in values {
      coordinator.receiveRemoteText(value, from: "focused")
    }

    coordinator.applyRemoteClipboard(for: "focused")
    #expect(endpoint.sentTexts == values)
    #expect(pasteboard.string(forType: .string) == values.last)
  }

  @Test
  func latestEchoRestoresAuthoritativeRemoteClipboard() {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("local B", forType: .string)
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")
    coordinator.sendCurrentClipboard()

    coordinator.receiveRemoteText("remote X", from: "focused")
    #expect(pasteboard.string(forType: .string) == "remote X")
    coordinator.receiveRemoteText("local B", from: "focused")

    #expect(pasteboard.string(forType: .string) == "local B")
    #expect(!coordinator.hasPendingRemoteClipboard(for: "focused"))
    coordinator.applyRemoteClipboard(for: "focused")
    #expect(pasteboard.string(forType: .string) == "local B")
  }

  @Test
  func consumesEchoBeforeAcceptingLegitimateRemoteReuse() {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("A", forType: .string)
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")
    coordinator.sendCurrentClipboard()

    coordinator.receiveRemoteText("A", from: "focused")
    coordinator.receiveRemoteText("remote X", from: "focused")
    coordinator.receiveRemoteText("A", from: "focused")

    #expect(pasteboard.string(forType: .string) == "A")
    #expect(coordinator.hasRemoteClipboard(for: "focused"))
  }

  @Test
  func latestEchoDoesNotEraseNewerUnsentLocalChange() async throws {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("local B", forType: .string)
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 0.01)
    let endpoint = ClipboardEndpointRecorder()
    coordinator.focus(session: endpoint, targetID: "focused")
    coordinator.sendCurrentClipboard()

    pasteboard.clearContents()
    pasteboard.setString("new local C", forType: .string)
    coordinator.receiveRemoteText("local B", from: "focused")

    #expect(pasteboard.string(forType: .string) == "new local C")
    try await waitUntil { endpoint.sentTexts == ["local B", "new local C"] }
    #expect(!coordinator.hasPendingRemoteClipboard(for: "focused"))
  }

  @Test
  func sendUsesOriginalPasteboardVersionWhenAnotherCopyArrivesMidSend() {
    let pasteboard = NSPasteboard(name: .init("CrabfleetMacTests.\(UUID().uuidString)"))
    pasteboard.clearContents()
    pasteboard.setString("C", forType: .string)
    let coordinator = ClipboardCoordinator(pasteboard: pasteboard, pollingInterval: 10)
    let endpoint = ClipboardEndpointRecorder()
    endpoint.onSend = { text in
      guard text == "C" else { return }
      pasteboard.clearContents()
      pasteboard.setString("newer D", forType: .string)
    }
    coordinator.focus(session: endpoint, targetID: "focused")

    coordinator.sendCurrentClipboard()
    coordinator.receiveRemoteText("C", from: "focused")

    #expect(endpoint.sentTexts == ["C"])
    #expect(pasteboard.string(forType: .string) == "newer D")
    #expect(coordinator.hasPendingRemoteClipboard(for: "focused"))
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
private final class ClipboardEndpointRecorder: ClipboardSessionEndpoint {
  var clipboardEnabled = true
  var isClipboardConnected = true
  var sentTexts = [String]()
  var onSend: ((String) -> Void)?

  func sendClipboardText(_ text: String) throws {
    sentTexts.append(text)
    onSend?(text)
  }
}
