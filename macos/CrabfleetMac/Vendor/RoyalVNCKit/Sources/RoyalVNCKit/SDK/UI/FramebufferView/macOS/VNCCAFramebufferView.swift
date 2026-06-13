#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit
import Carbon
import QuartzCore
import IOSurface
import Metal

@objc(VNCCAFramebufferView)
@MainActor
public final class VNCCAFramebufferView: NSView, VNCFramebufferView {
    @objc
	public private(set) weak var connection: VNCConnection?

    @objc
    public private(set) weak var delegate: VNCConnectionDelegate?

    @objc
	public let settings: VNCConnection.Settings

    @objc
	public var accumulatedScrollDeltaX: CGFloat = 0

    @objc
	public var accumulatedScrollDeltaY: CGFloat = 0

    @objc
	private(set) weak var framebuffer: VNCFramebuffer?

    @objc
	private(set) public var framebufferSize: CGSize

    @objc
	private(set) public var scrollStep: CGFloat = 12

    @objc
	public var currentCursor: NSCursor {
		didSet {
			resetCursorRects()
		}
	}

    @objc
	public var scaleRatio: CGFloat {
		let containerBounds = bounds
		let fbSize = framebufferSize

		guard containerBounds.width > 0,
			  containerBounds.height > 0,
			  fbSize.width > 0,
			  fbSize.height > 0 else {
			return 1
		}

		let targetAspectRatio = containerBounds.width / containerBounds.height
		let fbAspectRatio = fbSize.width / fbSize.height

		let ratio: CGFloat

		if fbAspectRatio >= targetAspectRatio {
			ratio = containerBounds.width / framebufferSize.width
		} else {
			ratio = containerBounds.height / framebufferSize.height
		}

		// Only allow downscaling, no upscaling
		guard ratio < 1 else { return 1 }

		return ratio
	}

    @objc
	public var contentRect: CGRect {
		let containerBounds = bounds
		let scale = scaleRatio

		var rect = CGRect(x: 0, y: 0,
						  width: framebufferSize.width * scale, height: framebufferSize.height * scale)

		if rect.size.width < containerBounds.size.width {
			rect.origin.x = (containerBounds.size.width - rect.size.width) / 2.0
		}

		if rect.size.height < containerBounds.size.height {
			rect.origin.y = (containerBounds.size.height - rect.size.height) / 2.0
		}

		return rect
	}

    @objc
	public var lastModifierFlags: NSEvent.ModifierFlags = [ ]
	private var pressedKeyCodes = Set<UInt32>()

	public override var canBecomeKeyView: Bool { true }
	public override var acceptsFirstResponder: Bool { true }

	private var displayLink: DisplayLink?
	private var trackingArea: NSTrackingArea?
	private var previousHotKeyMode: UnsafeMutableRawPointer?
	private var inputObserverTokens = [NSObjectProtocol]()

    private static let enableMetalRendering = true

    private var isMetalEnabled = false
    private var isMetalActive = false
    private let pixelFormat = MTLPixelFormat.bgra8Unorm

    private var metalDevice: MTLDevice?
    private var commandQueue: MTLCommandQueue?
    private var metalLayer: CAMetalLayer?

    private var ioSurfaceTexture: MTLTexture?
    private var currentIOSurface: IOSurface?
    private var currentIOSurfaceSize: CGSize = .zero

