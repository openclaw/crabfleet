#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Dispatch

#if canImport(Network)
import Network
#endif

#if canImport(ObjectiveC)
@objc(VNCConnection)
#endif
public final class VNCConnection: NSObjectOrAnyObject, @unchecked Sendable {
	// MARK: - Public Properties
#if canImport(ObjectiveC)
	@objc
#endif
	public let settings: Settings

    public let context: UnsafeMutableRawPointer?

#if canImport(ObjectiveC)
	@objc
#endif
	public var delegate: VNCConnectionDelegate? {
		get {
			delegateLock.lock()
			defer { delegateLock.unlock() }
			return _delegate
		}
		set {
			delegateLock.lock()
			defer { delegateLock.unlock() }
			_delegate = newValue
		}
	}

	public var clipboardDelegate: VNCClipboardDelegate? {
		get {
			clipboardDelegateLock.lock()
			defer { clipboardDelegateLock.unlock() }
			return _clipboardDelegate
		}
		set {
			clipboardDelegateLock.lock()
			defer { clipboardDelegateLock.unlock() }
			_clipboardDelegate = newValue
		}
	}

#if canImport(ObjectiveC)
	@objc
#endif
	public var framebuffer: VNCFramebuffer? {
		get {
			framebufferLock.lock()
			defer { framebufferLock.unlock() }
			return _framebuffer
		}
		set {
			framebufferLock.lock()
			defer { framebufferLock.unlock() }
			_framebuffer = newValue
		}
	}

#if canImport(ObjectiveC)
	@objc
#endif
	private let connectionStateLock = NSLock()
	private var _connectionState = ConnectionState.disconnected
	public internal(set) var connectionState: ConnectionState {
		get {
			connectionStateLock.lock()
			defer { connectionStateLock.unlock() }
			return _connectionState
		}
		set {
			connectionStateLock.lock()
			defer { connectionStateLock.unlock() }
			_connectionState = newValue
		}
	}

#if canImport(ObjectiveC)
	@objc
#endif
	public let logger: VNCLogger

    public let framebufferAllocator: VNCFramebufferAllocator?

	// MARK: - Private Properties
	private let delegateLock = NSLock()
	private weak var _delegate: VNCConnectionDelegate?
	private let clipboardDelegateLock = NSLock()
	private weak var _clipboardDelegate: VNCClipboardDelegate?
	private let framebufferLock = NSLock()
	private var _framebuffer: VNCFramebuffer?
	let framebufferDeliveryLock = NSLock()
	var pendingFramebufferDelivery: (framebuffer: VNCFramebuffer, region: VNCRegion)?
	var isFramebufferDeliveryScheduled = false
	let clipboardDeliveryLock = NSLock()
	var pendingClipboardDelivery: String?
	var isClipboardDeliveryScheduled = false
	let framebufferRequestLock = NSLock()
	var _framebufferUpdatePolicy: VNCFramebufferUpdatePolicy = .interactive
	var framebufferRequestGeneration: UInt64 = 0
	var framebufferUpdateRequestOutstanding = false
	var framebufferPacingTask: Task<Void, Never>?
	var pendingPixelFormatTransition: VNCProtocol.PixelFormat?
	var isPixelFormatTransitionInFlight = false
	private let queue = DispatchQueue(label: "com.royalapps.royalvnc.connectionqueue",
									  attributes: .concurrent)
	private let lifecycleLock = NSRecursiveLock()
	private let credentialContinuationLock = NSLock()
	private var pendingCredentialContinuations = [
		UUID: CheckedContinuation<VNCCredential?, Never>
	]()

	private let sharedZStream: ZlibStream
    private let sharedZRLEZStream: ZlibStream

	// MARK: - Internal Properties
    let taskPriority = TaskPriority.high

	var receiveTask: Task<(), Error>?
	var sendTask: Task<(), Error>?
	var handshakeTask: Task<Void, Never>?

	let maxSupportedProtocolVersion = VNCProtocol.ProtocolVersion(majorVersion: 3,
																  minorVersion: 8)

	let state = State()
	let systemSound = VNCSystemSound()

	let clipboard: VNCClipboard
	let clipboardMonitor: VNCClipboardMonitor

	struct QueuedClientMessage {
		let message: VNCSendableMessage
		let isCoalescible: Bool
	}

	let clientToServerMessageQueue = Queue<QueuedClientMessage>()

	let inputStateLock = NSLock()
    var mouseButtonState: VNCProtocol.MousePointerButton = [ ]
    var lastMousePosition = VNCProtocol.MousePosition(x: 0, y: 0)

