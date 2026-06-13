#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
configuration=${CONFIGURATION:-debug}

swift build --package-path "$package_dir" --configuration "$configuration"
build_dir=$(swift build --package-path "$package_dir" --configuration "$configuration" --show-bin-path)
app_dir="$package_dir/.build/Crabfleet.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

mkdir -p "$macos_dir" "$resources_dir"
install -m 755 "$build_dir/CrabfleetMac" "$macos_dir/CrabfleetMac"
install -m 755 "$build_dir/libRoyalVNCKit.dylib" "$macos_dir/libRoyalVNCKit.dylib"
install -m 644 "$package_dir/Resources/Info.plist" "$contents_dir/Info.plist"
install -m 644 "$package_dir/Resources/ThirdPartyNotices.md" "$resources_dir/ThirdPartyNotices.md"

resource_bundle="$build_dir/CryptoSwift_CryptoSwiftResources.bundle"
if [ -d "$resource_bundle" ]; then
    install -m 644 "$resource_bundle/PrivacyInfo.xcprivacy" "$resources_dir/PrivacyInfo.xcprivacy"
fi

codesign --force --sign - "$macos_dir/libRoyalVNCKit.dylib"
codesign --force --sign - "$app_dir"
codesign --verify --deep --strict "$app_dir"

echo "$app_dir"
