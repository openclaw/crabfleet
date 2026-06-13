#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

protocol VNCSecurityType {
	static var authenticationType: VNCAuthenticationType { get }
	var authenticationType: VNCAuthenticationType { get }
}
