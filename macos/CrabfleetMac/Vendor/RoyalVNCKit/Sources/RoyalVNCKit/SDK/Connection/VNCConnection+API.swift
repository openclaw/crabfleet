#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

// MARK: - Connect/Disconnect
public extension VNCConnection {
#if canImport(ObjectiveC)
	@objc
#endif
	func connect() {
		beginConnecting()
	}

#if canImport(ObjectiveC)
    @objc
#endif
	func disconnect() {
		beginDisconnecting()
	}
}

public extension VNCConnection {
#if canImport(ObjectiveC)
    @objc
#endif
	func updateColorDepth(_ colorDepth: Settings.ColorDepth) {
		guard let framebuffer = framebuffer else { return }

		let newPixelFormat = VNCProtocol.PixelFormat(depth: colorDepth.rawValue)

		state.pixelFormat = newPixelFormat

		let sendPixelFormatMessage = VNCProtocol.SetPixelFormat(pixelFormat: newPixelFormat)

		enqueueClientToServerMessage(sendPixelFormatMessage)

		recreateFramebuffer(size: framebuffer.size,
							screens: framebuffer.screens,
							pixelFormat: newPixelFormat)
	}
}

// MARK: - Mouse Input
public extension VNCConnection {
#if canImport(ObjectiveC)
    @objc
#endif
    func mouseMove(x: UInt16, y: UInt16) {
        enqueueMouseEvent(nonNormalizedX: x,
						  nonNormalizedY: y,
						  coalescible: true)
    }

#if canImport(ObjectiveC)
    @objc
#endif
    func mouseButtonDown(_ button: VNCMouseButton,
                         x: UInt16, y: UInt16) {
        updateMouseButtonState(button: button,
                               isDown: true)

        enqueueMouseEvent(nonNormalizedX: x,
						  nonNormalizedY: y,
						  coalescible: false)
    }

#if canImport(ObjectiveC)
    @objc
#endif
    func mouseButtonUp(_ button: VNCMouseButton,
                       x: UInt16, y: UInt16) {
        updateMouseButtonState(button: button,
                               isDown: false)

        enqueueMouseEvent(nonNormalizedX: x,
						  nonNormalizedY: y,
						  coalescible: false)
    }

#if canImport(ObjectiveC)
    @objc
#endif
    func mouseWheel(_ wheel: VNCMouseWheel,
                    x: UInt16, y: UInt16,
                    steps: UInt32) {
        for _ in 0..<steps {
            updateMouseButtonState(wheel: wheel,
                                   isDown: true)

            enqueueMouseEvent(nonNormalizedX: x,
							  nonNormalizedY: y,
							  coalescible: false)

            updateMouseButtonState(wheel: wheel,
                                   isDown: false)

			enqueueMouseEvent(nonNormalizedX: x,
							  nonNormalizedY: y,
							  coalescible: false)
        }
    }

	func releaseMouseButton(_ button: VNCMouseButton) {
		updateMouseButtonState(button: button, isDown: false)

		inputStateLock.lock()
		let buttons = mouseButtonState
		let position = lastMousePosition
		inputStateLock.unlock()

		enqueueMouseEvent(buttons: buttons, position: position, coalescible: false)
	}

	func releaseAllMouseButtons() {
		inputStateLock.lock()
		mouseButtonState = []
		let position = lastMousePosition
		inputStateLock.unlock()

		enqueueMouseEvent(buttons: [], position: position, coalescible: false)
	}
}

extension VNCConnection {
    func updateMouseButtonState(button: VNCMouseButton,
                                isDown: Bool) {
        updateMouseButtonState(mousePointerButton: button.mousePointerButton,
                               isDown: isDown)
    }

    func updateMouseButtonState(wheel: VNCMouseWheel,
                                isDown: Bool) {
        updateMouseButtonState(mousePointerButton: wheel.mousePointerButton,
                               isDown: isDown)
    }

