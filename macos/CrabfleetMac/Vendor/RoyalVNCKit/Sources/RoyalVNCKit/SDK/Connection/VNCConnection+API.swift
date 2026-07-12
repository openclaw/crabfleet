#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

private struct PixelFormatTransitionMessage: VNCSendableMessage {
	let fenceMessage: VNCProtocol.ClientFence?
	let pixelFormatMessage: VNCProtocol.SetPixelFormat
	let willSend: () -> Void
	let didSend: () -> Void
	let willSendFence: () -> Void
	let didSendFence: () -> Void
	let didFailFence: () -> Void

	var messageType: UInt8 { fenceMessage?.messageType ?? pixelFormatMessage.messageType }
	var data: Data {
		(fenceMessage?.data ?? Data()) + pixelFormatMessage.data
	}

	func send(connection: NetworkConnectionWriting) async throws {
		if fenceMessage == nil {
			willSend()
		} else {
			willSendFence()
		}
		do {
			try await connection.write(data: data)
		} catch {
			if fenceMessage != nil {
				didFailFence()
			}
			throw error
		}
		if fenceMessage == nil {
			didSend()
		} else {
			didSendFence()
		}
	}
}

private struct PixelFormatTransition {
	let pixelFormat: VNCProtocol.PixelFormat
	let fenceFlags: VNCProtocol.FenceFlags
	let fencePayload: Data?
}

private struct FenceCapabilityProbeMessage: VNCSendableMessage {
	let fenceMessage: VNCProtocol.ClientFence
	let pixelFormatMessage: VNCProtocol.SetPixelFormat
	let didSend: () -> Void

	var messageType: UInt8 { fenceMessage.messageType }
	var data: Data { fenceMessage.data + pixelFormatMessage.data }

	func send(connection: NetworkConnectionWriting) async throws {
		try await connection.write(data: data)
		didSend()
	}
}

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
		withLifecycleLock {
			guard connectionState.status == .connected,
				  framebuffer != nil else {
				return
			}

			let newPixelFormat = VNCProtocol.PixelFormat(depth: colorDepth.rawValue)
			requestPixelFormatTransition(newPixelFormat)
		}
	}

	/// Requests a single-screen desktop matching the viewer viewport.
	/// Returns false until the server advertises ExtendedDesktopSize support.
	@discardableResult
	func requestDesktopSize(width: UInt16, height: UInt16) -> Bool {
		guard connectionState.status == .connected,
			  width > 0,
			  height > 0,
			  let framebuffer,
			  framebuffer.supportsDesktopResize,
			  let screen = framebuffer.screens.first else {
			return false
		}

		let requestedScreen = VNCProtocol.Screen(
			id: screen.id,
			xPosition: 0,
			yPosition: 0,
			width: width,
			height: height,
			flags: screen.flags
		)
		enqueueDesktopSizeMessage(
			VNCProtocol.SetDesktopSize(
				width: width,
				height: height,
				screens: [requestedScreen]
			)
		)
		return true
	}
}

extension VNCConnection {
	private func requestPixelFormatTransition(_ pixelFormat: VNCProtocol.PixelFormat) {
		framebufferRequestLock.lock()
		pendingPixelFormatTransition = pixelFormat
		framebufferRequestGeneration &+= 1
		framebufferPacingTask?.cancel()
		framebufferPacingTask = nil
		let transition = takePendingPixelFormatTransitionLocked()
		framebufferRequestLock.unlock()

		if let transition {
			enqueuePixelFormatTransition(transition)
		}
	}

