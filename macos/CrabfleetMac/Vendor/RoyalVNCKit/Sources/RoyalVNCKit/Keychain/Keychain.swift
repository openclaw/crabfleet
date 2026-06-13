#if canImport(Security)
#if canImport(FoundationEssentials)
import FoundationEssentials
#else
import Foundation
#endif

import Security

struct Keychain {
	private let lock = NSLock()

	static let shared = Self()
}

extension Keychain {
	@discardableResult
	func get(key: String) -> Data? {
		lock.lock()
		defer { lock.unlock() }

		var query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrAccount as String: key,
			kSecMatchLimit as String: kSecMatchLimitOne
		]

		query[kSecReturnData as String] = kCFBooleanTrue

		var resultObject: AnyObject?

		let result = withUnsafeMutablePointer(to: &resultObject) {
			SecItemCopyMatching(query as CFDictionary, UnsafeMutablePointer($0))
		}

		let success = result == noErr

		guard success,
			  let resultData = resultObject as? Data else {
			return nil
		}

		return resultData
	}

	@discardableResult
	func set(_ value: Data,
			 forKey key: String) -> Bool {
		lock.lock()
		defer { lock.unlock() }

		delete(key: key,
			   withLock: false)

		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrAccount as String: key,
			kSecValueData as String: value,
			kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked
		]

		let result = SecItemAdd(query as CFDictionary, nil)
		let success = result == noErr

		return success
	}

	@discardableResult
	func delete(key: String) -> Bool {
		delete(key: key, withLock: true)
	}
}

private extension Keychain {
	@discardableResult
	func delete(key: String, withLock: Bool) -> Bool {
		if withLock {
			lock.lock()
		}

		defer {
			if withLock {
				lock.unlock()
			}
		}

		let query: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrAccount as String: key
		]

		let result = SecItemDelete(query as CFDictionary)
		let success = result == noErr

		return success
	}
}
#endif
