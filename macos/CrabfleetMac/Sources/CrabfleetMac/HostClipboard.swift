import AppKit
import Foundation

/// Synchronizes the host Mac's pasteboard with the connected RFB viewer while
/// Share This Mac runs. The RFB session pulls snapshots and delivers client
/// text from its background task; all pasteboard access happens on the main
/// queue.
protocol HostClipboardSyncing: AnyObject, Sendable {
  /// Starts monitoring and forwards host pasteboard changes to `pusher`.
  /// The current pasteboard content is baselined, not pushed.
  func attach(pusher: @escaping @Sendable (String) -> Void)
  func detach()

  /// Applies clipboard text received from the connected viewer.
  func receiveClientText(_ text: String)

  /// Most recent host pasteboard text observed by the monitor.
  func currentText() -> String?
}

final class HostClipboardBridge: HostClipboardSyncing, @unchecked Sendable {
  private let pasteboard: NSPasteboard
  private let pollingInterval: TimeInterval
  private let lock = NSLock()
  private var pusher: (@Sendable (String) -> Void)?
  private var timer: Timer?
  private var lastObservedChangeCount: Int?
  private var suppressedChangeCount: Int?
  private var lastKnownText: String?
  private var lastAppliedClientText: String?

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

  func attach(pusher: @escaping @Sendable (String) -> Void) {
    withLock {
      self.pusher = pusher
    }
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

  func detach() {
    withLock {
      pusher = nil
      lastAppliedClientText = nil
      suppressedChangeCount = nil
    }
    DispatchQueue.main.async { [weak self] in
      self?.timer?.invalidate()
      self?.timer = nil
    }
  }

  func receiveClientText(_ text: String) {
    guard text.utf8.count <= RFBWire.maximumClipboardBytes else { return }
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      let alreadyCurrent = self.withLock { self.lastKnownText == text }
      if alreadyCurrent {
        self.withLock { self.lastAppliedClientText = text }
        return
      }
      self.pasteboard.clearContents()
      guard self.pasteboard.setString(text, forType: .string) else { return }
      self.withLock {
        self.suppressedChangeCount = self.pasteboard.changeCount
        self.lastObservedChangeCount = self.pasteboard.changeCount
        self.lastAppliedClientText = text
        self.lastKnownText = text
      }
    }
  }

  func currentText() -> String? {
    withLock { lastKnownText }
  }

  /// Runs one poll cycle; main-queue only. Internal for tests.
  func poll() {
    let changeCount = pasteboard.changeCount
    let previous = withLock { lastObservedChangeCount }
    guard changeCount != previous else { return }

    let text = pasteboard.string(forType: .string)
    guard pasteboard.changeCount == changeCount else { return }

    var textToPush: String?
    var pushHandler: (@Sendable (String) -> Void)?
    withLock {
      lastObservedChangeCount = changeCount
      lastKnownText = text

      if suppressedChangeCount == changeCount {
        suppressedChangeCount = nil
        return
      }
      guard let text, !text.isEmpty,
        text != lastAppliedClientText,
        text.utf8.count <= RFBWire.maximumClipboardBytes
      else {
        return
      }
      textToPush = text
      pushHandler = pusher
    }
    if let textToPush, let pushHandler {
      pushHandler(textToPush)
    }
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