	private func takePendingPixelFormatTransitionLocked() -> PixelFormatTransition? {
		guard !isPixelFormatTransitionInFlight,
			  pixelFormatFenceCapabilityProbePayload == nil,
			  let pixelFormat = pendingPixelFormatTransition else {
			return nil
		}

		let supportedFenceFlags = state.pixelFormatTransitionFenceFlags
		let supportsSynchronizedBoundary =
			supportedFenceFlags.contains(.blockBefore)
			&& supportedFenceFlags.contains(.syncNext)
		var fenceFlags: VNCProtocol.FenceFlags = []
		if state.areContinuousUpdatesEnabled {
			guard supportsSynchronizedBoundary else {
				if !state.areFencesSupported {
					schedulePixelFormatFenceNegotiationTimeoutLocked()
				} else {
					pendingPixelFormatTransition = nil
				}
				return nil
			}
			fenceFlags = [.request, .blockBefore, .syncNext]
		} else if framebufferUpdateRequestOutstanding {
			if supportsSynchronizedBoundary {
				fenceFlags = [.request, .blockBefore, .syncNext]
			} else {
				if !state.areFencesSupported {
					schedulePixelFormatFenceNegotiationTimeoutLocked()
				}
				return nil
			}
		}

		cancelPixelFormatFenceNegotiationTimeoutLocked()
		pendingPixelFormatTransition = nil
		isPixelFormatTransitionInFlight = true
		pixelFormatTransitionInFlight = pixelFormat
		let fencePayload: Data?
		if !fenceFlags.isEmpty {
			pixelFormatTransitionFenceSequence &+= 1
			var sequence = pixelFormatTransitionFenceSequence.bigEndian
			fencePayload = withUnsafeBytes(of: &sequence) { Data($0) }
			pixelFormatTransitionFencePayload = fencePayload
			pixelFormatTransitionRequiredFenceFlags = [.blockBefore, .syncNext]
			pixelFormatTransitionFenceWasSent = false
		} else {
			fencePayload = nil
			pixelFormatTransitionRequiredFenceFlags = []
			pixelFormatTransitionFenceWasSent = false
		}
		return PixelFormatTransition(
			pixelFormat: pixelFormat,
			fenceFlags: fenceFlags,
			fencePayload: fencePayload
		)
	}

	private func enqueuePixelFormatTransition(_ transition: PixelFormatTransition) {
		let fenceMessage = transition.fencePayload.map {
			VNCProtocol.ClientFence(flags: transition.fenceFlags, payload: $0)
		}
		let message = PixelFormatTransitionMessage(
			fenceMessage: fenceMessage,
			pixelFormatMessage: VNCProtocol.SetPixelFormat(pixelFormat: transition.pixelFormat),
			willSend: { [weak self] in
				self?.beginPixelFormatTransition(transition.pixelFormat)
			},
			didSend: { [weak self] in
				self?.completePixelFormatTransition()
			},
			willSendFence: { [weak self] in
				guard let payload = transition.fencePayload else { return }
				self?.beginPixelFormatTransitionFenceWrite(payload: payload)
			},
			didSendFence: { [weak self] in
				guard let payload = transition.fencePayload else { return }
				self?.schedulePixelFormatTransitionDeadline(payload: payload)
			},
			didFailFence: { [weak self] in
				guard let payload = transition.fencePayload else { return }
				self?.cancelPixelFormatTransitionFenceWrite(payload: payload)
			}
		)

		enqueueClientToServerMessage(message)
	}

	private func beginPixelFormatTransitionFenceWrite(payload: Data) {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard isPixelFormatTransitionInFlight,
			  pixelFormatTransitionFencePayload == payload else {
			return
		}
		pixelFormatTransitionFenceWasSent = true
	}

	private func schedulePixelFormatTransitionDeadline(payload: Data) {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard isPixelFormatTransitionInFlight,
			  pixelFormatTransitionFencePayload == payload,
			  pixelFormatTransitionFenceWasSent else {
			return
		}

		schedulePixelFormatTransitionDeadlineIfReadyLocked(payload: payload)
	}

	private func cancelPixelFormatTransitionFenceWrite(payload: Data) {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard pixelFormatTransitionFencePayload == payload else { return }
		pixelFormatTransitionFenceWasSent = false
		cancelPixelFormatTransitionDeadlineLocked()
	}

	private func schedulePixelFormatTransitionDeadlineIfReadyLocked(payload: Data) {
		guard pixelFormatTransitionFenceWasSent,
			  !framebufferUpdateRequestOutstanding,
			  pixelFormatTransitionDeadlineTask == nil else {
			return
		}

		pixelFormatTransitionDeadlineTask = Task { [weak self] in
			do {
				try await Task.sleep(nanoseconds: 5_000_000_000)
			} catch {
				return
			}
			self?.expirePixelFormatTransitionDeadline(payload: payload)
		}
	}

	private func cancelPixelFormatTransitionDeadlineLocked() {
		pixelFormatTransitionDeadlineTask?.cancel()
		pixelFormatTransitionDeadlineTask = nil
	}

