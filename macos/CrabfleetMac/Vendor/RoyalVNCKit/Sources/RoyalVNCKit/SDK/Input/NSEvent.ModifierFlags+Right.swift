#if os(macOS)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import AppKit

public extension NSEvent.ModifierFlags {
	static var leftShift: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICELSHIFTKEYMASK))
	}

	static var rightShift: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICERSHIFTKEYMASK))
	}

	static var leftControl: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICELCTLKEYMASK))
	}

	static var rightControl: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICERCTLKEYMASK))
	}

	static var leftOption: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICELALTKEYMASK))
	}

	static var rightOption: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICERALTKEYMASK))
	}

	static var leftCommand: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICELCMDKEYMASK))
	}

	static var rightCommand: NSEvent.ModifierFlags {
		.init(rawValue: .init(NX_DEVICERCMDKEYMASK))
	}
}
#endif
