#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

struct CredentialsKeychain {
#if canImport(Security)
	private let keychain = Keychain()
#endif
}

extension CredentialsKeychain {
	func username(forHostname hostname: String,
				  port: UInt16) -> String {
		string(forKey: usernameKey(forHostname: hostname, port: port))
	}

	func setUsername(_ username: String,
					 forHostname hostname: String,
					 port: UInt16) {
		setString(username, forKey: usernameKey(forHostname: hostname, port: port))
	}

	func password(forHostname hostname: String,
				  port: UInt16) -> String {
		string(forKey: passwordKey(forHostname: hostname, port: port))
	}

	func setPassword(_ password: String,
					 forHostname hostname: String,
					 port: UInt16) {
		setString(password, forKey: passwordKey(forHostname: hostname, port: port))
	}
}

private extension CredentialsKeychain {
	func string(forKey key: String) -> String {
#if canImport(Security)
		guard let data = keychain.get(key: key) else {
			return ""
		}

		guard let string = String(data: data, encoding: .utf8) else {
			return ""
		}

		return string
#else
		fatalError("Not implemented")
#endif
	}

	func setString(_ string: String,
				   forKey key: String) {
#if canImport(Security)
		guard let data = string.data(using: .utf8) else {
			return
		}

		keychain.set(data, forKey: key)
#else
		fatalError("Not implemented")
#endif
	}

	func usernameKey(forHostname hostname: String,
					 port: UInt16) -> String {
		"RoyalVNC_\(hostname):\(port)_Username"
	}

	func passwordKey(forHostname hostname: String,
					 port: UInt16) -> String {
		"RoyalVNC_\(hostname):\(port)_Password"
	}
}