	func expirePixelFormatTransitionDeadline(payload: Data) {
		framebufferRequestLock.lock()
		guard isPixelFormatTransitionInFlight,
			  pixelFormatTransitionFencePayload == payload,
			  pixelFormatTransitionDeadlineTask != nil else {
			framebufferRequestLock.unlock()
			return
		}
		pixelFormatTransitionDeadlineTask = nil
		framebufferRequestLock.unlock()

		handleBreakingError(VNCError.protocol(.pixelFormatTransitionTimedOut))
	}

	func publishPixelFormatFenceSupport() -> Bool {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard !state.areFencesSupported else { return false }

		cancelPixelFormatFenceNegotiationTimeoutLocked()
		if pixelFormatFenceCapabilityProbePayload == nil,
		   state.pixelFormat != nil {
			pixelFormatFenceCapabilityProbePayload = Data("royalvnc-pixel-format".utf8)
		}
		state.areFencesSupported = true
		return true
	}

	func enqueuePixelFormatFenceSupportProbe() {
		framebufferRequestLock.lock()
		guard let payload = pixelFormatFenceCapabilityProbePayload,
			  let pixelFormat = state.pixelFormat else {
			framebufferRequestLock.unlock()
			return
		}
		framebufferRequestLock.unlock()

		enqueueClientToServerMessage(
			FenceCapabilityProbeMessage(
				fenceMessage: VNCProtocol.ClientFence(
					flags: [.request, .blockBefore, .blockAfter, .syncNext],
					payload: payload
				),
				pixelFormatMessage: VNCProtocol.SetPixelFormat(pixelFormat: pixelFormat),
				didSend: { [weak self] in
					self?.didSendPixelFormatFenceCapabilityProbe(payload: payload)
				}
			)
		)
	}

	private func didSendPixelFormatFenceCapabilityProbe(payload: Data) {
		framebufferRequestLock.lock()
		defer { framebufferRequestLock.unlock() }
		guard pixelFormatFenceCapabilityProbePayload == payload else { return }
		schedulePixelFormatFenceNegotiationTimeoutLocked()
	}

	private func schedulePixelFormatFenceNegotiationTimeoutLocked() {
		guard pixelFormatFenceNegotiationTask == nil else { return }

		pixelFormatFenceNegotiationTask = Task { [weak self] in
			do {
				try await Task.sleep(nanoseconds: 1_000_000_000)
			} catch {
				return
			}
			self?.expirePixelFormatFenceNegotiation()
		}
	}

	private func cancelPixelFormatFenceNegotiationTimeoutLocked() {
		pixelFormatFenceNegotiationTask?.cancel()
		pixelFormatFenceNegotiationTask = nil
	}

	func expirePixelFormatFenceNegotiation() {
		framebufferRequestLock.lock()
		cancelPixelFormatFenceNegotiationTimeoutLocked()
		let probeTimedOut = pixelFormatFenceCapabilityProbePayload != nil
		let negotiationTimedOut =
			!state.areFencesSupported
			&& pendingPixelFormatTransition != nil
			&& !isPixelFormatTransitionInFlight
		guard probeTimedOut || negotiationTimedOut else {
			framebufferRequestLock.unlock()
			return
		}
		if probeTimedOut {
			expiredPixelFormatFenceCapabilityProbePayload = pixelFormatFenceCapabilityProbePayload
			pixelFormatFenceCapabilityProbePayload = nil
		}
		let isWaitingForLegacyFramebufferBoundary =
			negotiationTimedOut
			&& !state.areContinuousUpdatesEnabled
			&& framebufferUpdateRequestOutstanding
		if negotiationTimedOut && !isWaitingForLegacyFramebufferBoundary {
			pendingPixelFormatTransition = nil
		}
		let transition = probeTimedOut ? takePendingPixelFormatTransitionLocked() : nil
		let shouldResumeUpdates =
			transition == nil
			&& pendingPixelFormatTransition == nil
			&& !framebufferUpdateRequestOutstanding
			&& !isPixelFormatTransitionInFlight
		framebufferRequestLock.unlock()

		if let transition {
			enqueuePixelFormatTransition(transition)
		} else if shouldResumeUpdates {
			scheduleNextFramebufferUpdate()
		}
		logger.logDebug("Fence capability negotiation timed out")
	}

