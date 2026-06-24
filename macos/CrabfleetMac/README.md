# Crabfleet for macOS prototype

Native fleet browser, Metal-backed VNC client, and private Mac-to-Mac desktop
sharing experiment.

The current prototype includes a saved generic-VNC library, Crabfleet-aware
desktop deck, Quick Connect, a matched card-to-desktop transition, a persistent
focused session, paced multi-session card previews, full-screen controls, and
stabilized optional text clipboard synchronization. Up to six user-opened
sessions stay warm; only the focused desktop owns input and clipboard routing.
See the design note for the remaining zero-copy live-mosaic work.

`Share This Mac` adds the missing server half without using Apple's Screen
Sharing service. ScreenCaptureKit captures the primary display, Crabfleet sends
bounded Tight/JPEG RFB updates, and Accessibility-authorized CGEvents forward
keyboard and pointer input. The listener binds only to the Mac's verified
Tailscale `100.64.0.0/10` address after confirming a valid identity on the active
tailnet. Before the RFB handshake, `tailscale whois` must identify the peer as
another authorized device owned by the same Tailscale user.

When the app has `CRABFLEET_API_URL` and `CRABFLEET_SESSION_COOKIE`, starting a
share publishes the host's stable Tailscale endpoint to the signed-in user's
private Fleet registry. The receiving Mac discovers that card and connects
directly with a blank RFB password. Quick Connect with the displayed
`vnc://100.x.y.z:5901` address remains available as a fallback. RFB's None
security type is intentional here: admission and encrypted transport belong to
Tailscale, and the RFB socket is never bound to Wi-Fi, Ethernet, loopback, or a
public address. Crabfleet must remain running on the host. The prototype allows
one peer, captures the primary display at up to 1600×1000 and 15 fps, and does
not forward host clipboard contents or audio.

The first Screen Recording grant requires restarting the bundled app before
macOS makes captured frames available. Ad-hoc development signatures can cause
macOS to ask again after a rebuild; production signing is required for a stable
permission identity.

For an unattended host, launch the bundled app with `--share-this-mac`, or set
`CRABFLEET_AUTO_SHARE=1`. Crabfleet requests any missing Screen Recording and
Accessibility permissions, waits up to five minutes for them to be granted,
and then starts the same tailnet-only RFB listener used by the in-app control:

```sh
/Applications/Crabfleet.app/Contents/MacOS/CrabfleetMac --share-this-mac
```

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
by the prototype. It authenticates both Fleet reads and host registration.
Production authentication should use a dedicated native OAuth or device
authorization flow.

The generic connection sheet still targets an already-open VNC endpoint, such
as the loopback port produced by a Crabbox SSH tunnel. A structured, secret-safe
Crabbox desktop-connection API is required before automatic lease connection can
ship. `Share This Mac` is independent of that lease contract and uses only the
local active tailnet.

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
