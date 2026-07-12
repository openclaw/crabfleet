#!/bin/sh
set -eu

package_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
configuration=${CONFIGURATION:-debug}
code_sign_identity=${CODE_SIGN_IDENTITY:-}
code_sign_hardened_runtime=${CODE_SIGN_HARDENED_RUNTIME:-0}

if [ -z "$code_sign_identity" ] && command -v security >/dev/null 2>&1; then
    code_sign_identity=$(security find-identity -v -p codesigning 2>/dev/null \
        | sed -n 's/.*"\(.*\)"/\1/p' \
        | head -n 1)
fi
if [ -z "$code_sign_identity" ]; then
    code_sign_identity=-
fi

case "$code_sign_hardened_runtime" in
    0|1) ;;
    *)
        echo "CODE_SIGN_HARDENED_RUNTIME must be 0 or 1" >&2
        exit 2
        ;;
esac

if [ "$code_sign_hardened_runtime" = "1" ] && [ "$code_sign_identity" = "-" ]; then
    echo "CODE_SIGN_HARDENED_RUNTIME=1 requires CODE_SIGN_IDENTITY" >&2
    exit 2
fi

swift build --package-path "$package_dir" --configuration "$configuration"
build_dir=$(swift build --package-path "$package_dir" --configuration "$configuration" --show-bin-path)
app_dir="$package_dir/.build/Crabfleet.app"
contents_dir="$app_dir/Contents"
macos_dir="$contents_dir/MacOS"
resources_dir="$contents_dir/Resources"

rm -rf "$app_dir"
mkdir -p "$macos_dir" "$resources_dir"
install -m 755 "$build_dir/CrabfleetMac" "$macos_dir/CrabfleetMac"
install -m 755 "$build_dir/libRoyalVNCKit.dylib" "$macos_dir/libRoyalVNCKit.dylib"
install -m 644 "$package_dir/Resources/Info.plist" "$contents_dir/Info.plist"
install -m 644 "$package_dir/Resources/ThirdPartyNotices.md" "$resources_dir/ThirdPartyNotices.md"

resource_bundle="$build_dir/CryptoSwift_CryptoSwiftResources.bundle"
if [ -d "$resource_bundle" ]; then
    install -m 644 "$resource_bundle/PrivacyInfo.xcprivacy" "$resources_dir/PrivacyInfo.xcprivacy"
fi

sign_path() {
    if [ "$code_sign_hardened_runtime" = "1" ]; then
        codesign --force --options runtime --timestamp --sign "$code_sign_identity" "$1"
    else
        codesign --force --sign "$code_sign_identity" "$1"
    fi
}

sign_path "$macos_dir/libRoyalVNCKit.dylib"
sign_path "$app_dir"
codesign --verify --deep --strict "$app_dir"

echo "$app_dir"
