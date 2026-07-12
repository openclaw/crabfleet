#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Dispatch

// MARK: - Delegate Notifications
extension VNCConnection {
	func notifyDelegateAboutConnectionStateChange(_ newConnectionState: ConnectionState) {
		DispatchQueue.main.async { [weak self] in
			guard let self, let delegate = self.delegate else { return }
			delegate.connection(self, stateDidChange: newConnectionState)
		}
	}

	func notifyDelegateAboutFramebufferCreation(_ framebuffer: VNCFramebuffer) {
		DispatchQueue.main.async { [weak self] in
			guard let self, let delegate = self.delegate else { return }
			delegate.connection(self, didCreateFramebuffer: framebuffer)
		}
	}

	func notifyDelegateAboutFramebufferResize(_ framebuffer: VNCFramebuffer) {
		DispatchQueue.main.async { [weak self] in
			guard let self, let delegate = self.delegate else { return }
			delegate.connection(self, didResizeFramebuffer: framebuffer)
		}
	}

	func notifyDelegateAboutFramebuffer(_ framebuffer: VNCFramebuffer,
										updatedRegion: VNCRegion) {
		framebufferDeliveryLock.lock()
		pendingFramebufferDelivery = (framebuffer, framebuffer.fullRegion)
		guard !isFramebufferDeliveryScheduled else {
			framebufferDeliveryLock.unlock()
			return
		}
		isFramebufferDeliveryScheduled = true
		framebufferDeliveryLock.unlock()

		DispatchQueue.main.async { [weak self] in
			guard let self else { return }

			self.framebufferDeliveryLock.lock()
			let pending = self.pendingFramebufferDelivery
			self.pendingFramebufferDelivery = nil
			self.isFramebufferDeliveryScheduled = false
			self.framebufferDeliveryLock.unlock()

			guard let pending, let delegate = self.delegate else { return }
			delegate.connection(
				self,
				didUpdateFramebuffer: pending.framebuffer,
				x: pending.region.x,
				y: pending.region.y,
				width: pending.region.width,
				height: pending.region.height
			)
		}
	}

	func notifyDelegateAboutUpdatedCursor(_ cursor: VNCCursor) {
		DispatchQueue.main.async { [weak self] in
			guard let self, let delegate = self.delegate else { return }
			delegate.connection(self, didUpdateCursor: cursor)
		}
	}

	func notifyClipboardDelegateAboutText(_ text: String) {
		clipboardDeliveryLock.lock()
		pendingClipboardDelivery = text
		guard !isClipboardDeliveryScheduled else {
			clipboardDeliveryLock.unlock()
			return
		}
		isClipboardDeliveryScheduled = true
		clipboardDeliveryLock.unlock()

		DispatchQueue.main.async { [weak self] in
			guard let self else { return }

			self.clipboardDeliveryLock.lock()
			let pending = self.pendingClipboardDelivery
			self.pendingClipboardDelivery = nil
			self.isClipboardDeliveryScheduled = false
			self.clipboardDeliveryLock.unlock()

			guard let pending, let delegate = self.clipboardDelegate else { return }
			delegate.connection(self, didReceiveClipboardText: pending)
		}
	}

	func askDelegateForPasswordCredential(authenticationType: VNCAuthenticationType) async throws -> VNCPasswordCredential {
		guard let passwordCredential = try await askDelegateForCredential(authenticationType: authenticationType) as? VNCPasswordCredential else {
			throw VNCError.authentication(.noAuthenticationDataProvided)
		}

		return passwordCredential
	}

	func askDelegateForUsernamePasswordCredential(authenticationType: VNCAuthenticationType) async throws -> VNCUsernamePasswordCredential {
		guard let usernamePasswordCredential = try await askDelegateForCredential(authenticationType: authenticationType) as? VNCUsernamePasswordCredential else {
			throw VNCError.authentication(.noAuthenticationDataProvided)
		}

		return usernamePasswordCredential
	}

	func delegatePrefersUsernameAuthentication(
		_ authenticationType: VNCAuthenticationType
	) async -> Bool {
		await withCheckedContinuation { continuation in
			DispatchQueue.main.async { [weak self] in
				guard let self, let delegate = self.delegate else {
					continuation.resume(returning: false)
					return
				}
#if canImport(ObjectiveC)
				let prefersUsername = delegate.connection?(
					self,
					prefersUsernameAuthentication: authenticationType
				) ?? false
#else
				let prefersUsername = delegate.connection(
					self,
					prefersUsernameAuthentication: authenticationType
				)
#endif
				continuation.resume(returning: prefersUsername)
			}
		}
	}
}

private extension VNCConnection {
	func askDelegateForCredential(authenticationType: VNCAuthenticationType) async throws -> VNCCredential {
		let requestID = UUID()
		let credential: VNCCredential? = await withTaskCancellationHandler {
			await withCheckedContinuation { continuation in
				guard registerCredentialContinuation(continuation, id: requestID) else {
					continuation.resume(returning: nil)
					return
				}

				if Task.isCancelled {
					cancelPendingCredentialRequest(id: requestID)
					return
				}

				DispatchQueue.main.async { [weak self] in
					guard let self, let delegate = self.delegate else {
						self?.resolveCredentialRequest(id: requestID, credential: nil)
						return
					}

					delegate.connection(self, credentialFor: authenticationType) { [weak self] credential in
						self?.resolveCredentialRequest(id: requestID, credential: credential)
					}
				}
			}
		} onCancel: {
			cancelPendingCredentialRequest(id: requestID)
		}

		guard let credential else {
			throw VNCError.authentication(.noAuthenticationDataProvided)
		}

		return credential
	}
}
