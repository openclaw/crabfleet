import AppKit
import Combine
import CryptoKit
import Foundation

@MainActor
protocol ClipboardSessionEndpoint: AnyObject {
  var clipboardEnabled: Bool { get }
  var isClipboardConnected: Bool { get }
  func sendClipboardText(_ text: String) throws
}

@MainActor
final class ClipboardCoordinator: ObservableObject {
  enum State: Equatable {
    case off
    case waiting
    case ready
    case synced
    case remoteAvailable
    case error(String)

    var title: String {
      switch self {
      case .off: "Clipboard off"
      case .waiting: "Clipboard waiting"
      case .ready: "Clipboard ready"
      case .synced: "Clipboard synced"
      case .remoteAvailable: "Remote clipboard available"
      case .error(let message): message
      }
    }
  }

  @Published private(set) var state: State = .off
  @Published private(set) var pendingRemoteTargetIDs: Set<String> = []

  private weak var focusedSession: (any ClipboardSessionEndpoint)?
  private var focusedTargetID: String?
  private let pasteboard: NSPasteboard
  private let pollingInterval: TimeInterval
  private let originType = NSPasteboard.PasteboardType(
    "org.openclaw.crabfleet.clipboard-origin"
  )
  private var timer: Timer?
  private var focusEpoch: UInt64 = 0
  private var originSequence: UInt64 = 0
  private var lastObservedChangeCount: Int
  private var suppressedChangeCount: Int?
  private var lastCoordinatorWriteChangeCount: Int?
  private var candidate: ClipboardCandidate?
  private var remoteTextByTargetID: [String: String] = [:]
  private var outboundGenerationByTargetID: [String: UInt64] = [:]
  private let echoWindow: TimeInterval = 10
  private let maximumRecentOutboundFingerprints = 256
  private var recentOutboundByTargetID: [String: [RecentClipboardFingerprint]] = [:]

  init(
    pasteboard: NSPasteboard = .general,
    pollingInterval: TimeInterval = 0.15
  ) {
    self.pasteboard = pasteboard
    self.pollingInterval = pollingInterval
    self.lastObservedChangeCount = pasteboard.changeCount
  }

  deinit {
    timer?.invalidate()
  }

  func focus(session: (any ClipboardSessionEndpoint)?, targetID: String?) {
    focusEpoch &+= 1
    focusedSession = session
    focusedTargetID = targetID
    candidate = nil
    suppressedChangeCount = nil
    lastCoordinatorWriteChangeCount = nil
    lastObservedChangeCount = pasteboard.changeCount
    reconcileMonitoring()
  }

  func sessionStateDidChange(
    _ session: any ClipboardSessionEndpoint,
    targetID: String
  ) {
    guard targetID == focusedTargetID, focusedSession === session else { return }
    reconcileMonitoring()
  }

  func forget(targetID: String) {
    reset(targetID: targetID)
    if focusedTargetID == targetID {
      focus(session: nil, targetID: nil)
    }
  }

  func reset(targetID: String) {
    remoteTextByTargetID[targetID] = nil
    recentOutboundByTargetID[targetID] = nil
    outboundGenerationByTargetID[targetID] = nil
    pendingRemoteTargetIDs.remove(targetID)
    if focusedTargetID == targetID {
      reconcileMonitoring()
    }
  }

  func receiveRemoteText(_ text: String, from targetID: String) {
    let now = Date()
    let recent = (recentOutboundByTargetID[targetID] ?? []).filter {
      now.timeIntervalSince($0.sentAt) < echoWindow
    }
    let fingerprint = ClipboardFingerprint(text: text)
    if let echoIndex = recent.firstIndex(where: { $0.fingerprint == fingerprint }) {
      var remaining = recent
      let echo = remaining.remove(at: echoIndex)
      recentOutboundByTargetID[targetID] = remaining
      receiveOutboundEcho(text, echo: echo, from: targetID)
      return
    }
    recentOutboundByTargetID[targetID] = recent

    remoteTextByTargetID[targetID] = text

    guard targetID == focusedTargetID,
      let focusedSession,
      focusedSession.clipboardEnabled,
      focusedSession.isClipboardConnected
    else {
      pendingRemoteTargetIDs.insert(targetID)
      return
    }

    applyRemoteText(text, from: targetID)
  }

  func sendCurrentClipboard() {
    guard let snapshot = stablePasteboardSnapshot() else {
      state = .error("Clipboard changed while reading; try again")
      return
    }
    lastObservedChangeCount = snapshot.changeCount
    candidate = nil
    send(snapshot.text, pasteboardChangeCount: snapshot.changeCount)
  }

  func applyRemoteClipboard(for targetID: String) {
    guard let text = remoteTextByTargetID[targetID] else {
      state = .error("No remote clipboard text yet")
      return
    }
    applyRemoteText(text, from: targetID)
  }

  func hasRemoteClipboard(for targetID: String) -> Bool {
    remoteTextByTargetID[targetID] != nil
  }

  func hasPendingRemoteClipboard(for targetID: String) -> Bool {
    pendingRemoteTargetIDs.contains(targetID)
  }

  private func reconcileMonitoring() {
    let shouldMonitor = focusedSession?.clipboardEnabled == true
      && focusedSession?.isClipboardConnected == true

    guard shouldMonitor else {
      stopMonitoring()
      state = focusedSession?.clipboardEnabled == true ? .waiting : .off
      return
    }

    if timer == nil {
      let timer = Timer.scheduledTimer(
        withTimeInterval: pollingInterval,
        repeats: true
      ) { [weak self] _ in
        MainActor.assumeIsolated {
          self?.pollPasteboard()
        }
      }
      timer.tolerance = pollingInterval * 0.2
      self.timer = timer
    }

    if let focusedTargetID, pendingRemoteTargetIDs.contains(focusedTargetID) {
      state = .remoteAvailable
    } else {
      state = .ready
    }
  }

