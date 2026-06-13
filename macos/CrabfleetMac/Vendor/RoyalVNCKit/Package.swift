// swift-tools-version: 6.0

import PackageDescription

// Crabfleet's local fork builds only the native macOS Swift surface.
let package = Package(
  name: "RoyalVNCKit",
  platforms: [
    .macOS(.v11)
  ],
  products: [
    .library(name: "RoyalVNCKit", type: .dynamic, targets: ["RoyalVNCKit"])
  ],
  dependencies: [
    .package(
      url: "https://github.com/royalapplications/CryptoSwift.git",
      revision: "a59b4d91ebb22011656c830f874fe7152e183a57"
    )
  ],
  targets: [
    .target(name: "d3des"),
    .target(name: "Z", linkerSettings: [.linkedLibrary("z")]),
    .target(
      name: "RoyalVNCKit",
      dependencies: ["d3des", "Z", "CryptoSwift"],
      exclude: ["SDK/CSDK"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
    .testTarget(
      name: "RoyalVNCKitTests",
      dependencies: ["RoyalVNCKit"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
