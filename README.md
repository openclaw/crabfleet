# Crabfleet

**Your computers, within reach.**

Crabfleet is a remote desktop app for VNC: a native Mac viewer, private desktop sharing, and a Linux/Windows host connector. Save connections, switch between desktops, and share a computer with low-latency video, audio, clipboard, and optional file transfer.

The Mac app works with ordinary VNC servers without an account. Its optional desktop service adds sign-in, discovery, and an authenticated browser relay at `https://crabfleet.openclaw.ai`. Product documentation lives at [docs.crabfleet.ai](https://docs.crabfleet.ai).

## Desktop features

- **Native Mac viewer:** Metal rendering, saved VNC connections, Quick Connect, full-screen controls, multiple warm sessions, and Wake-on-LAN.
- **Share This Mac:** up to four displays, password-authenticated direct connections over Tailscale, pinned QUIC with TCP fallback, and owner-authenticated browser relay.
- **Negotiated media:** HEVC, H.264, Tight/JPEG fallback, client-side cursors, Auto/Sharp/Smooth quality modes, and opt-in system audio.
- **Clipboard and files:** UTF-8 clipboard synchronization and explicitly selected shared folders with bounded transfers.
- **Linux connector:** X11, Hyprland/wlroots, and GNOME/KDE portal capture, optional audio, private persistent state, and graphical-session startup.
- **Windows connector:** primary-display capture, keyboard and pointer input, password authentication, Tight/JPEG, and client-side cursors.

## Get started

On macOS, build with a real Developer ID and install at the stable application path before testing screen capture or input:

```sh
pnpm install --frozen-lockfile
CODE_SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" pnpm macos:bundle
```

Install the resulting `macos/CrabfleetMac/.build/Crabfleet.app` at `/Applications/Crabfleet.app`. Choose **Use Local VNC Only** for saved connections or Quick Connect. Choose **Share This Mac** to host a desktop; grant Screen Recording and, for remote control, Accessibility.

On Linux:

```sh
go build -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
./dist/crabfleet-connect login --server https://crabfleet.openclaw.ai
./dist/crabfleet-connect share --fleet
```

See the [quickstart](docs/quickstart.md), [Mac app guide](docs/macos-native-client.md), and [Linux connector guide](docs/linux-connector.md).

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:native
pnpm build:docs
```

`pnpm check` builds the browser companion, type-checks the desktop backend, and runs lint and format checks. `pnpm test` covers desktop authorization, registration, relays, and browser RFB. `pnpm test:native` runs Go race tests and vet; on macOS it also runs the Swift suites. Use `pnpm format` to apply formatting.

The source is split into `macos/CrabfleetMac` (native viewer and Mac host), `cmd/crabfleet-connect` and `internal` (Go hosts and RFB), and `src` (desktop discovery, authorization, relay, and browser VNC companion). The backend has no agent workspace, board, terminal, or sandbox execution service.

Deployment configuration and upgrade notes are in the [administration guide](docs/admin.md); the desktop protocol is documented in the [API reference](docs/api.md).

## License

See [LICENSE](LICENSE). The native app includes a source fork of RoyalVNCKit with its own notices in `macos/CrabfleetMac/Vendor/RoyalVNCKit`.