  private func stopMonitoring() {
    timer?.invalidate()
    timer = nil
    candidate = nil
  }

  private func pollPasteboard() {
    guard focusedSession?.clipboardEnabled == true,
      focusedSession?.isClipboardConnected == true
    else {
      reconcileMonitoring()
      return
    }

    guard let snapshot = stablePasteboardSnapshot() else {
      candidate = nil
      return
    }
    let changeCount = snapshot.changeCount
    if suppressedChangeCount == changeCount {
      suppressedChangeCount = nil
      lastObservedChangeCount = changeCount
      candidate = nil
      return
    }

    guard changeCount != lastObservedChangeCount else { return }
    if changeCount != lastCoordinatorWriteChangeCount {
      lastCoordinatorWriteChangeCount = nil
    }
    let text = snapshot.text

    if candidate?.changeCount == changeCount, candidate?.text == text {
      lastObservedChangeCount = changeCount
      candidate = nil
      send(text, pasteboardChangeCount: changeCount)
    } else {
      candidate = ClipboardCandidate(changeCount: changeCount, text: text)
    }
  }

  private func send(_ text: String, pasteboardChangeCount: Int) {
    guard let targetID = focusedTargetID, let focusedSession else {
      state = .off
      return
    }

    do {
      try focusedSession.sendClipboardText(text)
      let generation = (outboundGenerationByTargetID[targetID] ?? 0) &+ 1
      outboundGenerationByTargetID[targetID] = generation
      var recent = recentOutboundByTargetID[targetID] ?? []
      recent.append(
        RecentClipboardFingerprint(
          fingerprint: ClipboardFingerprint(text: text),
          generation: generation,
          pasteboardChangeCount: pasteboardChangeCount,
          sentAt: .now
        )
      )
      recentOutboundByTargetID[targetID] = Array(
        recent.suffix(maximumRecentOutboundFingerprints)
      )
      remoteTextByTargetID[targetID] = text
      pendingRemoteTargetIDs.remove(targetID)
      state = .synced
    } catch {
      state = .error(error.localizedDescription)
    }
  }

  private func receiveOutboundEcho(
    _ text: String,
    echo: RecentClipboardFingerprint,
    from targetID: String
  ) {
    remoteTextByTargetID[targetID] = text

    guard outboundGenerationByTargetID[targetID] == echo.generation else {
      pendingRemoteTargetIDs.insert(targetID)
      if targetID == focusedTargetID {
        state = .remoteAvailable
      }
      return
    }

    pendingRemoteTargetIDs.remove(targetID)
    guard targetID == focusedTargetID,
      let focusedSession,
      focusedSession.clipboardEnabled,
      focusedSession.isClipboardConnected
    else {
      return
    }

    let currentChangeCount = pasteboard.changeCount
    guard currentChangeCount == echo.pasteboardChangeCount
      || currentChangeCount == lastCoordinatorWriteChangeCount
    else {
      pendingRemoteTargetIDs.insert(targetID)
      state = .remoteAvailable
      return
    }
    applyRemoteText(text, from: targetID)
  }

  private func applyRemoteText(_ text: String, from targetID: String) {
    guard let snapshot = stablePasteboardSnapshot() else {
      pendingRemoteTargetIDs.insert(targetID)
      state = .remoteAvailable
      return
    }

    if snapshot.text == text {
      lastObservedChangeCount = snapshot.changeCount
      pendingRemoteTargetIDs.remove(targetID)
      state = .synced
      return
    }

    originSequence &+= 1
    let origin = "\(focusEpoch):\(originSequence)"
    let item = NSPasteboardItem()
    let preparedText = item.setString(text, forType: .string)
    let preparedOrigin = item.setString(origin, forType: originType)
    guard preparedText, preparedOrigin else {
      state = .error("Could not prepare the Mac clipboard")
      return
    }

    pasteboard.clearContents()
    guard pasteboard.writeObjects([item]) else {
      state = .error("Could not update the Mac clipboard")
      return
    }

    guard let written = stablePasteboardSnapshot(),
      written.text == text,
      written.origin == origin
    else {
      pendingRemoteTargetIDs.insert(targetID)
      state = .remoteAvailable
      return
    }

    let changeCount = written.changeCount
    suppressedChangeCount = changeCount
    lastCoordinatorWriteChangeCount = changeCount
    lastObservedChangeCount = changeCount
    candidate = nil
    pendingRemoteTargetIDs.remove(targetID)
    state = .synced
  }

  private func stablePasteboardSnapshot() -> PasteboardSnapshot? {
    for _ in 0..<3 {
      let before = pasteboard.changeCount
      let text = pasteboard.string(forType: .string) ?? ""
      let origin = pasteboard.string(forType: originType)
      let after = pasteboard.changeCount
      if before == after {
        return PasteboardSnapshot(changeCount: after, text: text, origin: origin)
      }
    }
    return nil
  }
}

private struct ClipboardCandidate {
  let changeCount: Int
  let text: String
}

private struct PasteboardSnapshot {
  let changeCount: Int
  let text: String
  let origin: String?
}

private struct RecentClipboardFingerprint {
  let fingerprint: ClipboardFingerprint
  let generation: UInt64
  let pasteboardChangeCount: Int
  let sentAt: Date
}

private struct ClipboardFingerprint: Equatable {
  private let digest: SHA256.Digest

  init(text: String) {
    digest = SHA256.hash(data: Data(text.utf8))
  }
}
