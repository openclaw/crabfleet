// swift-tools-version: 6.0

import PackageDescription

let package = Package(
  name: "CrabfleetMac",
  platforms: [
    .macOS(.v14)
  ],
  products: [
    .executable(name: "CrabfleetMac", targets: ["CrabfleetMac"])
  ],
  dependencies: [
    .package(path: "Vendor/RoyalVNCKit")
  ],
  targets: [
    .executableTarget(
      name: "CrabfleetMac",
      dependencies: [
        .product(name: "RoyalVNCKit", package: "RoyalVNCKit")
      ],
      swiftSettings: [
        .swiftLanguageMode(.v5)
      ],
      linkerSettings: [
        .linkedFramework("Security")
      ]
    ),
    .testTarget(
      name: "CrabfleetMacTests",
      dependencies: ["CrabfleetMac"],
      swiftSettings: [
        .swiftLanguageMode(.v5)
      ]
    ),
  ]
)
