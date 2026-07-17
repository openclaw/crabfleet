import AppKit
import Foundation

/// Synchronizes the host Mac's pasteboard with the connected RFB viewer while
/// Share This Mac runs. The RFB session pulls snapshots and delivers client
/// text from its background task; all pasteboard access happens on the main
/// queue.
protocol HostClipboardSyncing: AnyObject, Sendable {
  /// Starts monitoring and forwards host pasteboard changes to `pusher`.
  /// The current pasteboard content is baselined, not pushed.
  func attach(id: UUID, pusher: @escaping @Sendable (String) -> Void)
  func detach(id: UUID)
  func detachAll()

  /// Applies clipboard text received from the connected viewer.
  func receiveClientText(id: UUID, text: String)

  /// Most recent host pasteboard text observed by the monitor.
  func currentText() -> String?
}

final class HostClipboardBridge: HostClipboardSyncing, @unchecked Sendable {
  private let pasteboard: NSPasteboard
  private let pollingInterval: TimeInterval
  private let lock = NSLock()
  private let legacyPusherID = UUID()
  private var pushers: [UUID: @Sendable (String) -> Void] = [:]
  private var timer: Timer?
  private var lastObservedChangeCount: Int?
  private var suppressedChangeCount: Int?
  private var lastKnownText: String?

  init(
    pasteboard: NSPasteboard = .general,
    pollingInterval: TimeInterval = 0.5
  ) {
    self.pasteboard = pasteboard
    self.pollingInterval = pollingInterval
  }

  deinit {
    timer?.invalidate()
  }

  func attach(id: UUID, pusher: @escaping @Sendable (String) -> Void) {
    let shouldStart = withLock { () -> Bool in
      let wasEmpty = pushers.isEmpty
      pushers[id] = pusher
      return wasEmpty
    }
    guard shouldStart else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.withLock {
        self.lastObservedChangeCount = self.pasteboard.changeCount
        self.suppressedChangeCount = nil
        self.lastKnownText = self.pasteboard.string(forType: .string)
      }
      guard self.timer == nil else { return }
      let timer = Timer.scheduledTimer(
        withTimeInterval: self.pollingInterval,
        repeats: true
      ) { [weak self] _ in
        self?.poll()
      }
      timer.tolerance = self.pollingInterval * 0.2
      self.timer = timer
    }
  }

  func attach(pusher: @escaping @Sendable (String) -> Void) {
    attach(id: legacyPusherID, pusher: pusher)
  }

  func detach(id: UUID) {
    let shouldStop = withLock { () -> Bool in
      pushers.removeValue(forKey: id)
      return pushers.isEmpty
    }
    guard shouldStop else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.withLock({ self.pushers.isEmpty }) else { return }
      self.timer?.invalidate()
      self.timer = nil
    }
  }

  func detachAll() {
    withLock {
      pushers.removeAll()
      suppressedChangeCount = nil
    }
    DispatchQueue.main.async { [weak self] in
      guard let self, self.withLock({ self.pushers.isEmpty }) else { return }
      self.timer?.invalidate()
      self.timer = nil
    }
  }

  func detach() {
    detachAll()
  }

  func receiveClientText(id: UUID, text: String) {
    guard text.utf8.count <= RFBWire.maximumClipboardBytes else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let changeCount = self.pasteboard.changeCount
      let currentText = self.pasteboard.string(forType: .string)
      guard self.pasteboard.changeCount == changeCount else { return }
      if currentText == text {
        self.withLock {
          self.lastObservedChangeCount = changeCount
          self.lastKnownText = text
        }
        return
      }
      self.pasteboard.clearContents()
      guard self.pasteboard.setString(text, forType: .string) else { return }
      let otherPushers = self.withLock { () -> [@Sendable (String) -> Void] in
        self.suppressedChangeCount = self.pasteboard.changeCount
        self.lastObservedChangeCount = self.pasteboard.changeCount
        self.lastKnownText = text
        return self.pushers.filter { $0.key != id }.map { $0.value }
      }
      for pusher in otherPushers { pusher(text) }
    }
  }

  func receiveClientText(_ text: String) {
    receiveClientText(id: legacyPusherID, text: text)
  }

  func currentText() -> String? {
    withLock { lastKnownText }
  }

  /// Runs one poll cycle; main-queue only. Internal for tests.
  func poll() {
    let changeCount = pasteboard.changeCount
    let previous = withLock { lastObservedChangeCount }
    guard changeCount != previous else { return }

    let types = pasteboard.types ?? []
    let text = pasteboard.string(forType: .string)
    guard pasteboard.changeCount == changeCount else { return }

    var textToPush: String?
    var pushHandlers: [@Sendable (String) -> Void] = []
    withLock {
      lastObservedChangeCount = changeCount

      if suppressedChangeCount == changeCount {
        suppressedChangeCount = nil
        return
      }
      lastKnownText = text
      guard let outboundText = text ?? (types.isEmpty ? "" : nil) else {
        return
      }
      guard outboundText.utf8.count <= RFBWire.maximumClipboardBytes else {
        return
      }
      textToPush = outboundText
      pushHandlers = Array(pushers.values)
    }
    if let textToPush {
      for pushHandler in pushHandlers { pushHandler(textToPush) }
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
