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
    overrides: [String: String] = [:]
  ) -> [String: String] {
    var environment = Dictionary(
      uniqueKeysWithValues: inheritedKeys.compactMap { key in
        source[key].map { (key, $0) }
      }
    )
    environment["PATH"] = safePath
    if includeSSHAgent, let socket = source["SSH_AUTH_SOCK"], !socket.isEmpty {
      environment["SSH_AUTH_SOCK"] = socket
    }
    for (key, value) in overrides {
      environment[key] = value
    }
    return environment
  }
}
