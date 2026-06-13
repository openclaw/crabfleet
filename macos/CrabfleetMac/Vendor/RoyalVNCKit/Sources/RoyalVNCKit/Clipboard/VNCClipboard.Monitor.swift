#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Dispatch

#if os(macOS)
import AppKit
#elseif os(iOS)
import UIKit
#endif

final class VNCClipboardMonitor {
	let clipboard: VNCClipboard
	let monitoringInterval: TimeInterval
	let tolerance: TimeInterval

	weak var delegate: VNCClipboardMonitorDelegate?

	private(set) var isMonitoring = false
	private let generationLock = NSLock()
	private var monitoringGeneration: UInt64 = 0

#if !canImport(FoundationEssentials)
	private var timer: Timer?
#endif

	private var lastChangeCount = 0

	init(clipboard: VNCClipboard,
		 monitoringInterval: TimeInterval,
		 tolerance: TimeInterval) {
		self.clipboard = clipboard
		self.monitoringInterval = monitoringInterval
		self.tolerance = tolerance
	}

	deinit {
		delegate = nil

#if !canImport(FoundationEssentials)
		timer?.invalidate()
#endif
	}
}

extension VNCClipboardMonitor {
	func startMonitoring() {
		let generation = advanceGeneration()

#if !canImport(FoundationEssentials)
		let start = { [weak self] in
			guard let self, self.isCurrentGeneration(generation) else { return }

			self.timer?.invalidate()

			// -1 intentionally sends the existing clipboard once after an opt-in connection.
			self.lastChangeCount = self.clipboard.changeCount - 1

            let timer = Timer.scheduledTimer(withTimeInterval: self.monitoringInterval,
                                             repeats: true,
											 block: { [weak self] timer in
												 self?.timerDidFire(timer)
											 })

			timer.tolerance = self.tolerance

            self.timer = timer
            self.isMonitoring = true
		}

		if Thread.isMainThread {
			start()
		} else {
			DispatchQueue.main.async(execute: start)
		}
#endif
	}

	func stopMonitoring() {
		let generation = advanceGeneration()
#if !canImport(FoundationEssentials)
		let stop = { [weak self] in
			guard let self, self.isCurrentGeneration(generation) else { return }
			self.timer?.invalidate()
			self.timer = nil
			self.lastChangeCount = 0
			self.isMonitoring = false
		}

		if Thread.isMainThread {
			stop()
		} else {
			DispatchQueue.main.async(execute: stop)
		}
#else
		lastChangeCount = 0
		isMonitoring = false
#endif
	}

	func markCurrentChangeAsObserved() {
		dispatchPrecondition(condition: .onQueue(.main))
		lastChangeCount = clipboard.changeCount
	}

	private func advanceGeneration() -> UInt64 {
		generationLock.lock()
		defer { generationLock.unlock() }
		monitoringGeneration &+= 1
		return monitoringGeneration
	}

	private func isCurrentGeneration(_ generation: UInt64) -> Bool {
		generationLock.lock()
		defer { generationLock.unlock() }
		return monitoringGeneration == generation
	}
}

#if !canImport(FoundationEssentials)
private extension VNCClipboardMonitor {
	func timerDidFire(_ timer: Timer) {
		guard let delegate,
			  timer == self.timer else {
			return
		}

		guard delegate.clipboardMonitorShouldMonitor(self) else { // Should not monitor
			return
		}

		let currentChangeCount = clipboard.changeCount

		guard currentChangeCount != lastChangeCount else { // No changes
			return
		}

		lastChangeCount = currentChangeCount

		guard let text = clipboard.text else { // No text
			return
		}

		delegate.clipboardMonitor(self,
								  didChangeText: text)
	}
}
#endif