	func completePixelFormatFence(_ fence: VNCProtocol.ServerFence) throws {
		framebufferRequestLock.lock()
		if fence.payload == pixelFormatFenceCapabilityProbePayload
			|| fence.payload == expiredPixelFormatFenceCapabilityProbePayload {
			cancelPixelFormatFenceNegotiationTimeoutLocked()
			pixelFormatFenceCapabilityProbePayload = nil
			expiredPixelFormatFenceCapabilityProbePayload = nil
			state.pixelFormatTransitionFenceFlags = fence.flags.intersection([
				.blockBefore,
				.blockAfter,
				.syncNext
			])
			let transition = takePendingPixelFormatTransitionLocked()
			framebufferRequestLock.unlock()

			if let transition {
				enqueuePixelFormatTransition(transition)
			}
			return
		}
		guard fence.payload == pixelFormatTransitionFencePayload else {
			framebufferRequestLock.unlock()
			return
		}
		guard pixelFormatTransitionFenceWasSent else {
			framebufferRequestLock.unlock()
			throw VNCError.protocol(.invalidData)
		}
		let requiredFlags = pixelFormatTransitionRequiredFenceFlags
		guard fence.flags.intersection(requiredFlags) == requiredFlags else {
			framebufferRequestLock.unlock()
			throw VNCError.protocol(.invalidData)
		}
		guard let pixelFormat = pixelFormatTransitionInFlight else {
			framebufferRequestLock.unlock()
			throw VNCError.protocol(.invalidData)
		}
		cancelPixelFormatTransitionDeadlineLocked()
		pixelFormatTransitionFenceWasSent = false
		pixelFormatTransitionFencePayload = nil
		pixelFormatTransitionRequiredFenceFlags = []
		framebufferRequestLock.unlock()

		beginPixelFormatTransition(pixelFormat)
		completePixelFormatTransition()
	}

	private func beginPixelFormatTransition(_ pixelFormat: VNCProtocol.PixelFormat) {
		withLifecycleLock {
			guard connectionState.status == .connected,
				  let framebuffer = framebuffer else {
				return
			}

			state.pixelFormat = pixelFormat
			recreateFramebuffer(size: framebuffer.size,
								screens: framebuffer.screens,
								pixelFormat: pixelFormat)
		}
	}

	private func completePixelFormatTransition() {
		framebufferRequestLock.lock()
		isPixelFormatTransitionInFlight = false
		pixelFormatTransitionInFlight = nil
		let nextTransition = takePendingPixelFormatTransitionLocked()
		framebufferRequestLock.unlock()

		if let nextTransition {
			enqueuePixelFormatTransition(nextTransition)
		} else {
			scheduleNextFramebufferUpdate()
		}
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
		guard !framebufferUpdateRequestOutstanding,
			  pendingPixelFormatTransition == nil,
			  !isPixelFormatTransitionInFlight else {
			return false
		}
		framebufferUpdateRequestOutstanding = true
		return true
	}

	func completeFramebufferUpdateRequest() {
		framebufferRequestLock.lock()
		framebufferUpdateRequestOutstanding = false
		if let payload = pixelFormatTransitionFencePayload {
			schedulePixelFormatTransitionDeadlineIfReadyLocked(payload: payload)
		}
		let transition = takePendingPixelFormatTransitionLocked()
		framebufferRequestLock.unlock()

		if let transition {
			enqueuePixelFormatTransition(transition)
		}
	}

	func scheduleNextFramebufferUpdate() {
		framebufferRequestLock.lock()
		framebufferPacingTask?.cancel()

		guard !framebufferUpdateRequestOutstanding,
			  pendingPixelFormatTransition == nil,
			  !isPixelFormatTransitionInFlight else {
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
		pendingPixelFormatTransition = nil
		isPixelFormatTransitionInFlight = false
		pixelFormatTransitionInFlight = nil
		pixelFormatTransitionFencePayload = nil
		pixelFormatTransitionRequiredFenceFlags = []
		pixelFormatTransitionFenceWasSent = false
		cancelPixelFormatTransitionDeadlineLocked()
		pixelFormatFenceCapabilityProbePayload = nil
		expiredPixelFormatFenceCapabilityProbePayload = nil
		cancelPixelFormatFenceNegotiationTimeoutLocked()
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
