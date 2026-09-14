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
    overrides: [String: String] = [:]
  ) -> [String: String] {
    var environment = Dictionary(
      uniqueKeysWithValues: inheritedKeys.compactMap { key in
        source[key].map { (key, $0) }
      }
    )
    environment["PATH"] = safePath
    for (key, value) in overrides {
      environment[key] = value
    }
    return environment
  }
}
