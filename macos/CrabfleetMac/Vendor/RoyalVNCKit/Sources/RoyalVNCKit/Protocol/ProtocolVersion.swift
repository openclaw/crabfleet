#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	struct ProtocolVersion {
		let data: Data
		let protocolVersion: String

		let majorVersion: UInt32
		let minorVersion: UInt32

		fileprivate init?(data: Data) {
			guard let protocolVersion = String(data: data, encoding: .utf8) else {
				return nil
			}

#if canImport(FoundationEssentials)
			// TODO: This is not equivalent to the non-FoundationEssentials version as it removes newlines even from within the string, not just the prefix/suffix
			let trimmedProtocolVersion = protocolVersion
				.replacing("\r", with: "")
				.replacing("\n", with: "")
#else
			let trimmedProtocolVersion = protocolVersion
				.trimmingCharacters(in: .newlines)
#endif

			guard let parsedProtocolVersion = Self.parseProtocolVersion(trimmedProtocolVersion) else {
				return nil
			}

			self.data = data
			self.protocolVersion = trimmedProtocolVersion

			let majorVersion = parsedProtocolVersion.0
			let minorVersion = parsedProtocolVersion.1

			self.majorVersion = majorVersion
			self.minorVersion = minorVersion
		}

		init(majorVersion: UInt32,
			 minorVersion: UInt32) {
			func paddedVersion(_ version: UInt32) -> String {
                let requiredLength = 3
                let versionString = String(version)

                if versionString.count == requiredLength {
                    return versionString
                }

                let paddingCount = requiredLength - versionString.count

                guard paddingCount > 0 else {
                    return versionString
                }

                let padding = String(
                    repeating: "0",
                    count: requiredLength - versionString.count
                )

                let padVersion = padding + versionString

                return padVersion
            }

            let paddedMajorVersion = paddedVersion(majorVersion)
            let paddedMinorVersion = paddedVersion(minorVersion)

            let protocolVersion = "RFB \(paddedMajorVersion).\(paddedMinorVersion)"

			self.data = Self.dataWith(protocolVersion: protocolVersion)
			self.protocolVersion = protocolVersion

			self.majorVersion = majorVersion
			self.minorVersion = minorVersion
		}
	}
}

extension VNCProtocol.ProtocolVersion {
	static func dataWith(protocolVersion: String) -> Data {
		var fixedProtocolVersion = protocolVersion

		if !protocolVersion.hasSuffix("\n") {
			fixedProtocolVersion = "\(protocolVersion)\n"
		}

		func paddedVersion(_ version: String) -> String {
			let requiredLength = 12

			if version.count == requiredLength {
				return version
			}

			let paddingCount = requiredLength - version.count

			guard paddingCount > 0 else {
				return version
			}

			let padding = String(
				repeating: "\0",
				count: requiredLength - version.count
			)

			let padVersion = version + padding

			return padVersion
		}

		let paddedProtocolVersion = paddedVersion(fixedProtocolVersion)

		let data = paddedProtocolVersion.data(using: .utf8)!

		return data
	}

	static func receive(connection: NetworkConnectionReading) async throws -> Self {
		let data = try await connection.readBuffered(length: 12)

		guard let protocolVersion = Self(data: data) else {
			throw VNCError.protocol(.invalidData)
		}

		return protocolVersion
	}

	static func send(connection: NetworkConnectionWriting,
					 protocolVersion: Self) async throws {
		let data = protocolVersion.data

		try await connection.write(data: data)
	}

	var is3Point8OrHigher: Bool {
		let isIt = (majorVersion > 3) ||
			(majorVersion == 3 && minorVersion >= 8)

		return isIt
	}

	var usesLegacySecurityHandshake: Bool {
		majorVersion == 3 && minorVersion == 3
	}

	func compatibleClientVersion(maximumSupported: Self) -> Self? {
		if majorVersion > maximumSupported.majorVersion
			|| (majorVersion == maximumSupported.majorVersion
				&& minorVersion >= maximumSupported.minorVersion) {
			return maximumSupported
		}

		guard majorVersion == 3 else { return nil }
		if minorVersion >= 7 {
			return .init(majorVersion: 3, minorVersion: 7)
		}
		if minorVersion >= 3 {
			return .init(majorVersion: 3, minorVersion: 3)
		}
		return nil
	}

	var isAppleRemoteDesktop: Bool {
		let isIt = majorVersion == 3 && minorVersion == 889

		return isIt
	}
}

private extension VNCProtocol.ProtocolVersion {
	static func parseProtocolVersion(_ protocolVersion: String) -> (UInt32, UInt32)? {
#if canImport(FoundationEssentials)
		// TODO: This is not equivalent to the non-FoundationEssentials version as it removes newlines even from within the string, not just the prefix/suffix
		let trimmed = protocolVersion
			.replacing("\r", with: "")
			.replacing("\n", with: "")
			.replacing("RFB ", with: "")
#else
		let trimmed = protocolVersion
			.trimmingCharacters(in: .newlines)
			.replacingOccurrences(of: "RFB ", with: "")
#endif

		let split = trimmed.split(separator: ".")

		guard split.count == 2 else {
			return nil
		}

		let majorStr = split[0]
		let minorStr = split[1]

		guard let majorVersion: UInt32 = .init(majorStr) else {
			return nil
		}

		guard let minorVersion: UInt32 = .init(minorStr) else {
			return nil
		}

		return (majorVersion, minorVersion)
	}
}
