#if canImport(Network)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Dispatch
import Network

extension NWConnection: NetworkConnection {
    convenience init(settings: NetworkConnectionSettings) {
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.connectionTimeout = settings.connectionTimeout

        let connectionParameters = NWParameters(tls: nil,
                                                tcp: tcpOptions)

        connectionParameters.expiredDNSBehavior = .allow
        connectionParameters.serviceClass = .interactiveVideo

        self.init(host: .init(settings.host),
                  port: .init(rawValue: settings.port)!,
                  using: connectionParameters)
    }

    var status: NetworkConnectionStatus {
        switch state {
        case .setup: .setup
        case .waiting(let error): .waiting(error)
        case .preparing: .preparing
        case .ready: .ready
        case .failed(let error): .failed(error)
        case .cancelled: .cancelled

        @unknown default:
            .unknown(self)
        }
    }

    func setStatusUpdateHandler(_ statusUpdateHandler: NetworkConnectionStatusUpdateHandler?) {
        guard let statusUpdateHandler else {
            stateUpdateHandler = nil

            return
        }

        stateUpdateHandler = { state in
            switch state {
            case .setup:
                statusUpdateHandler(.setup)
            case .waiting(let error):
                statusUpdateHandler(.waiting(error))
            case .preparing:
                statusUpdateHandler(.preparing)
            case .ready:
                statusUpdateHandler(.ready)
            case .failed(let error):
                statusUpdateHandler(.failed(error))
            case .cancelled:
                statusUpdateHandler(.cancelled)

            @unknown default:
                statusUpdateHandler(.unknown(self))
            }
        }
    }

    var isReady: Bool {
        state == .ready
    }
}

extension NWConnection: NetworkConnectionReading {
	func read(minimumLength: Int,
              maximumLength: Int) async throws -> Data {
		return try await withCheckedThrowingContinuation { continuation in
			receive(minimumIncompleteLength: minimumLength, maximumLength: maximumLength) { content, _, isComplete, error in
				guard !isComplete else {
					continuation.resume(throwing: VNCError.connection(.closed))

					return
				}

				guard error == nil else {
					continuation.resume(throwing: error!)

					return
				}

				guard let content else {
					continuation.resume(throwing: VNCError.protocol(.noData))

					return
				}

				let receivedLength = content.count

				guard receivedLength >= minimumLength,
					  receivedLength <= maximumLength else {
					continuation.resume(throwing: VNCError.protocol(.invalidData))

					return
				}

				continuation.resume(returning: content)
			}
		}
	}
}

extension NWConnection: NetworkConnectionWriting {
	func write(data: Data) async throws {
		return try await withCheckedThrowingContinuation { continuation in
			send(content: data, completion: .contentProcessed({ error in
				if let error = error {
					continuation.resume(throwing: error)
				} else {
					continuation.resume()
				}
			}))
		}
	}
}
#endif