    lazy var connection: some NetworkConnection = {
        let connectionSettings = NetworkConnectionSettings(connectionTimeout: 15,
                                                           host: settings.hostname,
                                                           port: settings.port)

        // NOTE: To test SocketNetworkConnection on Darwin (macOS, iOS, etc.), comment out the the #if
#if canImport(Network)
        let connection = NWConnection(settings: connectionSettings)
#else
		let connection = SocketNetworkConnection(settings: connectionSettings)
#endif

        connection.setStatusUpdateHandler(connectionStatusDidChange)

		return connection
	}()

	lazy var encodings: Encodings = {
		let rawEncoding = VNCProtocol.RawEncoding()
		let hextileEncoding = VNCProtocol.HextileEncoding(rawEncoding: rawEncoding)

		let compressionLevelEncodingType = VNCPseudoEncodingType.compressionLevel6.rawValue
		let compressionLevelEncoding = VNCProtocol.CompressionLevelEncoding(encodingType: compressionLevelEncodingType)

		let jpegQualityLevelEncodingType = VNCPseudoEncodingType.jpegQualityLevel6.rawValue
		let jpegQualityLevelEncoding = VNCProtocol.JPEGQualityLevelEncoding(encodingType: jpegQualityLevelEncodingType)

		var encs: Encodings = [
			// Frame Encodings
			VNCFrameEncodingType.copyRect.rawValue: VNCProtocol.CopyRectEncoding(),
            VNCFrameEncodingType.tight.rawValue: VNCProtocol.TightEncoding(),
            VNCFrameEncodingType.zlib.rawValue: VNCProtocol.ZlibEncoding(zStream: sharedZStream),
			VNCFrameEncodingType.zrle.rawValue: VNCProtocol.ZRLEEncoding(zStream: sharedZRLEZStream),
			VNCFrameEncodingType.hextile.rawValue: hextileEncoding,
			VNCFrameEncodingType.coRRE.rawValue: VNCProtocol.CoRREEncoding(),
			VNCFrameEncodingType.rre.rawValue: VNCProtocol.RREEncoding(),
			VNCFrameEncodingType.raw.rawValue: rawEncoding,

			// Pseudo Encodings
			VNCPseudoEncodingType.lastRect.rawValue: VNCProtocol.LastRectEncoding(),
			VNCPseudoEncodingType.continuousUpdates.rawValue: VNCProtocol.ContinuousUpdatesEncoding(),
			VNCPseudoEncodingType.extendedDesktopSize.rawValue: VNCProtocol.ExtendedDesktopSizeEncoding(),
			VNCPseudoEncodingType.desktopSize.rawValue: VNCProtocol.DesktopSizeEncoding(),
			VNCPseudoEncodingType.desktopName.rawValue: VNCProtocol.DesktopNameEncoding(),
			VNCPseudoEncodingType.cursor.rawValue: VNCProtocol.CursorEncoding(),
			compressionLevelEncodingType: compressionLevelEncoding,
			jpegQualityLevelEncodingType: jpegQualityLevelEncoding
		]
#if canImport(VideoToolbox)
		encs[VNCFrameEncodingType.openH264.rawValue] = VNCProtocol.OpenH264Encoding()
#endif
		let requestedFrameEncodings = Set(settings.frameEncodings.map(\.rawValue))
		let mandatoryFrameEncodings: Set<VNCEncodingType> = [
			VNCFrameEncodingType.raw.rawValue,
			VNCFrameEncodingType.copyRect.rawValue,
		]
		let enabledEncodings = encs.filter { encodingType, encoding in
			!(encoding is VNCFrameEncoding)
				|| mandatoryFrameEncodings.contains(encodingType)
				|| requestedFrameEncodings.contains(encodingType)
		}

		// Sanity Check
		do {
			let encodingTypes = enabledEncodings.values.map({ $0.encodingType })

			try encodingTypes.validate()
		} catch {
            // If the sanity check fails here, it's a programming error
			fatalError(error.debugDescription)
		}

		return enabledEncodings
	}()

