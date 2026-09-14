#!/usr/bin/env bash
set -euo pipefail
client_root="$(cd "$(dirname "$0")/.." && pwd)"
media="$client_root/target/native-media"
if [[ ! -f "$media/libgstdtls.so" ]]; then
  echo "Build the media extension first: python3 '$client_root/native-media/build.py'" >&2
  exit 1
fi
export GST_PLUGIN_PATH="$media${GST_PLUGIN_PATH:+:$GST_PLUGIN_PATH}"
export GST_REGISTRY="$media/registry.bin"
exec cargo run --locked --manifest-path "$client_root/Cargo.toml" -p crabfleet-viewer -- "$@"
