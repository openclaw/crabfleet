# Crabfleet for macOS prototype

Native fleet browser and Metal-backed VNC client experiment.

The current prototype includes a saved generic-VNC library, Crabfleet-aware
desktop deck, Quick Connect, a matched card-to-desktop transition, a persistent
focused session, paced multi-session card previews, full-screen controls, and
stabilized optional text clipboard synchronization. Up to six user-opened
sessions stay warm; only the focused desktop owns input and clipboard routing.
See the design note for the remaining zero-copy live-mosaic work.

## Build

```sh
swift build --package-path macos/CrabfleetMac
swift test --package-path macos/CrabfleetMac
swift run --package-path macos/CrabfleetMac CrabfleetMac
pnpm macos:bundle
```

`macos:bundle` creates an ad-hoc signed local app at
`.build/Crabfleet.app` for visual testing. Production distribution still
needs an Xcode app target, hardened-runtime signing, notarization, and
third-party notices.

Without configuration, the app uses representative preview data. To read the
current Crabfleet fleet endpoint during development:

```sh
CRABFLEET_API_URL=https://example.test \
CRABFLEET_SESSION_COOKIE='crabbox_session=…' \
swift run --package-path macos/CrabfleetMac CrabfleetMac
```

The cookie is accepted only from the process environment and is never persisted
by the prototype. Production authentication should use a dedicated native OAuth
or device authorization flow.

The current connection sheet targets an already-open local VNC endpoint, such
as the loopback port produced by a Crabbox SSH tunnel. A structured, secret-safe
Crabbox desktop-connection API is required before automatic connection can ship.

## License boundary

The app links a repo-local source fork of
[RoyalVNCKit](https://github.com/royalapplications/royalvnc), an MIT-licensed
Swift package. Fork provenance and changes are recorded in
`Vendor/RoyalVNCKit/UPSTREAM.md`. It does not link, copy, or embed KasmVNC,
TurboVNC, TigerVNC, or other GPL components. A separately deployed GPL server
or external viewer remains a separate distribution and needs its own legal
review and source-offer compliance.

This is not yet distribution-cleared. RoyalVNCKit's modified D3DES source has
ambiguous provenance for its VNC-specific changes; replace or clear that code
with OSPO before shipping. See [`docs/macos-native-client.md`](../../docs/macos-native-client.md)
for the complete boundary and product limitations.
