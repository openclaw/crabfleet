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
		let request = beginCredentialRequest(authenticationType: authenticationType)
		let credential = await request.value()

		guard let credential else {
			throw VNCError.authentication(.noAuthenticationDataProvided)
		}

		return credential
	}
}

extension VNCConnection {
	func beginCredentialRequest(authenticationType: VNCAuthenticationType) -> PendingCredentialRequest {
		let requestID = UUID()
		let request = PendingCredentialRequest { [weak self] in
			self?.removeCredentialRequest(id: requestID)
		}
		guard registerCredentialRequest(request, id: requestID) else {
			request.resolve(with: nil)
			return request
		}

		DispatchQueue.main.async { [weak self, request] in
			guard request.pending else { return }
			guard let self, let delegate = self.delegate else {
				request.resolve(with: nil)
				return
			}

			delegate.connection(self, credentialFor: authenticationType) { [request] credential in
				request.resolve(with: credential)
			}
		}
		return request
	}
}