    @objc
	public init(frame frameRect: CGRect,
				framebuffer: VNCFramebuffer,
				connection: VNCConnection,
                connectionDelegate: VNCConnectionDelegate) {
		self.framebufferSize = framebuffer.size.cgSize
		self.framebuffer = framebuffer
		self.connection = connection
        self.settings = connection.settings
        self.currentCursor = VNCCursor.empty.nsCursor
        self.delegate = connectionDelegate

        super.init(frame: frameRect)

        connection.delegate = self

		wantsLayer = true

		guard let layer else {
			fatalError("Framebuffer view failed to get layer")
		}

        // Set some properties that might(!) boost performance a bit
        layer.drawsAsynchronously = true
        layer.isOpaque = true
        layer.masksToBounds = false
        layer.allowsEdgeAntialiasing = false
        layer.backgroundColor = .clear

        if Self.enableMetalRendering,
           let device = MTLCreateSystemDefaultDevice(),
           let commandQueue = device.makeCommandQueue() {
            self.isMetalEnabled = true
            self.metalDevice = device
            self.commandQueue = commandQueue

            let metalLayer = CAMetalLayer()
            metalLayer.device = device
            metalLayer.pixelFormat = pixelFormat
            metalLayer.framebufferOnly = false
            metalLayer.isOpaque = true
            metalLayer.backgroundColor = .clear
            metalLayer.contentsScale = 1
            metalLayer.presentsWithTransaction = false
            metalLayer.allowsNextDrawableTimeout = false

            layer.addSublayer(metalLayer)

            self.metalLayer = metalLayer

            let shouldUseMetal = canUseMetal(for: framebuffer)
            setMetalLayerActive(shouldUseMetal)

            if !shouldUseMetal {
                configureFallbackLayer(layer)
            }
        } else {
            self.isMetalEnabled = false
            self.isMetalActive = false
            self.metalDevice = nil
            self.commandQueue = nil

            configureFallbackLayer(layer)
        }

		frameSizeDidChange(frameRect.size)
	}

	@available(*, unavailable)
	required init?(coder: NSCoder) {
		fatalError("init(coder:) has not been implemented")
	}

	deinit {
		MainActor.assumeIsolated {
			releaseAllInput()
			removeInputObservers()
			removeDisplayLink()
			deregisterHotKeys()
		}
	}

	public override func viewWillMove(toWindow newWindow: NSWindow?) {
		if newWindow !== window {
			releaseAllInput()
			removeInputObservers()
		}
		super.viewWillMove(toWindow: newWindow)
	}

	public override func viewDidMoveToWindow() {
		if window == nil {
			releaseAllInput()
		} else {
			installInputObservers()
		}
		addDisplayLink()
		if window != nil {
			requestRender()
		}
	}

	func removeDisplayLink() {
		guard settings.useDisplayLink else { return }
		guard let oldDisplayLink = self.displayLink else { return }

		oldDisplayLink.delegate = nil
		oldDisplayLink.isEnabled = false

		self.displayLink = nil
	}

	func addDisplayLink() {
		guard settings.useDisplayLink else { return }

		removeDisplayLink()

		guard let window,
			  let screen = window.screen ?? NSScreen.main else {
			return
		}

		guard let displayLink = DisplayLink(screen: screen) else {
			return
		}

		displayLink.delegate = self

		self.displayLink = displayLink

		displayLink.isEnabled = true
	}

	public override func updateTrackingAreas() {
		if let trackingArea {
			removeTrackingArea(trackingArea)
		}

		let newTrackingArea = NSTrackingArea(rect: bounds,
											 options: [ .activeInKeyWindow, .inVisibleRect, .mouseMoved ],
											 owner: self,
											 userInfo: nil)

		self.trackingArea = newTrackingArea
		self.addTrackingArea(newTrackingArea)
	}

	@discardableResult
	public override func becomeFirstResponder() -> Bool {
        if window?.isKeyWindow ?? false {
            registerHotKeys()
        }

        return true
    }

	public override func resignFirstResponder() -> Bool {
		releaseAllInput()
        deregisterHotKeys()

        return true
    }

	public override func resetCursorRects() {
		discardCursorRects()

		addCursorRect(visibleRect, cursor: currentCursor)
	}

	public override var frame: NSRect {
		get {
			super.frame
		}
		set {
			super.frame = newValue

			frameSizeDidChange(newValue.size)
		}
	}

	public override func mouseMoved(with event: NSEvent) { handleMouseMoved(with: event) }

	public override func mouseDown(with event: NSEvent) { handleMouseDown(with: event) }
	public override func mouseDragged(with event: NSEvent) { handleMouseDragged(with: event) }
	public override func mouseUp(with event: NSEvent) { handleMouseUp(with: event) }

	public override func rightMouseDown(with event: NSEvent) { handleRightMouseDown(with: event) }
	public override func rightMouseDragged(with event: NSEvent) { handleRightMouseDragged(with: event) }
	public override func rightMouseUp(with event: NSEvent) { handleRightMouseUp(with: event) }

