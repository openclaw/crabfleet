#if os(macOS) || os(iOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCFramebufferView {
	func frameSizeExceedsFramebufferSize(_ frameSize: CGSize) -> Bool {
		return frameSize.width >= framebufferSize.width &&
			   frameSize.height >= framebufferSize.height
	}

	func handleScrollWheel(scrollDelta: CGPoint,
						   hasPreciseScrollingDeltas: Bool,
                           mousePositionX: UInt16,
                           mousePositionY: UInt16) {
		if hasPreciseScrollingDeltas {
			handlePreciseScrollingDelta(scrollDelta,
                                        mousePositionX: mousePositionX,
                                        mousePositionY: mousePositionY)
		} else {
			handleImpreciseScrollingDelta(scrollDelta,
                                          mousePositionX: mousePositionX,
                                          mousePositionY: mousePositionY)
		}
	}

	func handleImpreciseScrollingDelta(_ scrollDelta: CGPoint,
                                       mousePositionX: UInt16,
                                       mousePositionY: UInt16) {
		guard let connection = self.connection else {
            return
        }

		if scrollDelta.x < 0 {
            connection.mouseWheel(.right, x: mousePositionX, y: mousePositionY, steps: 1)
		} else if scrollDelta.x > 0 {
            connection.mouseWheel(.left, x: mousePositionX, y: mousePositionY, steps: 1)
		}

		if scrollDelta.y < 0 {
            connection.mouseWheel(.down, x: mousePositionX, y: mousePositionY, steps: 1)
		} else if scrollDelta.y > 0 {
            connection.mouseWheel(.up, x: mousePositionX, y: mousePositionY, steps: 1)
		}
	}

	func handlePreciseScrollingDelta(_ scrollDelta: CGPoint,
                                     mousePositionX: UInt16,
                                     mousePositionY: UInt16) {
        accumulatedScrollDeltaX += scrollDelta.x
		accumulatedScrollDeltaY += scrollDelta.y

//		#if DEBUG
//		connection.logger.logInfo("Accumulated Scroll Delta: {x: \(accumulatedScrollDeltaX); y: \(accumulatedScrollDeltaY)}")
//		#endif

		if abs(accumulatedScrollDeltaX) >= scrollStep {
			while abs(accumulatedScrollDeltaX) >= scrollStep {
				if accumulatedScrollDeltaX < 0 {
                    connection?.mouseWheel(.right, x: mousePositionX, y: mousePositionY, steps: 1)

					accumulatedScrollDeltaX += scrollStep
				} else if accumulatedScrollDeltaX > 0 {
                    connection?.mouseWheel(.left, x: mousePositionX, y: mousePositionY, steps: 1)

					accumulatedScrollDeltaX -= scrollStep
				}
			}

			accumulatedScrollDeltaX = 0
		}

		if abs(accumulatedScrollDeltaY) >= scrollStep {
			while abs(accumulatedScrollDeltaY) >= scrollStep {
				if accumulatedScrollDeltaY < 0 {
                    connection?.mouseWheel(.down, x: mousePositionX, y: mousePositionY, steps: 1)

					accumulatedScrollDeltaY += scrollStep
				} else if accumulatedScrollDeltaY > 0 {
                    connection?.mouseWheel(.up, x: mousePositionX, y: mousePositionY, steps: 1)

					accumulatedScrollDeltaY -= scrollStep
				}
			}

			accumulatedScrollDeltaY = 0
		}
	}
}
#endif