	func orderedEncodingTypes() throws -> [VNCEncodingType] {
		// Frame Encodings (Required)
		var encs: [VNCEncodingType] = [
			VNCFrameEncodingType.copyRect.rawValue
		]

		// Frame Encodings (Customizable)
		var customizedFrameEncodings = settings.frameEncodings.map({ $0.rawValue })

		// TODO: Remove once we support ZRLE for non-24-bit pixel formats
		if let pixelFormat = state.pixelFormat,
		   customizedFrameEncodings.contains(VNCFrameEncodingType.zrle.rawValue),
		   !VNCProtocol.ZRLEEncoding.supportsPixelFormat(pixelFormat) {
			customizedFrameEncodings.removeAll(where: { $0 == VNCFrameEncodingType.zrle.rawValue })
		}

		if let pixelFormat = state.pixelFormat,
		   customizedFrameEncodings.contains(VNCFrameEncodingType.tight.rawValue),
		   !VNCProtocol.TightEncoding.supportsPixelFormat(pixelFormat) {
			customizedFrameEncodings.removeAll(where: { $0 == VNCFrameEncodingType.tight.rawValue })
		}

#if canImport(VideoToolbox)
		if let pixelFormat = state.pixelFormat,
		   customizedFrameEncodings.contains(VNCFrameEncodingType.openH264.rawValue),
		   !VNCProtocol.OpenH264Encoding.supportsPixelFormat(pixelFormat) {
			customizedFrameEncodings.removeAll(where: { $0 == VNCFrameEncodingType.openH264.rawValue })
		}
#else
		customizedFrameEncodings.removeAll(where: { $0 == VNCFrameEncodingType.openH264.rawValue })
#endif

		let usesTightEncoding = customizedFrameEncodings.contains(VNCFrameEncodingType.tight.rawValue)

		encs.append(contentsOf: customizedFrameEncodings)

		// Frame Encodings (Required)
		encs.append(VNCFrameEncodingType.raw.rawValue)

		// Pseudo Encodings
		encs.append(contentsOf: [
			VNCPseudoEncodingType.lastRect.rawValue,
			VNCPseudoEncodingType.continuousUpdates.rawValue,
			VNCPseudoEncodingType.extendedDesktopSize.rawValue,
			VNCPseudoEncodingType.desktopSize.rawValue,
			VNCPseudoEncodingType.desktopName.rawValue,
			VNCPseudoEncodingType.cursor.rawValue,

            // TODO: Make configurable
			VNCPseudoEncodingType.compressionLevel6.rawValue
		])

		if settings.clipboardMode != .disabled {
			encs.append(VNCPseudoEncodingType.extendedClipboard.rawValue)
		}

		if usesTightEncoding {
            // TODO: Make configurable
			encs.append(VNCPseudoEncodingType.jpegQualityLevel6.rawValue)
		}

		let uniqueEncs = encs.uniqued()

		// Sanity Check
        // If the sanity check fails here, it could be a programming error, but it could also be an error by the SDK user if he/she specified encodings with invalid values in settings. So we bubble the error up but don't crash.
		try uniqueEncs.validate()

		return uniqueEncs
	}

	// MARK: - Public Initializers
    public init(settings: Settings,
                logger: VNCLogger,
                framebufferAllocator: VNCFramebufferAllocator?,
                context: UnsafeMutableRawPointer?) {
        self.settings = settings

        logger.isDebugLoggingEnabled = settings.isDebugLoggingEnabled

        self.logger = logger
        self.context = context

        self.sharedZStream = .init()
        self.sharedZRLEZStream = .init()

        let clipboard = VNCClipboard()

        let clipboardMonitor = VNCClipboardMonitor(clipboard: clipboard,
                                                   monitoringInterval: 0.5,
                                                   tolerance: 0.15)

        self.clipboard = clipboard
        self.clipboardMonitor = clipboardMonitor
        self.framebufferAllocator = framebufferAllocator

        super.init()

        self.clipboardMonitor.delegate = self
    }

#if canImport(ObjectiveC)
	@objc
#endif
    public convenience init(settings: Settings,
                            logger: VNCLogger) {
        self.init(settings: settings,
                  logger: logger,
                  framebufferAllocator: nil,
                  context: nil)
	}

#if canImport(ObjectiveC)
	@objc
#endif
	public convenience init(settings: Settings) {
        self.init(settings: settings,
                  context: nil)
	}

    public convenience init(settings: Settings,
                            framebufferAllocator: VNCFramebufferAllocator?) {
        self.init(settings: settings,
                  framebufferAllocator: framebufferAllocator,
                  context: nil)
    }

    public convenience init(settings: Settings,
                            framebufferAllocator: VNCFramebufferAllocator?,
                            context: UnsafeMutableRawPointer?) {
#if canImport(OSLog)
        let logger = VNCOSLogLogger()
#else
        let logger = VNCPrintLogger()
#endif

        self.init(settings: settings,
                  logger: logger,
                  framebufferAllocator: framebufferAllocator,
                  context: context)
    }

    public convenience init(settings: Settings,
                            context: UnsafeMutableRawPointer?) {
        self.init(settings: settings,
                  framebufferAllocator: nil,
                  context: context)
    }

