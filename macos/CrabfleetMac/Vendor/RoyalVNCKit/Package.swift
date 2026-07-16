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
  targets: [
    .target(name: "Z", linkerSettings: [.linkedLibrary("z")]),
    .target(
      name: "RoyalVNCKit",
      dependencies: ["Z"],
      exclude: ["SDK/CSDK"],
      swiftSettings: [.swiftLanguageMode(.v5)],
      linkerSettings: [
        .linkedFramework("VideoToolbox", .when(platforms: [.macOS])),
        .linkedFramework("CoreMedia", .when(platforms: [.macOS])),
      ]
    ),
    .testTarget(
      name: "RoyalVNCKitTests",
      dependencies: ["RoyalVNCKit"],
      swiftSettings: [.swiftLanguageMode(.v5)]
    ),
  ]
)
