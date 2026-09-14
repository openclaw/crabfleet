#!/usr/bin/env bash
set -euo pipefail
client_root="$(cd "$(dirname "$0")/.." && pwd)"
bindgen="$client_root/tools/bin/wasm-bindgen"
if [[ ! -x "$bindgen" ]] || [[ "$("$bindgen" --version)" != "wasm-bindgen 0.2.128" ]]; then
  echo "Install the matching local build tool:" >&2
  echo "cargo install wasm-bindgen-cli --version 0.2.128 --locked --root '$client_root/tools'" >&2
  exit 1
fi
cargo build --locked --release --target wasm32-unknown-unknown --manifest-path "$client_root/Cargo.toml" -p crabfleet-viewer --lib
mkdir -p "$client_root/dist/pkg"
"$bindgen" "$client_root/target/wasm32-unknown-unknown/release/crabfleet_viewer.wasm" --target web --out-dir "$client_root/dist/pkg" --no-typescript
cp "$client_root/web/index.html" "$client_root/dist/index.html"
cp "$client_root/web/main.js" "$client_root/dist/main.js"
echo "Web app built in $client_root/dist"
