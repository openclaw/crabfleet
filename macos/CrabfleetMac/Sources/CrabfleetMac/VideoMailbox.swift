import Foundation

/// Single-slot, latest-wins handoff between a producer callback (capture or
/// encoder output) and one async consumer. Offering while a value is pending
/// replaces it and reports the drop so the producer can react.
final class VideoMailbox<Element>: @unchecked Sendable {
  private typealias Waiter = (
    id: UUID,
    continuation: CheckedContinuation<Element?, Never>
  )

  private let lock = NSLock()
  private var latestElement: Element?
  private var waiter: Waiter?
  private var finished = false

  var isFinished: Bool {
    withLock { finished }
  }

  func offer(_ element: Element, onDrop: () -> Void = {}) {
    let continuation = withLock { () -> CheckedContinuation<Element?, Never>? in
      guard !finished else { return nil }
      guard let waiter else {
        if latestElement != nil { onDrop() }
        latestElement = element
        return nil
      }
      self.waiter = nil
      return waiter.continuation
    }
    continuation?.resume(returning: element)
  }

  func finish() {
    let continuation = withLock { () -> CheckedContinuation<Element?, Never>? in
      guard !finished else { return nil }
      finished = true
      latestElement = nil
      defer { waiter = nil }
      return waiter?.continuation
    }
    continuation?.resume(returning: nil)
  }

  /// Returns the pending element, waits until one is offered, or returns nil
  /// after `timeout` or once the mailbox is finished. Only one consumer may
  /// wait at a time; a second waiter displaces the first.
  func next(timeout: Duration) async -> Element? {
    let id = UUID()
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        var immediateElement: Element?
        var shouldResume = false
        var replacedWaiter: Waiter?
        lock.lock()
        if let latestElement {
          immediateElement = latestElement
          self.latestElement = nil
          shouldResume = true
        } else if finished {
          shouldResume = true
        } else {
          replacedWaiter = waiter
          waiter = (id, continuation)
        }
        lock.unlock()

        replacedWaiter?.continuation.resume(returning: nil)
        if shouldResume {
          continuation.resume(returning: immediateElement)
        } else {
          Task {
            try? await Task.sleep(for: timeout)
            self.expire(id: id)
          }
        }
      }
    } onCancel: {
      self.expire(id: id)
    }
  }

  private func expire(id: UUID) {
    let continuation = withLock { () -> CheckedContinuation<Element?, Never>? in
      guard waiter?.id == id else { return nil }
      defer { waiter = nil }
      return waiter?.continuation
    }
    continuation?.resume(returning: nil)
  }

  private func withLock<T>(_ body: () -> T) -> T {
    lock.lock()
    defer { lock.unlock() }
    return body()
  }
}
