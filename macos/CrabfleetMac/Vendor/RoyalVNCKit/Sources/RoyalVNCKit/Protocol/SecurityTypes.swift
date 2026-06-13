#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

extension VNCProtocol {
	enum SecurityType: UInt8 {
		case invalid = 0

		case none = 1 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#none
		case vnc = 2 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#vnc-authentication

		case realVNC3 = 3
		case realVNC4 = 4

		case rsaAES = 5 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-security-type
		case rsaAESUnencrypted = 6 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-unencrypted-security-type

		case realVNC7 = 7
		case realVNC8 = 8
		case realVNC9 = 9
		case realVNC10 = 10
		case realVNC11 = 11
		case realVNC12 = 12

		case rsaAESTwoStep = 13 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-two-step-security-type

		case realVNC14 = 14
		case realVNC15 = 15

		case tight = 16 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#tight-security-type
		case ultra = 17
		case tls = 18
		case veNCrypt = 19 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#vencrypt
		case sasl = 20
		case md5Hash = 21
		case xvp = 22 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#xvp-authentication
		case secureTunnel = 23
		case integratedSSH = 24
		case diffieHellman = 30 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#diffie-hellman-authentication

		case apple31 = 31
		case apple32 = 32
		case apple33 = 33
		case apple34 = 34
		case apple35 = 35
		case apple36 = 36 // Is this really Apple?

		case ultraVNCMSLogonII = 113
		case ultraVNC116 = 116

		case realVNC = 128

		case rsaAES256 = 129 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-256-security-type
		case rsaAES256Unencrypted = 130 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-256-unencrypted-security-type

		case realVNC131 = 131
		case realVNC132 = 132

		case rsaAES256TwoStep = 133 // https://github.com/rfbproto/rfbproto/blob/master/rfbproto.rst#rsa-aes-256-two-step-security-type
		// 134-255 are RealVNC too
	}

	struct SecurityTypes {
		let data: Data
		let authTypes: [UInt8]

		fileprivate init?(data: Data) {
			self.data = data
			self.authTypes = [UInt8](data)
		}
	}
}

extension VNCProtocol.SecurityTypes {
	static func receiveLegacy(connection: NetworkConnectionReading) async throws -> VNCProtocol.SecurityType {
		let rawValue = try await connection.readUInt32()
		guard rawValue <= UInt8.max,
			  let securityType = VNCProtocol.SecurityType(rawValue: UInt8(rawValue)) else {
			throw VNCError.protocol(.invalidData)
		}

		return securityType
	}

	static func receive(connection: NetworkConnectionReading,
						number: UInt8) async throws -> Self {
		let size = MemoryLayout<UInt8>.size * Int(number)

		let data = try await connection.readBuffered(length: size)

		guard let securityTypes = Self(data: data),
			securityTypes.authTypes.count == number else {
			throw VNCError.protocol(.invalidData)
		}

		return securityTypes
	}

	static func send(connection: NetworkConnectionWriting,
					 securityType: UInt8) async throws {
		return try await connection.write(value: securityType)
	}

	var securityTypes: [VNCProtocol.SecurityType] {
		authTypes.map({
			let type = VNCProtocol.SecurityType(rawValue: $0) ?? .invalid

			return type
		})
	}
}
