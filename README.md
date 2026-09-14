# Crabfleet

**Your computers, within reach.**

Crabfleet is a remote desktop app for VNC. Save your computers, connect from a native Mac app, and switch between desktops without closing your connections. Share a Mac or Linux desktop with negotiated video, audio, clipboard, and optional file transfer; the Windows connector provides basic direct VNC hosting.

The Mac app works with ordinary VNC servers without an account. Optional sign-in adds a private list of your shared computers. The [browser companion](https://crabfleet.openclaw.ai/app/) connects to relay-enabled shares through the desktop service.

[Get started](https://docs.crabfleet.ai/quickstart/) · [Connection modes](https://docs.crabfleet.ai/connections/) · [Documentation](https://docs.crabfleet.ai/)

## Platforms

| Component         | Connect to a desktop                                  | Share a desktop                                                           |
| ----------------- | ----------------------------------------------------- | ------------------------------------------------------------------------- |
| macOS app         | Saved VNC connections and discovered direct endpoints | Tailscale access; optional browser relay with host publication configured |
| Linux connector   | Use the Mac app or a VNC viewer                       | X11, Hyprland/wlroots, GNOME/KDE; direct VNC and browser relay            |
| Windows connector | Use the Mac app or a VNC viewer                       | Primary display over direct VNC; source build                             |
| Browser companion | Your published, relay-enabled desktops                | Use the Mac app or Linux connector to publish a host                      |

## Desktop features

- **Native Mac viewer:** Metal rendering, saved VNC connections, Quick Connect, full-screen controls, multiple warm sessions, and Wake-on-LAN.
- **Share This Mac:** up to four displays, password-authenticated direct connections over Tailscale, pinned QUIC with TCP fallback, and owner-authenticated browser relay.
- **Negotiated media:** HEVC, H.264, Tight/JPEG fallback, client-side cursors, Auto/Sharp/Smooth quality modes, and opt-in system audio.
- **Clipboard and files:** UTF-8 clipboard synchronization and explicitly selected shared folders with bounded transfers.
- **Linux connector:** X11, Hyprland/wlroots, and GNOME/KDE portal capture; simultaneous monitors, VAAPI/NVENC hardware video with software fallback, live desktop geometry, opt-in supported mode changes, optional audio, private state, and graphical-session startup.
- **Windows connector:** primary-display capture, keyboard and pointer input, password authentication, Tight/JPEG, and client-side cursors. Account sign-in, browser publication, audio, clipboard, file sharing, and service commands are currently Linux-only connector features.

## Get started

If Crabfleet is already installed, open it and choose **Use Local VNC Only** to add a computer or use **Quick Connect**. Enter the VNC server's address and password. Choose **Share This Mac** to host your own desktop.

To build the app from source, use macOS 14 or later, the full Xcode toolchain, Node.js 24 or later, and the repository's pnpm version. From the repository root:

```sh
pnpm install --frozen-lockfile
CODE_SIGN_IDENTITY="Developer ID Application: OpenClaw Foundation (FWJYW4S8P8)" pnpm macos:bundle
```

The signing command uses the maintainer's Developer ID; use your own real Developer ID when building locally. Install the resulting `macos/CrabfleetMac/.build/Crabfleet.app` at `/Applications/Crabfleet.app` and reuse that identity and path when rebuilding. Screen Recording allows capture; Accessibility allows remote keyboard and pointer input.

To publish a Linux desktop, run these commands from a checkout inside your graphical session:

```sh
go build -o ./dist/crabfleet-connect ./cmd/crabfleet-connect
./dist/crabfleet-connect login --server https://crabfleet.openclaw.ai
./dist/crabfleet-connect share --fleet
```

Approve the connector in your browser, then open **Your desktops → Connect** in the browser companion. For a native Mac connection, the Linux host must also advertise a reachable Tailscale address; see the [Linux guide](docs/linux-connector.md).

Use `--all-monitors` to share multiple outputs, `--encoder vaapi` to select VAAPI explicitly, and `--allow-resize` to permit supported display mode changes. Portal capture requires desktop consent and cannot change physical modes. A separate administrator-configured [SDDM Wayland greeter wrapper](docs/linux-greeter.md) supports login-screen sharing with its own authenticated state.

See the [quickstart](docs/quickstart.md), [Mac guide](docs/macos-native-client.md), [Linux guide](docs/linux-connector.md), and [Windows guide](docs/windows-connector.md) for requirements and platform-specific setup. [Connection modes](docs/connections.md) explains which paths need an account, Tailscale, or the relay.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm test:native
pnpm build:docs
```

`pnpm check` builds the browser companion, type-checks the desktop backend, and runs lint and format checks. `pnpm test` covers desktop authorization, registration, relays, and browser RFB. `pnpm test:native` runs Go race tests and vet; on macOS it also runs the Swift suites. Use `pnpm format` to apply formatting.

The source is split into `macos/CrabfleetMac` (native viewer and Mac host), `cmd/crabfleet-connect` and `internal` (Go hosts and RFB), and `src` (desktop discovery, authorization, relay, and browser VNC companion).

Deployment configuration and upgrade notes are in the [administration guide](docs/admin.md); the desktop protocol is documented in the [API reference](docs/api.md).

## License

See [LICENSE](LICENSE). The native app includes a source fork of RoyalVNCKit with its own notices in `macos/CrabfleetMac/Vendor/RoyalVNCKit`.