	public override func otherMouseDown(with event: NSEvent) { handleOtherMouseDown(with: event) }
	public override func otherMouseUp(with event: NSEvent) { handleOtherMouseUp(with: event) }
	public override func otherMouseDragged(with event: NSEvent) { handleOtherMouseDragged(with: event) }

	public override func scrollWheel(with event: NSEvent) { handleScrollWheel(with: event) }

	public override func keyDown(with event: NSEvent) { handleKeyDown(with: event) }
	public override func keyUp(with event: NSEvent) { handleKeyUp(with: event) }
	public override func flagsChanged(with event: NSEvent) { handleFlagsChanged(with: event) }
	public override func performKeyEquivalent(with event: NSEvent) -> Bool { return handlePerformKeyEquivalent(with: event) }
}

// MARK: - Positions
private extension VNCCAFramebufferView {
    struct UInt16Point {
        let x: UInt16
        let y: UInt16

        init(x: UInt16, y: UInt16) {
            self.x = x
            self.y = y
        }

        init(_ point: CGPoint) {
            self.x = .init(point.x)
            self.y = .init(point.y)
        }
    }

    func scaledContentRelativePosition(of event: NSEvent) -> UInt16Point? {
		let viewRelativePosition = viewRelativePosition(of: event)

		let contentRect = contentRect

		guard contentRect.contains(viewRelativePosition) else {
            return nil
        }

		let scaledPosition = CGPoint(x: (viewRelativePosition.x - contentRect.origin.x) / scaleRatio,
									 y: (viewRelativePosition.y - contentRect.origin.y) / scaleRatio)

        let scaledPositionUInt16 = UInt16Point(scaledPosition)

        return scaledPositionUInt16
	}

	func viewRelativePosition(of event: NSEvent) -> CGPoint {
		var position = convert(event.locationInWindow, from: nil)
		position.y = bounds.size.height - position.y

		return position
	}
}

// MARK: - Mouse Input
extension VNCCAFramebufferView {
	func handleMouseMoved(with event: NSEvent) {
		guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

        connection.mouseMove(x: position.x, y: position.y)
	}

	func handleMouseDown(with event: NSEvent) {
		window?.makeFirstResponder(self)
		becomeFirstResponder()

        guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

        connection.mouseButtonDown(.left,
                                   x: position.x, y: position.y)
	}

	func handleMouseDragged(with event: NSEvent) {
        guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

		connection.mouseMove(x: position.x, y: position.y)
	}

	func handleMouseUp(with event: NSEvent) {
		guard let connection else {
            return
        }
		guard let position = scaledContentRelativePosition(of: event) else {
			connection.releaseMouseButton(.left)
			return
		}

        connection.mouseButtonUp(.left,
                                 x: position.x, y: position.y)
	}

	func handleRightMouseDown(with event: NSEvent) {
        guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

        connection.mouseButtonDown(.right,
                                   x: position.x, y: position.y)
	}

	func handleRightMouseDragged(with event: NSEvent) {
        guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

		connection.mouseMove(x: position.x, y: position.y)
	}

	func handleRightMouseUp(with event: NSEvent) {
		guard let connection else {
            return
        }
		guard let position = scaledContentRelativePosition(of: event) else {
			connection.releaseMouseButton(.right)
			return
		}

        connection.mouseButtonUp(.right,
                                 x: position.x, y: position.y)
	}

	func handleOtherMouseDown(with event: NSEvent) {
		guard isMiddleButton(event: event) else { return }

        guard let connection,
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

        connection.mouseButtonDown(.middle,
                                   x: position.x, y: position.y)
	}

	func handleOtherMouseDragged(with event: NSEvent) {
		guard let connection,
              isMiddleButton(event: event),
              let position = scaledContentRelativePosition(of: event) else {
            return
        }

		connection.mouseMove(x: position.x, y: position.y)
	}

	func handleOtherMouseUp(with event: NSEvent) {
		guard let connection,
			  isMiddleButton(event: event) else {
            return
        }
		guard let position = scaledContentRelativePosition(of: event) else {
			connection.releaseMouseButton(.middle)
			return
		}

        connection.mouseButtonUp(.middle,
                                 x: position.x, y: position.y)
	}

