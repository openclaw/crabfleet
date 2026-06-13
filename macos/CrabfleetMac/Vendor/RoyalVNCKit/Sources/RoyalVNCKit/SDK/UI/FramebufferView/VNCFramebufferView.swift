#if os(macOS) || os(iOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCFramebufferView)
#endif
@MainActor
public protocol VNCFramebufferView: AnyObject {
#if canImport(ObjectiveC)
    @objc
#endif
	var framebufferSize: CGSize { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var connection: VNCConnection? { get }

#if canImport(ObjectiveC)
    @objc
#endif
    weak var delegate: VNCConnectionDelegate? { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var settings: VNCConnection.Settings { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var scaleRatio: CGFloat { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var contentRect: CGRect { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var scrollStep: CGFloat { get }

#if canImport(ObjectiveC)
    @objc
#endif
	var accumulatedScrollDeltaX: CGFloat { get set }

#if canImport(ObjectiveC)
    @objc
#endif
	var accumulatedScrollDeltaY: CGFloat { get set }

    // MARK: - Connection Delegate Handlers
#if canImport(ObjectiveC)
    @objc
#endif
    func connection(_ connection: VNCConnection,
                    didUpdateFramebuffer framebuffer: VNCFramebuffer,
                    x: UInt16, y: UInt16,
                    width: UInt16, height: UInt16)

#if canImport(ObjectiveC)
    @objc
#endif
	func connection(_ connection: VNCConnection,
					didUpdateCursor cursor: VNCCursor)

#if canImport(ObjectiveC)
    @objc
#endif
    func connection(_ connection: VNCConnection,
                    stateDidChange connectionState: VNCConnection.ConnectionState)

#if canImport(ObjectiveC)
    @objc
#endif
    func connection(_ connection: VNCConnection,
                    credentialFor authenticationType: VNCAuthenticationType,
                    completion: @escaping ((any VNCCredential)?) -> Void)

#if canImport(ObjectiveC)
    @objc
#endif
    func connection(_ connection: VNCConnection,
                    didCreateFramebuffer framebuffer: VNCFramebuffer)

#if canImport(ObjectiveC)
    @objc
#endif
    func connection(_ connection: VNCConnection,
                    didResizeFramebuffer framebuffer: VNCFramebuffer)
}
#endif
