#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCFramebuffer {
	struct ColorMap {
		let colors: [LocalPixel?]

		init(entries: VNCProtocol.SetColourMapEntries, existing: Self? = nil) {
			var colors = existing?.colors ?? []
			let firstColour = Int(entries.firstColour)
			let endIndex = min(firstColour + entries.colors.count, 65_536)
			if colors.count < endIndex {
				colors.append(contentsOf: repeatElement(nil, count: endIndex - colors.count))
			}

			for (offset, entry) in entries.colors.prefix(endIndex - firstColour).enumerated() {
				let localPixel = LocalPixel(red: entry.redUInt8,
											green: entry.greenUInt8,
											blue: entry.blueUInt8)

				colors[firstColour + offset] = localPixel
			}

			self.colors = colors
		}
	}
}

extension VNCFramebuffer.ColorMap {
	func colorAt(_ index: Int) -> VNCFramebuffer.LocalPixel? {
		guard colors.indices.contains(index) else {
			return nil
		}

		return colors[index]
	}
}
