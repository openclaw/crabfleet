#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

#if canImport(ObjectiveC)
import ObjectiveC
#endif

#if canImport(ObjectiveC)
public typealias NSObjectOrAnyObject = NSObject
#else
public typealias NSObjectOrAnyObject = BaseType

public class BaseType {
    init() {

    }
}
#endif
