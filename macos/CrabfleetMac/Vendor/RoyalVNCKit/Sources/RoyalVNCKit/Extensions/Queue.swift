#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

final class Queue<T>: @unchecked Sendable {
	private let lock = NSLock()
	private var list = [T]()
	private var head = 0
	private var waiter: CheckedContinuation<T?, Never>?
	private var isFinished = false

	func enqueue(_ element: T) {
		lock.lock()
		guard !isFinished else {
			lock.unlock()
			return
		}
		if let waiter {
			self.waiter = nil
			lock.unlock()
			waiter.resume(returning: element)
			return
		}
		list.append(element)
		lock.unlock()
	}

	func enqueue(_ element: T, coalescingLastWhere shouldCoalesce: (T) -> Bool) {
		lock.lock()
		guard !isFinished else {
			lock.unlock()
			return
		}
		if let waiter {
			self.waiter = nil
			lock.unlock()
			waiter.resume(returning: element)
			return
		}
		if head < list.count, let last = list.last, shouldCoalesce(last) {
			list[list.count - 1] = element
		} else {
			list.append(element)
		}
		lock.unlock()
	}

	func dequeue() -> T? {
		lock.lock()
		defer { lock.unlock() }
		return dequeueLocked()
	}

	func next() async -> T? {
		await withCheckedContinuation { continuation in
			lock.lock()
			if let element = dequeueLocked() {
				lock.unlock()
				continuation.resume(returning: element)
				return
			}
			if isFinished {
				lock.unlock()
				continuation.resume(returning: nil)
				return
			}

			precondition(waiter == nil, "Queue supports one async consumer")
			waiter = continuation
			lock.unlock()
		}
	}

	func finish() {
		lock.lock()
		isFinished = true
		list.removeAll()
		head = 0
		let waiter = waiter
		self.waiter = nil
		lock.unlock()

		waiter?.resume(returning: nil)
	}

	private func dequeueLocked() -> T? {
		guard head < list.count else { return nil }

		let element = list[head]
		head += 1

		if head >= 64, head * 2 >= list.count {
			list.removeFirst(head)
			head = 0
		}

		return element
	}

	func clear() {
		lock.lock()
		defer { lock.unlock() }
		list.removeAll()
		head = 0
	}

	func peek() -> T? {
		lock.lock()
		defer { lock.unlock() }
		guard head < list.count else { return nil }

		return list[head]
	}

	var isEmpty: Bool {
		lock.lock()
		defer { lock.unlock() }
		return head >= list.count
	}
}
