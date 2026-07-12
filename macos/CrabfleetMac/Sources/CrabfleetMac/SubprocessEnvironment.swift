import Darwin
import Foundation

enum SubprocessEnvironment {
  private static let inheritedKeys = [
    "HOME",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TMPDIR",
  ]

  static let safePath = "/usr/bin:/bin:/usr/sbin:/sbin"

  static func minimal(
    from source: [String: String],
    includeSSHAgent: Bool = false,
    additionalInheritedKeys: [String] = [],
    additionalInheritedPathKeys: [String] = [],
    overrides: [String: String] = [:]
  ) -> [String: String] {
    var environment = Dictionary(
      uniqueKeysWithValues: inheritedKeys.compactMap { key in
        source[key].map { (key, $0) }
      }
    )
    for key in additionalInheritedKeys {
      environment[key] = source[key]
    }
    for key in additionalInheritedPathKeys {
      environment.removeValue(forKey: key)
      if let value = source[key], isSafeAbsolutePath(value) {
        environment[key] = value
      }
    }
    environment["PATH"] = safePath
    if includeSSHAgent, let socket = source["SSH_AUTH_SOCK"], !socket.isEmpty {
      environment["SSH_AUTH_SOCK"] = socket
    }
    for (key, value) in overrides {
      environment[key] = value
    }
    return environment
  }

  private static func isSafeAbsolutePath(_ value: String) -> Bool {
    guard
      value.hasPrefix("/"),
      value.utf8.count < Int(PATH_MAX),
      value.unicodeScalars.allSatisfy({
        !CharacterSet.controlCharacters.contains($0)
      })
    else {
      return false
    }
    return !value.split(separator: "/", omittingEmptySubsequences: false)
      .contains { $0 == "." || $0 == ".." }
  }
}