	func handleScrollWheel(with event: NSEvent) {
		guard let position = scaledContentRelativePosition(of: event) else { return }

		let scrollDelta = CGPoint(x: event.scrollingDeltaX,
								  y: event.scrollingDeltaY)

		handleScrollWheel(scrollDelta: scrollDelta,
						  hasPreciseScrollingDeltas: event.hasPreciseScrollingDeltas,
                          mousePositionX: position.x,
                          mousePositionY: position.y)
	}

	func isMiddleButton(event: NSEvent) -> Bool {
		let isIt = event.buttonNumber == 2

		return isIt
	}
}

// MARK: - Keyboard Input
extension VNCCAFramebufferView {
	func handleKey(event: NSEvent?) {
		guard let event else { return }

		if event.type == .keyDown {
			handleKeyDown(with: event)
		} else if event.type == .keyUp {
			handleKeyUp(with: event)
		}
	}

	func handleKeyDown(with event: NSEvent?) {
		guard let event,
              let connection else {
			return
		}

		let keyCodes = keyCodesFrom(event: event)

		for keyCode in keyCodes {
			pressedKeyCodes.insert(keyCode.rawValue)
			connection.keyDown(keyCode)
		}
	}

	func handleKeyUp(with event: NSEvent?) {
		guard let event,
              let connection else {
			return
		}

		let keyCodes = keyCodesFrom(event: event)

		for keyCode in keyCodes {
			pressedKeyCodes.remove(keyCode.rawValue)
			connection.keyUp(keyCode)
		}
	}

	func handleFlagsChanged(with event: NSEvent) {
		let currentFlags = event.modifierFlags
		let lastFlags = lastModifierFlags

		let modifiers = KeyboardModifiers(currentFlags: currentFlags,
										  lastFlags: lastFlags)

		lastModifierFlags = currentFlags

		let events = modifiers.events

		for event in events {
			handleKey(event: event)
		}
	}

	func handlePerformKeyEquivalent(with event: NSEvent) -> Bool {
        // swiftlint:disable:next control_statement
		guard (settings.inputMode == .forwardKeyboardShortcutsEvenIfInUseLocally || settings.inputMode == .forwardAllKeyboardShortcutsAndHotKeys),
			  let window,
			  (window.firstResponder == window || window.firstResponder == self) else {
			return false
		}

		let flags = event.modifierFlags

        guard flags.contains(.shift) ||
              flags.contains(.control) ||
              flags.contains(.option) ||
              flags.contains(.command) else {
            return false
        }

		handleKeyDown(with: event)
		handleKeyUp(with: event)

		return true
	}

	func keyCodesFrom(event: NSEvent) -> [VNCKeyCode] {
		let characters = event.charactersIgnoringModifiers
		let keyCode = CGKeyCode(event.keyCode)

		let keys = VNCKeyCode.keyCodesFrom(cgKeyCode: keyCode,
										   characters: characters)

		if keys.isEmpty {
			connection?.logger.logError("Ignoring unconvertable key press (Key Code: \(event.keyCode))")
		}

		return keys
	}

	func releaseAllInput() {
		guard let connection else {
			pressedKeyCodes.removeAll()
			lastModifierFlags = []
			return
		}

		for rawValue in pressedKeyCodes {
			connection.keyUp(VNCKeyCode(rawValue))
		}

		pressedKeyCodes.removeAll()
		lastModifierFlags = []
		connection.releaseAllMouseButtons()
	}

	func installInputObservers() {
		removeInputObservers()
		guard let window else { return }

		let center = NotificationCenter.default
		inputObserverTokens = [
			center.addObserver(
				forName: NSWindow.didResignKeyNotification,
				object: window,
				queue: .main
			) { [weak self] _ in
				MainActor.assumeIsolated {
					self?.releaseAllInput()
				}
			},
			center.addObserver(
				forName: NSApplication.didResignActiveNotification,
				object: NSApp,
				queue: .main
			) { [weak self] _ in
				MainActor.assumeIsolated {
					self?.releaseAllInput()
				}
			},
		]
	}