    func updateMouseButtonState(mousePointerButton: VNCProtocol.MousePointerButton,
                                isDown: Bool) {
		inputStateLock.lock()
		defer { inputStateLock.unlock() }

        if isDown {
            mouseButtonState.insert(mousePointerButton)
        } else {
            mouseButtonState.remove(mousePointerButton)
        }
    }
}

// MARK: - Keyboard Input
public extension VNCConnection {
	func keyDown(_ key: VNCKeyCode) {
		enqueueKeyEvent(key: key,
						isDown: true)
	}

#if canImport(ObjectiveC)
	@objc(keyDown:)
#endif
	func _objc_keyDown(_ key: UInt32) {
		keyDown(.init(key))
	}

	func keyUp(_ key: VNCKeyCode) {
		enqueueKeyEvent(key: key,
						isDown: false)
	}

#if canImport(ObjectiveC)
	@objc(keyUp:)
#endif
	func _objc_keyUp(_ key: UInt32) {
		keyUp(.init(key))
	}
}


public enum VNCFramebufferUpdatePolicy: Equatable, Sendable {
	case interactive
	case maximumFPS(Double)
	case paused
}

public extension VNCConnection {
	var framebufferUpdatePolicy: VNCFramebufferUpdatePolicy {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		return _framebufferUpdatePolicy
	}

	func setFramebufferUpdatePolicy(_ policy: VNCFramebufferUpdatePolicy) {
		framebufferRequestLock.lock()
		_framebufferUpdatePolicy = policy
		framebufferRequestGeneration &+= 1
		framebufferPacingTask?.cancel()
		framebufferPacingTask = nil
		let shouldSchedule = !framebufferUpdateRequestOutstanding
		framebufferRequestLock.unlock()

		if shouldSchedule, connectionState.status == .connected {
			scheduleNextFramebufferUpdate()
		}
	}
}

extension VNCConnection {
	func reserveFramebufferUpdateRequest() -> Bool {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard !framebufferUpdateRequestOutstanding else { return false }
		framebufferUpdateRequestOutstanding = true
		return true
	}

	func completeFramebufferUpdateRequest() {
		framebufferRequestLock.lock()
		framebufferUpdateRequestOutstanding = false
		framebufferRequestLock.unlock()
	}

	func scheduleNextFramebufferUpdate() {
		framebufferRequestLock.lock()
		framebufferPacingTask?.cancel()

		guard !framebufferUpdateRequestOutstanding else {
			framebufferPacingTask = nil
			framebufferRequestLock.unlock()
			return
		}

		let generation = framebufferRequestGeneration
		let delayNanoseconds: UInt64
		switch _framebufferUpdatePolicy {
			case .interactive:
				delayNanoseconds = 0
			case .maximumFPS(let requestedFPS):
				let framesPerSecond = min(max(requestedFPS, 0.5), 60)
				delayNanoseconds = UInt64(1_000_000_000 / framesPerSecond)
			case .paused:
				framebufferPacingTask = nil
				framebufferRequestLock.unlock()
				return
		}

		let task = Task { [weak self] in
			if delayNanoseconds > 0 {
				try? await Task.sleep(nanoseconds: delayNanoseconds)
			}
			guard !Task.isCancelled, let self else { return }

			let isCurrent = self.finishFramebufferPacingTask(generation: generation)
			guard isCurrent, !self.state.disconnectRequested else { return }

			do {
				try await self.sendFramebufferUpdateRequest()
			} catch {
				self.handleBreakingError(error)
			}
		}
		framebufferPacingTask = task
		framebufferRequestLock.unlock()
	}

	func cancelFramebufferUpdateScheduling() {
		framebufferRequestLock.lock()
		framebufferRequestGeneration &+= 1
		framebufferPacingTask?.cancel()
		framebufferPacingTask = nil
		framebufferUpdateRequestOutstanding = false
		framebufferRequestLock.unlock()
	}

	private func finishFramebufferPacingTask(generation: UInt64) -> Bool {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		let isCurrent = framebufferRequestGeneration == generation
		if isCurrent {
			framebufferPacingTask = nil
		}
		return isCurrent
	}
}
