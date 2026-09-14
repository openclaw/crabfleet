#!/usr/bin/env bash
set -euo pipefail
client_root="$(cd "$(dirname "$0")/.." && pwd)"
runner="$client_root/tools/bin/wasm-bindgen-test-runner"
if [[ ! -x "$runner" ]] || [[ "$("$runner" --version)" != "wasm-bindgen-test-runner 0.2.128" ]]; then
  echo "Install the matching local test tool:" >&2
  echo "cargo install wasm-bindgen-cli --version 0.2.128 --locked --root '$client_root/tools'" >&2
  exit 1
fi
echo "Open http://127.0.0.1:8094 in a test browser and click the silent-audio button."
echo "The browser reports the result; stop this interactive server with Ctrl+C."
NO_HEADLESS=1 \
WASM_BINDGEN_TEST_ADDRESS=127.0.0.1:8094 \
CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_RUNNER="$runner" \
exec cargo test --locked --manifest-path "$client_root/Cargo.toml" -p crabfleet-rtc --lib --target wasm32-unknown-unknown