	func removeInputObservers() {
		let center = NotificationCenter.default
		for token in inputObserverTokens {
			center.removeObserver(token)
		}
		inputObserverTokens.removeAll()
	}
}

// MARK: - Hot Keys
private extension VNCCAFramebufferView {
    func registerHotKeys() {
        guard settings.inputMode == .forwardAllKeyboardShortcutsAndHotKeys else {
            return
        }

        deregisterHotKeys()

        // This requires Accessibilty permissions which can be requested using `VNCAccessibilityUtils`
        self.previousHotKeyMode = PushSymbolicHotKeyMode(.init(kHIHotKeyModeAllDisabled))
    }

    func deregisterHotKeys() {
        if let previousHotKeyMode = previousHotKeyMode {
            PopSymbolicHotKeyMode(previousHotKeyMode)
        }

        self.previousHotKeyMode = nil
    }
}

// MARK: - Rendering
private extension VNCCAFramebufferView {
    func configureFallbackLayer(_ layer: CALayer) {
        layer.contentsScale = 1
        layer.contentsGravity = .center
        layer.contentsFormat = .RGBA8Uint
        layer.minificationFilter = .trilinear
        layer.magnificationFilter = .trilinear
    }

    func canUseMetal(for framebuffer: VNCFramebuffer?) -> Bool {
        guard isMetalEnabled,
              let framebuffer,
              let surface = framebuffer.ioSurface else {
            return false
        }

        let isAligned = self.isSurfaceAligned(surface)

        return isAligned
    }

    func isSurfaceAligned(_ surface: IOSurface) -> Bool {
        let bytesPerRow = surface.bytesPerRow
        let isAligned = bytesPerRow % 16 == 0

        return isAligned
    }

    func setMetalLayerActive(_ isActive: Bool) {
        isMetalActive = isActive
        metalLayer?.isHidden = !isActive
    }

    func updateImage(_ image: CGImage?) {
		guard let layer else { return }
		layer.contents = image
    }

    func requestRender() {
        guard self.isMetalActive else {
            updateImage(self.framebuffer?.cgImage)

            return
        }

        guard self.commandQueue != nil,
              self.metalLayer != nil else {
            return
        }

		renderIOSurface(framebuffer: framebuffer,
						 framebufferSize: framebufferSize)
    }

    func renderIOSurface(framebuffer: VNCFramebuffer?,
                         framebufferSize: CGSize) {
        guard let metalLayer,
              let commandQueue,
              let framebuffer else {
            return
        }

        let width = Int(framebufferSize.width)
        let height = Int(framebufferSize.height)

        guard width > 0,
              height > 0 else {
            return
        }

        guard let ioSurfaceTexture = ensureIOSurfaceTexture(surface: framebuffer.ioSurface,
                                                            size: framebufferSize) else {
			setMetalLayerActive(false)

			if let layer {
				configureFallbackLayer(layer)
				frameSizeDidChange(bounds.size)
			}

			updateImage(framebuffer.cgImage)

            return
        }

        guard let drawable = metalLayer.nextDrawable() else {
            return
        }

        guard let commandBuffer = commandQueue.makeCommandBuffer(),
              let blitEncoder = commandBuffer.makeBlitCommandEncoder() else {
            return
        }

        let zeroOrigin = MTLOrigin(x: 0,
                                   y: 0,
                                   z: 0)

        let sourceSize = MTLSize(width: width,
                                 height: height,
                                 depth: 1)

        blitEncoder.copy(from: ioSurfaceTexture,
                         sourceSlice: 0,
                         sourceLevel: 0,
                         sourceOrigin: zeroOrigin,
                         sourceSize: sourceSize,
                         to: drawable.texture,
                         destinationSlice: 0,
                         destinationLevel: 0,
                         destinationOrigin: zeroOrigin)

        blitEncoder.endEncoding()

        commandBuffer.present(drawable)
        commandBuffer.commit()
    }

