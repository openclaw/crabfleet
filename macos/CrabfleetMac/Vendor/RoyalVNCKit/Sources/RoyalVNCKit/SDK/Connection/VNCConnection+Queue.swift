#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(CoreGraphics)
import CoreGraphics
#endif

// MARK: - Queue Management
extension VNCConnection {
	func enqueueKeyEvent(key: VNCKeyCode,
						 isDown: Bool) {
		guard settings.inputMode != .none else { return }

		let isARD = state.isAppleRemoteDesktop
		let keyCode = key.rawValue(forAppleRemoteDesktop: isARD)

		let keyEvent = VNCProtocol.KeyEvent(isDown: isDown,
											key: keyCode)

		logger.logDebug("Enqueuing Key \(keyEvent.description)")

		enqueueClientToServerMessage(keyEvent)
	}

    func enqueueMouseEvent(nonNormalizedX: UInt16,
                           nonNormalizedY: UInt16,
						   coalescible: Bool) {
        guard settings.inputMode != .none else { return }

        let normalizedPosition = normalizedMousePosition(x: nonNormalizedX,
                                                         y: nonNormalizedY)

        enqueueMouseEvent(buttons: currentMouseButtonState(),
						  position: normalizedPosition,
						  coalescible: coalescible)
    }

	func enqueueMouseEvent(buttons: VNCProtocol.MousePointerButton,
						   position: VNCProtocol.MousePosition,
						   coalescible: Bool) {
		guard settings.inputMode != .none else { return }

		inputStateLock.lock()
		lastMousePosition = position
		inputStateLock.unlock()

		let pointerEvent = VNCProtocol.PointerEvent(buttons: buttons,
											position: position)
		let queuedPointer = QueuedClientMessage(
			message: pointerEvent,
			isCoalescible: coalescible
		)

		if coalescible {
			clientToServerMessageQueue.enqueue(queuedPointer) { queuedMessage in
				guard queuedMessage.isCoalescible,
					  let previousPointer = queuedMessage.message as? VNCProtocol.PointerEvent else {
					return false
				}
				return previousPointer.buttonMask == pointerEvent.buttonMask
			}
		} else {
			clientToServerMessageQueue.enqueue(queuedPointer)
		}
	}

	func enqueueClientCutTextMessage(_ text: String) {
		guard let clientCutTextMessage = VNCProtocol.ClientCutText(text: text) else {
			logger.logWarning("Ignoring clipboard text that exceeds the 1 MiB limit or is not ISO-8859-1")
			return
		}

		enqueueClientToServerMessage(clientCutTextMessage)
	}

	func enqueueClientToServerMessage(_ message: VNCSendableMessage) {
		clientToServerMessageQueue.enqueue(
			QueuedClientMessage(message: message, isCoalescible: false)
		)
	}

	func enqueueDesktopSizeMessage(_ message: VNCProtocol.SetDesktopSize) {
		let queuedMessage = QueuedClientMessage(message: message, isCoalescible: true)
		clientToServerMessageQueue.enqueue(queuedMessage) { queued in
			queued.isCoalescible && queued.message is VNCProtocol.SetDesktopSize
		}
	}

	func currentMouseButtonState() -> VNCProtocol.MousePointerButton {
		inputStateLock.lock()
		defer { inputStateLock.unlock() }
		return mouseButtonState
	}

    func normalizedMousePosition(x: UInt16,
                                 y: UInt16) -> VNCProtocol.MousePosition {
        var normalizedX = x
        var normalizedY = y

        let framebufferWidth = framebuffer?.size.width ?? 0
        let framebufferHeight = framebuffer?.size.height ?? 0

        if normalizedY > framebufferHeight {
            normalizedY = framebufferHeight
        }

        if normalizedX > framebufferWidth {
            normalizedX = framebufferWidth
        }

        let normalizedPosition = VNCProtocol.MousePosition(x: normalizedX,
                                                           y: normalizedY)

        return normalizedPosition
    }
}
