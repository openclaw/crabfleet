#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension UnsafeMutableRawPointer {
    static func retainedPointerFrom<T: AnyObject>(_ target: T) -> Self {
        pointerFrom(target,
                    retain: true)
    }

    static func unretainedPointerFrom<T: AnyObject>(_ target: T) -> Self {
        pointerFrom(target,
                    retain: false)
    }

    func autorelease<T: AnyObject>(_ targetType: T.Type) {
        let _: T = retainedInstance()
    }

    func retainedInstance<T: AnyObject>() -> T {
        instance(retain: true)
    }

    func unretainedInstance<T: AnyObject>() -> T {
        instance(retain: false)
    }
}

private extension UnsafeMutableRawPointer {
    static func pointerFrom<T: AnyObject>(_ target: T,
                                          retain: Bool) -> Self {
        let targetUnmanaged: Unmanaged<T>

        if retain {
            targetUnmanaged = .passRetained(target)
        } else {
            targetUnmanaged = .passUnretained(target)
        }

        let targetOpaque = targetUnmanaged.toOpaque()

        return targetOpaque
    }

    func instance<T: AnyObject>(retain: Bool) -> T {
        let unmanaged = Unmanaged<T>.fromOpaque(self)

        let inst: T

        if retain {
            inst = unmanaged.takeRetainedValue()
        } else {
            inst = unmanaged.takeUnretainedValue()
        }

        return inst
    }
}
