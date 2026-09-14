# Crabfleet for macOS

Native VNC viewer and private Mac desktop sharing, with Metal rendering, saved connections, Quick Connect, multiple warm sessions, and full-screen controls.

Ordinary VNC connections work without an account: choose **Use Local VNC Only**. The optional desktop service adds browser-approved sign-in and private host discovery. See [connection modes](../../docs/connections.md) for direct and relay access, the [quickstart](../../docs/quickstart.md) for installation, and the [Mac guide](../../docs/macos-native-client.md) for sharing, media, credentials, and protocol behavior.

## Build and test

```sh
swift build --package-path macos/CrabfleetMac
pnpm macos:test
CODE_SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" pnpm macos:bundle
```

Use the full Xcode toolchain for Swift tests. Install the signed bundle at `/Applications/Crabfleet.app` before using screen capture, Accessibility input, or stored Keychain credentials. Always reuse a real Developer ID and this stable path so macOS permissions survive rebuilds. `swift run` is suitable for logic-only development.

## Host a desktop

Run Tailscale on both Macs under the same user identity. Choose **Share This Mac**, grant Screen Recording, and optionally enable Accessibility input, audio, clipboard, and a shared folder. Direct connections use a fresh per-share password over the active Tailscale network. The host supports multiple displays, QUIC with TCP fallback, and negotiated HEVC/H.264/Tight video.

For unattended startup:

```sh
/Applications/Crabfleet.app/Contents/MacOS/CrabfleetMac --share-this-mac
```

`CRABFLEET_API_URL` may prefill the desktop service URL. Native sign-in stores a deployment-scoped `fleet:read` bearer in Keychain after browser approval. This grants discovery only. Mac host publication currently requires `CRABFLEET_API_URL` and `CRABFLEET_SESSION_COOKIE` in the process environment; the browser session is never persisted or used as the native viewer credential. Keep it out of command history and logs. The desktop API and ownership contracts are in the [API reference](../../docs/api.md).

## License boundary

The app links the repo-local RoyalVNCKit source fork. Preserve its license and notices when distributing the app.