	deinit {
		let _self = self

		_self.cancelPendingCredentialRequests()
		_self.clipboardMonitor.delegate = nil
		_self.clipboardDelegate = nil

		stopMonitoringClipboard()
	}
}

// MARK: - Internal Connection State API
extension VNCConnection {
	@discardableResult
	func beginConnecting() -> Bool {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }
		guard !state.disconnectRequested,
			  connectionState.status == .disconnected else {
			return false
		}

		updateConnectionState(.connecting)

		connection.start(queue: queue)
		return true
	}

	func beginDisconnecting(error: Error? = nil) {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }
		guard state.requestDisconnect() else { return }

		updateConnectionState(.disconnecting)
		handshakeTask?.cancel()
		handshakeTask = nil
		cancelPendingCredentialRequests()
		receiveTask?.cancel()
		receiveTask = nil
		sendTask?.cancel()
		sendTask = nil
		clientToServerMessageQueue.finish()
		cancelFramebufferUpdateScheduling()

		connection.setStatusUpdateHandler(nil)
		connection.cancel()

		if let error = error {
			updateConnectionState(.disconnected(error: error))
		} else {
			updateConnectionState(.disconnected)
		}
	}

	func handleBreakingError(_ error: Error) {
		beginDisconnecting(error: error)
	}

	func withLifecycleLock<T>(_ operation: () -> T) -> T {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }
		return operation()
	}

	func registerCredentialContinuation(
		_ continuation: CheckedContinuation<VNCCredential?, Never>,
		id: UUID
	) -> Bool {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }

		guard !state.disconnectRequested else {
			return false
		}

		credentialContinuationLock.lock()
		defer { credentialContinuationLock.unlock() }

		pendingCredentialContinuations[id] = continuation
		return true
	}

	func resolveCredentialRequest(id: UUID, credential: VNCCredential?) {
		credentialContinuationLock.lock()
		let continuation = pendingCredentialContinuations.removeValue(forKey: id)
		credentialContinuationLock.unlock()

		continuation?.resume(returning: credential)
	}

	func cancelPendingCredentialRequest(id: UUID) {
		resolveCredentialRequest(id: id, credential: nil)
	}

	func cancelPendingCredentialRequests() {
		credentialContinuationLock.lock()
		let continuations = Array(pendingCredentialContinuations.values)
		pendingCredentialContinuations.removeAll()
		credentialContinuationLock.unlock()

		for continuation in continuations {
			continuation.resume(returning: nil)
		}
	}

	func updateConnectionState(_ newConnectionState: ConnectionState) {
		self.connectionState = newConnectionState

		switch newConnectionState.status {
			case .connecting:
				break

			case .connected:
				startMonitoringClipboard()

			case .disconnecting:
				stopMonitoringClipboard()

			case .disconnected:
				stopMonitoringClipboard()
		}

		notifyDelegateAboutConnectionStateChange(newConnectionState)
	}
}

// MARK: - Connection State Change Handling
private extension VNCConnection {
	func connectionStatusDidChange(_ newState: NetworkConnectionStatus) {
		switch newState {
			case .setup:
				logger.logDebug("Connection State - Setup")

			case .preparing:
				logger.logDebug("Connection State - Preparing")

			case .ready:
				logger.logDebug("Connection State - Ready")

				connectionDidBecomeReady()

			case .waiting(let error):
				logger.logDebug("Connection State - Waiting with error: \(error)")

				connectionDidFail(error: .connection(.failed(error)))

			case .failed(let error):
				logger.logDebug("Connection State - Failed with error: \(error)")

				connectionDidFail(error: .connection(.failed(error)))

			case .cancelled:
				logger.logDebug("Connection State - Cancelled")

				connectionDidFail(error: .connection(.cancelled))

            case .unknown(let underlyingState):
				logger.logDebug("Connection State - Unknown (\(underlyingState))")
		}
	}

	func connectionDidBecomeReady() {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }
		guard !state.disconnectRequested else { return }

		handshakeTask?.cancel()
		handshakeTask = Task { [weak self] in
			guard let self else { return }

			do {
				try await handshake()
				try await sendFramebufferUpdateRequest()
			} catch {
				handleBreakingError(error)

                return
			}

			finishConnectingAfterHandshake()
		}
	}

	func connectionDidFail(error: VNCError) {
		handleBreakingError(error)
	}
}

extension VNCConnection {
	func finishConnectingAfterHandshake() {
		lifecycleLock.lock()
		defer { lifecycleLock.unlock() }

		guard !Task.isCancelled,
			  !state.disconnectRequested,
			  connection.isReady else {
			return
		}

		handshakeTask = nil
		updateConnectionState(.connected)
		startReceiveLoop()
		startSendLoop()
	}
}
