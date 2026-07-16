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
keyboard and pointer input when that optional permission is granted. Screen
Recording alone starts a view-only share. The listener binds only to the Mac's verified
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
`CRABFLEET_AUTO_SHARE=1`. Crabfleet requests missing Screen Recording access,
waits up to five minutes for it to be granted, and then starts the same
tailnet-only RFB listener used by the in-app control. Accessibility can be
granted separately when remote keyboard and pointer control are needed:

```sh
/Applications/Crabfleet.app/Contents/MacOS/CrabfleetMac --share-this-mac
```

To open a no-password VNC endpoint immediately, use `--connect` or set
`CRABFLEET_AUTO_CONNECT`. The address is saved as a favorite and focused when
the app opens. Embedded passwords are rejected:

```sh
/Applications/Crabfleet.app/Contents/MacOS/CrabfleetMac \
  --connect vnc://100.64.0.8:5901
```

## Build

```sh
swift build --package-path macos/CrabfleetMac
swift test --package-path macos/CrabfleetMac
swift run --package-path macos/CrabfleetMac CrabfleetMac
pnpm macos:bundle
```

`macos:bundle` creates an ad-hoc signed local app at `.build/Crabfleet.app` by
default. Ad-hoc identities change with the executable, so macOS may ask for
Screen Recording again after each rebuild. Use the same Apple Development or
Developer ID identity for iterative host builds so the app keeps a stable code
requirement:

```sh
CODE_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm macos:bundle
```

Create or synchronize that identity from Xcode Settings > Accounts > Manage
Certificates. Direct distribution additionally requires a Developer ID
Application identity, hardened runtime, a secure timestamp, notarization, and
final third-party notices. The bundle script enables the signing-side
distribution requirements with:

```sh
CODE_SIGN_IDENTITY="Developer ID Application: Your Name (TEAMID)" \
CODE_SIGN_HARDENED_RUNTIME=1 pnpm macos:bundle
```

On first launch, enter the public URL of the Crabfleet deployment. The app
requests a device link, opens the deployment's approval page in the default
browser, and waits for an already signed-in Crabfleet user to approve it. After
approval, the app receives a 24-hour bearer scoped only to `fleet:read`, stores
it for that exact deployment origin in the macOS Keychain, and loads the live
Fleet registry. The saved deployment URL is not a credential.

The app starts disconnected when it has no approved credential. It does not
fall back to preview fixtures, accept a raw `crabbox_session` cookie, or copy a
browser cookie into native storage. Disconnect removes the Keychain credential
before best-effort server revocation; a local Keychain failure keeps the
connection available for retry. `CRABFLEET_API_URL` may prefill the deployment
URL for local development, but authentication still uses browser approval:

```sh
CRABFLEET_API_URL=https://example.test \
swift run --package-path macos/CrabfleetMac CrabfleetMac
```

Saved and ad-hoc VNC connections do not require a deployment. Choose **Use
Local VNC Only** on the connection screen, then use Quick Connect or a saved
profile. Return to deployment sign-in from the account menu. Debug builds may
start directly in this mode with `CRABFLEET_LOCAL_ONLY=1`.

The deployment must expose the native device, token, session, and Fleet routes
described in [`docs/api.md`](../../docs/api.md). A trusted identity proxy must
pass only those exact method/path combinations directly to Crabfleet without
redirecting them through browser SSO; `/native/link/*` remains a normal
browser-authenticated approval page. A proxy-only deployment must also configure
`CRABBOX_TOKEN_ENCRYPTION_KEY` for the one-time token handoff.

Alternatively, a gateway that supports OAuth 2.0 dynamic client registration
and PKCE may advertise a same-origin `resource_metadata` URL in its Bearer
challenge with an explicit read-only scope and expose exact authenticated GET
routes at `/mcp/crabfleet/native/v1/session`,
`/mcp/crabfleet/native/v1/fleet`, and `/mcp/crabfleet/native/v1/native-vnc`.
The gateway must remove its OAuth bearer
before mapping those routes to Crabfleet's trusted authenticated
the exact native session, Fleet, and VNC-grant routes. The app uses only the registration-
provided literal-loopback callback, asks for explicit trust before contacting
provider origins outside the deployment, stores the resulting bearer and
refresh grant in Keychain, rotates refresh grants before retrying unauthorized
reads, and does not import browser cookies.
Each RFC 9728 challenge must identify its exact protected read. Direct
authorization-server metadata is accepted only without a `resource` field and
for an explicit `api://` scope whose audience matches the issued JWT.
The localhost-only development identity cannot issue a native device token;
test the native flow with a normal configured browser-authentication method.

`CRABFLEET_SESSION_COOKIE` is accepted only from the process environment for
`Share This Mac` host registration and is never persisted. Fleet reads always
use the deployment-scoped native bearer; the browser cookie is never copied
into native storage.

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

The fork no longer bundles the modified D3DES source; VNC password
authentication uses the operating system's CommonCrypto DES instead. See
[`docs/macos-native-client.md`](../../docs/macos-native-client.md)
for the complete boundary and product limitations.
