#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

// MARK: - Server to Client Messages
extension VNCConnection {
	func startReceiveLoop() {
        logger.logDebug("Starting receive loop")

        receiveTask = Task(priority: taskPriority) {
			while !state.disconnectRequested,
                  connection.isReady {
				do {
					try await receive()
				} catch {
					handleBreakingError(error)
				}
			}
		}
	}
}

private extension VNCConnection {
	func receive() async throws {
		guard !state.disconnectRequested else {
			// Just ignore, since disconnect has already been requested
			return
		}

        guard connection.isReady else {
			throw VNCError.connection(.notReady)
		}

		let serverToClientMessage = try await VNCProtocol.ServerToClientMessage.receive(connection: connection)

		try await didReceive(messageType: serverToClientMessage.messageType)
	}

	func didReceive(messageType: UInt8) async throws {
		switch messageType {
			case VNCProtocol.FramebufferUpdate.messageType:
				try await handleFramebufferUpdateMessage()

			case VNCProtocol.SetColourMapEntries.messageType:
				try await handleSetColourMapEntriesMessage()

			case VNCProtocol.ServerCutText.messageType:
				try await handleServerCutTextMessage()

			case VNCProtocol.Bell.messageType:
				try await handleBellMessage()

			case VNCProtocol.EndOfContinuousUpdates.messageType:
				try await handleEndOfContinuousUpdatesMessage()

			case VNCProtocol.ServerFence.messageType:
				try await handleServerFenceMessage()

			case VNCProtocol.CrabfleetAudio.messageType:
				try await handleCrabfleetAudioMessage()

			default:
				throw VNCError.protocol(.unsupportedServerToClientMessage(messageType: messageType))
		}
	}

	func handleFramebufferUpdateMessage() async throws {
		guard let framebuffer = framebuffer else {
			throw VNCError.protocol(.framebufferUpdateReceivedWithoutFramebuffer)
		}

		logger.logDebug("Receiving Framebuffer Update")

		let framebufferUpdate = try await VNCProtocol.FramebufferUpdate.receive(connection: connection,
																				framebuffer: framebuffer,
																				encodings: encodings,
																				logger: logger)

		logger.logDebug("Received Framebuffer Update: \(framebufferUpdate)")
		completeFramebufferUpdateRequest()

		/*
		// Write out the framebuffer for testing purposes
		try framebuffer.writeSurface()
		*/

		scheduleNextFramebufferUpdate()
	}

	func handleSetColourMapEntriesMessage() async throws {
		guard let framebuffer = framebuffer else {
			throw VNCError.protocol(.setColourMapEntriesReceivedWithoutFramebuffer)
		}

		logger.logDebug("Receiving Colour Map Entries")

		let colourMapEntries = try await VNCProtocol.SetColourMapEntries.receive(connection: connection,
																				 logger: logger)

		logger.logDebug("Received Colour Map Entries")

		framebuffer.updateColorMap(colourMapEntries)
	}

	func handleServerCutTextMessage() async throws {
		logger.logDebug("Receiving Clipboard Text from Server")

		let serverCutText = try await VNCProtocol.ServerCutText.receive(connection: connection,
																		logger: logger)

		logger.logDebug("Received Clipboard Text from Server")

		if let extended = serverCutText.extended {
			await handleExtendedClipboardMessage(extended)

			return
		}

		// A malformed extended body is dropped, not treated as empty legacy text.
		guard !serverCutText.isExtended else { return }

		await deliverServerClipboardText(serverCutText.text)
	}

	func handleExtendedClipboardMessage(_ message: VNCExtendedClipboardMessage) async {
		guard settings.clipboardMode != .disabled else { return }

		switch message {
			case .caps(let caps):
				state.extendedClipboardServerCaps = caps

				// Announce the text format plus every action so servers may
				// push provide messages without a notify/request round trip.
				let capsBody = VNCExtendedClipboard.encodeCaps(
					maximumUnsolicitedTextBytes: UInt32(VNCProtocolLimits.maximumClipboardBytes)
				)

				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(body: capsBody))

			case .notify(let hasText):
				guard hasText else { return }

				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(
					body: VNCExtendedClipboard.encodeRequestText()
				))

			case .provide(let text):
				guard let text else { return }

				await deliverServerClipboardText(text)

			case .request(let wantsText):
				guard wantsText else { return }

				let text = state.lastExtendedClipboardText ?? ""

				guard let body = try? VNCExtendedClipboard.encodeProvide(text: text) else {
					return
				}

				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(body: body))

			case .peek:
				enqueueClientToServerMessage(VNCProtocol.ExtendedClientCutText(
					body: VNCExtendedClipboard.encodeNotify(
						hasText: state.lastExtendedClipboardText != nil
					)
				))
		}
	}

	func deliverServerClipboardText(_ text: String) async {
		switch settings.clipboardMode {
			case .disabled:
				return

			case .systemPasteboard:
				await MainActor.run {
					clipboard.text = text
					clipboardMonitor.markCurrentChangeAsObserved()
				}

			case .externallyManaged:
				notifyClipboardDelegateAboutText(text)
		}
	}

	func handleBellMessage() async throws {
		logger.logDebug("Receiving Bell Message from Server")

		_ = try await VNCProtocol.Bell.receive(connection: connection,
											   logger: logger)

		logger.logDebug("Received Bell Message from Server")

		systemSound.play()
	}

	func handleEndOfContinuousUpdatesMessage() async throws {
		didReceiveEndOfContinuousUpdates()
	}

	func handleServerFenceMessage() async throws {
		let fence = try await VNCProtocol.ServerFence.receive(connection: connection)
		try handleServerFence(fence)
	}

	func handleCrabfleetAudioMessage() async throws {
		let message = try await VNCProtocol.CrabfleetAudio.receive(connection: connection).message
		await notifyAudioDelegateAboutMessage(message)
	}
}

extension VNCConnection {
	func handleServerFence(_ fence: VNCProtocol.ServerFence) throws {
		let first = publishPixelFormatFenceSupport()

		if fence.flags.contains(.request) {
			let responseFlags = fence.flags.intersection(.blockBefore)
			enqueueClientToServerMessage(
				VNCProtocol.ClientFence(flags: responseFlags, payload: fence.payload)
			)
		} else {
			try completePixelFormatFence(fence)
		}

		if first {
			logger.logDebug("Fence supported (server sent ServerFence)")
			enqueuePixelFormatFenceSupportProbe()
		}
	}

	func didReceiveEndOfContinuousUpdates() {
		let first = !state.areContinuousUpdatesSupported

		state.areContinuousUpdatesSupported = true

		if first {
			logger.logDebug("Continuous Updates supported (server sent EndOfContinuousUpdates)")
			return
		}

		state.areContinuousUpdatesEnabled = false
		logger.logDebug("Disabling Continuous Updates")
		scheduleNextFramebufferUpdate()
	}
}