    func ensureIOSurfaceTexture(surface: IOSurface?,
                                size: CGSize) -> MTLTexture? {
        guard let surface,
              self.isSurfaceAligned(surface),
              let metalDevice else {
            return nil
        }

        if self.currentIOSurface !== surface ||
            self.currentIOSurfaceSize != size ||
            self.ioSurfaceTexture == nil {
            let width = Int(size.width)
            let height = Int(size.height)

            guard width > 0,
                  height > 0 else {
                return nil
            }

            let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: pixelFormat,
                                                                      width: width,
                                                                      height: height,
                                                                      mipmapped: false)

            descriptor.usage = [ .shaderRead ]
            descriptor.storageMode = .shared

            self.ioSurfaceTexture = metalDevice.makeTexture(descriptor: descriptor,
                                                            iosurface: surface,
                                                            plane: 0)

            self.currentIOSurface = surface
            self.currentIOSurfaceSize = size
        }

        return self.ioSurfaceTexture
    }

    func frameSizeDidChange(_ size: CGSize) {
        if isMetalActive {
            updateMetalLayerLayout()
        } else {
            updateFallbackLayerLayout()
        }
    }

    func updateMetalLayerLayout() {
        guard let metalLayer else {
            return
        }

        let targetFrame: CGRect

        if settings.isScalingEnabled {
            targetFrame = self.contentRect
        } else {
            let origin = CGPoint(x: (bounds.size.width - framebufferSize.width) / 2.0,
                                 y: (bounds.size.height - framebufferSize.height) / 2.0)

            targetFrame = CGRect(origin: origin,
                                 size: framebufferSize)
        }

        CATransaction.begin()
        CATransaction.setDisableActions(true)

        metalLayer.frame = targetFrame
        metalLayer.drawableSize = framebufferSize

        CATransaction.commit()
    }

    func updateFallbackLayerLayout() {
        guard settings.isScalingEnabled,
              let layer else {
            return
        }

        if frameSizeExceedsFramebufferSize(bounds.size) {
            layer.contentsGravity = .center
        } else {
            layer.contentsGravity = .resizeAspect
        }
    }
}

extension VNCCAFramebufferView: DisplayLinkDelegate {
	func displayLinkDidUpdate(_ displayLink: DisplayLink) {
		requestRender()
	}
}

extension VNCCAFramebufferView: VNCConnectionDelegate {
    // Handle directly
    public func connection(
        _ connection: VNCConnection,
        didUpdateFramebuffer framebuffer: VNCFramebuffer,
        x: UInt16,
        y: UInt16,
        width: UInt16,
        height: UInt16
    ) {
        // NOTE: If we ever take the updatedRegion into consideration, we will likely need to flip the coordinates on macOS

        guard !settings.useDisplayLink,
              displayLink == nil else {
            return
        }

        requestRender()
    }

    // Handle directly
    public func connection(
        _ connection: VNCConnection,
        didUpdateCursor cursor: VNCCursor
    ) {
        DispatchQueue.main.async { [weak self] in
            self?.currentCursor = cursor.nsCursor
        }
    }

    // Passthrough
    public func connection(
        _ connection: VNCConnection,
        stateDidChange connectionState: VNCConnection.ConnectionState
    ) {
        guard let delegate else {
            return
        }

        delegate.connection(
            connection,
            stateDidChange: connectionState
        )
    }

    // Passthrough
    public func connection(
        _ connection: VNCConnection,
        credentialFor authenticationType: VNCAuthenticationType,
        completion: @escaping ((any VNCCredential)?) -> Void
    ) {
        guard let delegate else {
            completion(nil)

            return
        }

        delegate.connection(
            connection,
            credentialFor: authenticationType,
            completion: completion
        )
    }

    // Passthrough
    public func connection(
        _ connection: VNCConnection,
        didCreateFramebuffer framebuffer: VNCFramebuffer
    ) {
        guard let delegate else {
            return
        }

        delegate.connection(
            connection,
            didCreateFramebuffer: framebuffer
        )
    }

    // Passthrough
    public func connection(
        _ connection: VNCConnection,
        didResizeFramebuffer framebuffer: VNCFramebuffer
    ) {
        guard let delegate else {
            return
        }

        delegate.connection(
            connection,
            didResizeFramebuffer: framebuffer
        )
    }
}
#endif
