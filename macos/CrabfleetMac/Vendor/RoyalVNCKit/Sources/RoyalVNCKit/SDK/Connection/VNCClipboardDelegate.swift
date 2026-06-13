#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
@objc(VNCClipboardDelegate)
#endif
@MainActor
public protocol VNCClipboardDelegate: AnyObject {
#if canImport(ObjectiveC)
	@objc
#endif
	func connection(_ connection: VNCConnection, didReceiveClipboardText text: String)
}
