---
title: Native macOS Client
layout: default
permalink: /macos-native-client/
description: "Scope, integration boundary, and security notes for the native macOS prototype."
---

# Native macOS client experiment

Status: early prototype. The app lives in `macos/CrabfleetMac` and provides a
SwiftUI fleet browser, an AppKit-hosted Metal-rendered VNC surface, and an
app-owned private desktop host for Mac-to-Mac access.

## Product shape

- Screens-style desktop deck combining saved generic VNC connections and
  Crabfleet leases, with source filters, search, status, and Quick Connect.
- Fast matched card-to-desktop transition, full-screen focus mode, desktop
  switcher, reconnect controls, and retained framebuffer previews.
- Stable app-owned session controllers. Up to six user-opened desktops stay
  connected across focus changes, with focused updates interactive, visible
  background previews capped at 4 fps, and all sessions capped at 0.5 fps while
  the app is inactive. Cards retain coalesced, materialized 640×360 previews.
- Generic addresses accept `host`, `host:port`, `vnc://user@host:port`, and
  bracketed IPv6. Saved profiles contain metadata only; passwords remain in
  memory for the connection attempt.
- RFB 3.3, 3.7, and 3.8 framing is supported, including server-selected RFB
  3.3 None and VNC-password authentication.
- Client-side fit scaling and rendering use RoyalVNCKit's IOSurface/Metal path.
- Share This Mac captures a selected display and optional system audio with
  ScreenCaptureKit, then serves private HEVC, Open H.264, or Tight/JPEG RFB 3.8
  frames plus AAC-LC audio to Crabfleet viewers without enabling Apple's Screen
  Sharing daemon.
- The host accepts TCP on port 5901 and QUIC on port 5911 only when the local
  address is the verified Tailscale `100.64.0.0/10` address, requires a valid
  identity on the active tailnet, and admits only a Tailscale-authorized peer
  owned by that same user.
- Screen Recording is the only permission required for view-only sharing.
  Remote control is forwarded through Accessibility-authorized CGEvents when
  that optional permission is granted.

The fork exposes an externally managed clipboard mode, so no VNC connection
polls or writes `NSPasteboard.general` directly. One app-owned coordinator sends
only stable local text changes to the focused desktop, baselines rather than
sending the existing clipboard on focus/connect, suppresses server echoes, and
quarantines clipboard text received from background desktops. The focus toolbar
provides explicit Send Clipboard and Get Clipboard recovery actions plus a
persisted sync direction: bidirectional, send-only, or receive-only. Directional
modes gate only the automatic flows; the explicit actions still work. Clipboard
sync remains opt-in. A deliberate local copy supersedes a quarantined value for
the focused desktop. Versioned pasteboard snapshots and bounded SHA-256 echo
fingerprints prevent delayed server echoes from erasing a newer copy without
retaining clipboard history. Inbound and outbound text is capped at 1 MiB.
The connection advertises the RFB Extended Clipboard extension and exchanges
full UTF-8 text with servers that negotiate it; against servers without the
extension, standard cut text must encode losslessly as ISO-8859-1 and
unsupported text is rejected instead of silently becoming empty data.

## Share This Mac

The host path is deliberately app-owned. It does not start, configure, proxy,
or depend on `screensharingd`, Remote Management, or a VNC password. The direct
Mac-to-Mac path remains on Tailscale; a registered share can additionally use
an owner-scoped Crabfleet Worker relay for first-party browser access.

1. Tailscale status must report `BackendState=Running`, a valid active tailnet,
   an online signed-in user, and a CGNAT address in `100.64.0.0/10`.
2. The app captures up to four selected displays (default: main), each at a
   bounded even resolution no larger than 2560×1600. A display with any HEVC or
   H.264 viewer captures at 60 frames per second; Tight/JPEG-only displays use
   15 frames per second. When exactly one viewer is connected to a display, it may
   request a desktop size and the host
   re-targets the capture to aspect-fit that request up to the display's native
   pixel resolution and the active codec's cap, so the remote desktop follows
   the viewer window. With multiple viewers, the host returns
   ExtendedDesktopSize status 3 and leaves the shared capture size unchanged.
3. Each selected display has a TCP RFB listener on consecutive ports beginning
   at 5901 and a parallel QUIC listener on consecutive ports beginning at 5911.
   QUIC uses ALPN `crabfleet-rfb-1` and one bidirectional stream carrying the
   exact RFB byte stream; it intentionally retains TCP's ordered
   head-of-line behavior in this wave. Each display admits up to four authorized
   viewers across both transports. Binding the Tailscale address directly is
   not viable on current macOS — accepted Network-framework child connections
   re-bind a required local endpoint and fail with `EADDRINUSE` — so instead
   every accepted connection must prove it arrived on the exact Tailscale
   address before the server emits a single protocol byte; connections on any
   other interface are dropped immediately.
4. Before sending the RFB banner or any framebuffer data, the app resolves the
   peer through `tailscale whois` and requires an authorized node with the same
   user ID and login as the host.
5. With an authenticated Crabfleet API configuration, the host registers one
   stable endpoint per display in the signed-in user's private Fleet registry.
   The primary row keeps the host ID; additional rows use `-d2`, `-d3`, and
   `-d4` suffixes, and every row includes the display label. The receiving app
   discovers each display as its own card and directly connects with no VNC
   password. Each row also carries its QUIC port and certificate SPKI hash. The
   native viewer tries that pinned QUIC endpoint first, rejects a certificate
   mismatch, and transparently retries the registered TCP endpoint if QUIC or
   the RFB handshake has not completed in two seconds. Rows without both QUIC
   fields keep the rolling-upgrade-safe TCP behavior. The displayed
   `vnc://100.x.y.z:5901` and consecutive-port addresses remain Quick Connect
   fallbacks.
6. Every token-owned display registration enables the persisted "Allow browser
   access via Crabfleet" toggle, which defaults on. Each display publisher opens
   an authenticated WebSocket to its registration's `DesktopRelayDO`; a
   signed-in owner opens the matching browser viewer from Fleet. The relay
   treats binary messages as one opaque RFB byte stream, caps each WebSocket
   message at 512 KiB, and replaces prior sockets for the same role. Publishers
   chunk host writes at 256 KiB, wait without timing out while no viewer is
   paired, and reconnect with bounded backoff after transport loss. Legacy
   tokenless registrations cannot publish browser relays.
7. Direct and browser transports share a four-session gate per display. Tailnet
   sessions claim their reserved slot on the first client RFB byte; a relay
   connection carries exactly one session and counts against the same cap.
   Relay and tailnet viewers may coexist. View-only changes fan out atomically;
   quality is selected independently by capable viewers, while the host picker
   supplies the default for older viewers.
8. Clipboard sync with all connected peers is on by default and can be disabled
   before starting the share. Host changes fan out to every viewer; viewer text
   updates the shared pasteboard and fans out to the other viewers, last writer
   wins. Text copied on either Mac lands on the other through Extended Clipboard
   UTF-8 when the viewer negotiates it, with ISO-8859-1 cut text as the fallback;
   text that cannot be represented is dropped rather than mangled.
9. System audio streaming is on by default and can be toggled while sharing.
   Audio attaches only to primary-display sessions and capture starts when the
   first enabled viewer negotiates the Crabfleet audio extension, then stops
   after the last such viewer disconnects. Other VNC clients and secondary
   displays remain video-only.
10. "Start sharing when I log in" registers the bundled app as a login item and
    persists an auto-share preference, so the Mac comes back reachable after a
    reboot without manual setup (the equivalent of `--share-this-mac` for
    unattended hosts).

### Video pipeline

Crabfleet endpoints prefer the private `HEV1` HEVC encoding (`0x48455631`), then
the community Open H.264 encoding (type 50), then Tight/JPEG. A native viewer
advertises the `C444` pseudo-encoding (`0x43343434`) only after a startup
VideoToolbox probe creates a decoder for canned Main 4:4:4 parameter sets. With
that explicit capability, HEVC uses Main 4:4:4 in Auto and Sharp; Smooth and
clients without `C444` retain the byte-identical Main 4:2:0 path. Both video
encodings use the same rectangle envelope: a 32-bit payload length, reset flags,
and Annex-B access units. HEVC flag `0x4` marks Main 4:4:4 payloads. A chroma
transition tears down the encoder and changes that flag only on a keyframe that
also carries the existing context-reset flag. VideoToolbox encodes HEVC Main,
HEVC Main 4:4:4, or H.264 Constrained Baseline in low-latency realtime mode
without frame reordering; keyframes carry VPS/SPS/PPS for HEVC or SPS/PPS for
H.264. The viewer derives the RExt `hvcC` profile, compatibility, and constraint
bytes from those parameter sets, keeps bounded per-geometry decoder contexts,
waits for a random-access picture after resets, decodes every access unit in a
rectangle, and displays the last.
Initial capture is capped at 2560×1600, and either video codec may resize up to
4096×2304 within the selected display's native pixel size. HEVC setup or encode
failure retries H.264 before the session falls back to the 15 fps Tight/JPEG
path; third-party clients never offer the private HEVC number, and the Open
H.264 wire format remains unchanged.

ScreenCaptureKit dirty rectangles keep ordinary unchanged frames out of the
latest-wins pixel mailbox. Before sending a 4:4:4 keyframe, the host parses its
SPS and requires `chroma_format_idc == 3`; a rejected profile or silent encoder
downgrade permanently falls that client session back to 4:2:0 without breaking
video. Auto and Sharp send one doubled-bitrate keyframe
after two static seconds so text settles, then return to zero encode work;
Smooth omits that refresh. A capable viewer advertises the `QCTL`
pseudo-encoding (`0x5143544c`). A capable host confirms support with
server-to-client message 201 containing version byte `1` and two zero pad bytes;
the viewer sends no new message to an older host that omits this acknowledgement.
After acknowledgement, the viewer selects its session mode with client message
201: one mode byte (`0` Auto, `1` Sharp, or `2` Smooth) followed by two zero pad
bytes. The host accepts this message only after `QCTL` appeared in that
session's latest SetEncodings message; an unnegotiated request, unknown mode, or
nonzero padding fails the session. Older viewers and hosts retain the host's persisted
**Default quality** setting. The native toolbar picker persists per host, while
the browser picker persists per host in `sessionStorage`; both apply live
without a reconnect. The share sheet lists every active viewer and its mode.
4:2:0 Auto uses 1.5–30 Mbit/s and 4:4:4 Auto uses 2.25–45 Mbit/s at
up to 60 fps with a maximum frame QP of 40; 4:2:0 Sharp uses 8–40 Mbit/s and
4:4:4 Sharp uses 12–48 Mbit/s at up to 30 fps with a maximum frame QP of 30 to
preserve readable text even when VideoToolbox must sacrifice frames. Smooth
always uses 4:2:0 at 1.5–20 Mbit/s and up to 60 fps without a QP cap. The controller tracks
EWMA link throughput and send latency, reduces toward 80% of measured
throughput above 50 ms, and recovers by at most 1 Mbit/s per clear second scaled
by changed screen area. The share sheet reports codec and hardware detail,
frame rate, throughput, target bitrate, and dirty-area percentage. If a
VideoToolbox encoder does not support the optional QP property, video remains
active without the cap and the codec detail reports `QP cap unavailable`.
Active full-chroma sessions report `HEVC 4:4:4`; a session-level profile or SPS
fallback reports `4:4:4 unavailable`.

### Audio pipeline

The native viewer advertises the Crabfleet `CAF1` pseudo-encoding. Only after
that negotiation, and while the host's Stream audio toggle is on, the host
enables ScreenCaptureKit system-audio capture with its own process excluded.
The host converts PCM to mono or stereo AAC-LC at 48 kHz and 128 kbit/s and
sends a configuration record followed by timestamped access units through the
same serialized RFB connection writer as other server pushes. A bounded latest
window drops audio older than 200 ms so audio cannot delay video. Disabling
audio or ending the session sends an explicit stop record.

The viewer rebuilds its decoder whenever configuration changes, buffers about
100 ms before playback, drops late packets, and resets playback after gaps over
500 ms. Queued input and scheduled PCM are bounded. The desktop toolbar is
unmuted by default and provides a mute control; background desktops and all
sessions while the app is inactive are muted automatically. Third-party VNC
clients never receive the private audio message because they do not advertise
`CAF1`.

### Cursor pipeline

Share This Mac uses the standard RFB CursorWithAlpha (`-314`), Cursor (`-239`),
and PointerPos (`-232`) pseudo-encodings so fully negotiated displays can avoid
baking pointer movement into video. CursorWithAlpha is preferred and carries a Raw nested rectangle with a
premultiplied RGBA bitmap; classic Cursor remains the fallback for viewers that
advertise it. Shapes are capped at 128×128, validated before allocation, and
sent only after explicit per-session negotiation. The host polls the system
cursor on a dedicated 60 Hz queue, hashes shapes to suppress duplicates, and
suppresses position echoes for 250 ms after that session sends local pointer
input. Cursor-only framebuffer responses use the serialized RFB writer with a
100 ms deadline and alternate with video so pointer traffic cannot starve the
desktop.

ScreenCaptureKit cursor baking is shared per display. It is disabled only when
every active session on that display negotiated a cursor shape channel and is
reconciled on joins, leaves, and encoding changes with rollback and bounded
retry after configuration failure. Negotiated sessions continue receiving
cursor rectangles during mixed legacy/modern periods while baking stays on.

The RoyalVNCKit fork advertises CursorWithAlpha, classic Cursor, and PointerPos,
sets the received image as the focused/hovered AppKit cursor, and draws a clipped
remote overlay when PointerPos diverges from the local mouse. The browser
advertises CursorWithAlpha and PointerPos only, installs the received image as a
CSS canvas cursor, and keeps a framebuffer-scaled overlay visible for remote
movement, lost pointer focus, and resize transitions.

After the first Screen Recording grant, restart the bundled app before starting
the share. Ad-hoc development signatures do not provide a stable TCC identity,
so a rebuilt prototype may need permission again. Sign every iterative build
with the same Apple Development or Developer ID identity to preserve the app's
code requirement and permission identity.

Accessibility is not required to start the listener. Without it, Crabfleet
serves a view-only desktop. The persisted View only toggle can also discard
remote keyboard and pointer events live even when Accessibility is available.

Tailscale supplies the encrypted, ACL-controlled transport and peer identity;
RFB None authentication is accepted only inside that already-authenticated
direct channel. Browser sessions use RFB None only after the Worker has
authenticated the ownership-token host and the registration owner's browser
session.
QUIC adds TLS and pins the host's self-signed certificate by the SPKI SHA-256
hash carried opaquely in the private Fleet row. The host creates one persistent
P-256 ECDSA key and certificate in Keychain on first share. The original design
called for Ed25519, but the public Security.framework `SecIdentity` API required
by Network.framework cannot create or import an Ed25519 identity; P-256 keeps
the private key non-exported and supplies the same pinned, self-signed trust
boundary.
The relay never stores the registration token or RFB bytes. The direct listener
is not reachable on Wi-Fi, Ethernet, loopback, or a public address. The host app
must remain running, and stopping the share cancels the listener, relay
publisher, and capture stream.

### Browser viewer

Fleet lists each owned registration with an **Open in browser** action. The
fullscreen Preact viewer speaks RFB 3.8 over the owner-authenticated relay,
offers feature-probed HEVC, Open H.264, and Tight/JPEG in that order, and never
changes the host's default BGRA pixel format. HEVC is advertised only when the
browser accepts the Main profile; the separate `C444` capability requires the
RExt 4:4:4 probe. Decoder failure renegotiates HEVC to H.264 to Tight without
affecting older hosts or clients. Framebuffer requests remain paced one at a
time, including empty updates, and ExtendedDesktopSize requests are debounced
until the host announces its screen layout.

The viewer renders aspect-fit at device pixel ratio, forwards bounded pointer
and keyboard input, renders negotiated CursorWithAlpha shapes locally, uses
PointerPos for a remote overlay when another viewer or the host moves the
pointer, and synchronizes text clipboard through the same Extended
Clipboard dialect as the native client. When WebCodecs AAC-LC and AudioWorklet
are both available it also negotiates `CAF1`, primes about 100 ms of audio in a
120 ms bounded worklet buffer, drops late packets, and resynchronizes gaps over
500 ms. Audio starts muted; **Unmute audio** supplies the required user gesture,
and hidden tabs mute immediately while continuing bounded playback progress.
The **Stats** button reveals local-only codec, decoded-fps, incoming-Mbit/s,
audio-drop, and jitter-depth diagnostics; the overlay is hidden by default.
The adjacent **Auto / Sharp / Smooth** picker sends negotiated `QCTL` updates
for this browser session only and restores the tab's per-host choice from
`sessionStorage`.

Fleet registrations also carry a `webtransport` capability boolean. It remains
`false` and is passed through opaquely for probe-only groundwork: the browser
does not attempt WebTransport in this wave because Cloudflare Workers
WebTransport ingress is not generally available. Browser sessions continue to
use the authenticated WebSocket relay.

Remote clipboard reads use only the snapshot last approved with **Send to
Mac**; loading or editing clipboard text never exposes it by itself. Reading
the browser's system clipboard requires the user to press **Load system
clipboard** before explicitly approving that snapshot.

## License boundary

The macOS artifact links only a repo-local RoyalVNCKit source fork, which has no
third-party dependencies. Crypto uses the operating system's CommonCrypto and
CryptoKit plus a small in-fork big-integer implementation for Apple Remote
Desktop Diffie-Hellman. The fork is based on pinned upstream commit
`337197afdb32020d3dfdb7d058989115b740cdc4`, preserves the MIT license, and
records provenance beside its source. It adds remote-input size limits and
restricts decoders/authentication to reviewed paths. The app does not copy,
import, link, or embed KasmVNC, TurboVNC, TigerVNC, or their browser clients.

A GPL VNC server may remain a separate Linux process or image. Communication
must stay at arm's length through ordinary RFB over an SSH tunnel. Distribution
and modification obligations still apply to that server or image. A container
is packaging, not a license boundary. OSPO or counsel must approve the final
organizational and distribution model.

VNC password authentication uses the operating system's CommonCrypto DES with
the VNC bit-reversed-key variant implemented in the fork's Swift shim. The fork
no longer bundles or builds the modified D3DES source.

## Current viewer limits

- Text clipboard only. UTF-8 flows end to end when the server negotiates the
  Extended Clipboard extension; image and file clipboard formats are not
  implemented, and servers without the extension remain limited to ISO-8859-1.
- The fleet deck uses paced framebuffer decoding plus cached previews, not six
  continuously rendering Metal surfaces. A production live mosaic should use
  one app-owned Metal compositor for zero-copy multi-tile rendering.
- No input method editor integration.
- Client-requested remote resize works against servers that advertise
  ExtendedDesktopSize, including Share This Mac hosts, which aspect-fit the
  request instead of adopting arbitrary layouts; multi-screen layout requests
  remain unsupported.
- Generic RoyalVNCKit connections use TCP and must remain bound to loopback
  behind an authenticated SSH tunnel. Share This Mac may inject its single
  Network.framework QUIC stream through the same byte-stream adapter after
  Fleet SPKI verification; it is the identity-gated tailnet exception.
- The hardened prototype negotiates standard VNC password or no-auth security
  only. The bundled ARD Diffie-Hellman path now requires a full-width
  probabilistic safe-prime group and nonzero public/shared results, but ARD,
  UltraVNC MS Logon II, Tight security, and TLS remain disabled in the app until
  their complete interoperability surfaces are enabled and tested.
- Password authentication uses per-call CommonCrypto DES and is safe for
  concurrent sessions.
- App-owned hosting shares up to four displays through separate Fleet rows and
  listeners, with up to four viewers per display. HEVC and Open H.264 capture at
  60 fps at an initial 2560×1600 cap and resize up to 4096×2304 when only one
  viewer is connected; Tight/JPEG fallback remains capped at 15 fps and
  2560×1600.
- Audio is host-to-viewer system audio only. Microphone, reverse audio,
  per-application capture, browser playback, and non-AAC codecs are unsupported.
- A connecting peer must be another device owned by the same Tailscale user.
  Team-wide or named-user sharing is intentionally unsupported.

## Next RoyalVNCKit fork requirements

Keep further changes narrow and upstreamable:

1. Extended clipboard image and file formats on top of the existing UTF-8 text
   negotiation.
2. Public read-only framebuffer IOSurface plus update notifications so one
   Metal compositor can render all fleet previews without one drawable and
   command queue per card.

## Integration boundary

The prototype connects to a user-entered Crabfleet deployment through the
versioned native API. It creates a short-lived device authorization, opens the
same-origin `/native/link/*` page for browser approval, exchanges the approved
device code for a 24-hour `fleet:read` bearer, validates the native session, and
reads `/api/native/v1/fleet`. The deployment URL is persisted as a preference;
the bearer is stored per exact origin in Keychain with a this-device-only,
when-unlocked accessibility policy. Disconnect removes the local Keychain item
synchronously before starting best-effort server revocation; if local removal
fails, the existing connection is kept so the user can retry instead of
silently orphaning a restorable credential. Switching deployments applies the
same local-cleanup fence.

When a deployment gateway redirects the initial device request, the client can
instead follow the same-origin `resource_metadata` URL in the protected route's
Bearer challenge and its explicit read-only scope, dynamically register a
public client, use authorization-code PKCE, and receive the callback on the
exact loopback redirect URI returned by registration. The resulting gateway
bearer and optional refresh grant are
stored under the same deployment-scoped Keychain policy and are sent only to
`/mcp/crabfleet/native/v1/session`, `/mcp/crabfleet/native/v1/fleet`, and
`/mcp/crabfleet/native/v1/native-vnc`.
The client requires each RFC 9728 route challenge to identify its exact
protected resource and requests all identifiers. For gateways that return
authorization-server metadata directly, a `resource` field is rejected and an
explicit `api://` scope must match the issued JWT's `aud` claim before use.
The app asks for explicit trust before contacting any OAuth provider origin
outside the deployment itself and rejects oversized aggregate scope lists
before registration.
An unauthorized read rotates an available refresh grant in Keychain before one
retry; a rejected refresh grant expires the saved connection.
Those gateway routes must authenticate the user, strip the gateway bearer
before proxying, and map only those exact read methods to Crabfleet's
authenticated native session, Fleet, and VNC-grant routes. Unknown paths,
queries, other mutations, and WebSocket upgrades remain closed.

Saved and ad-hoc VNC profiles are also available through an explicit local-only
mode. That mode does not contact a deployment, synthesize Fleet data, or create
an API credential; the user can return to deployment sign-in at any time.

Native requests do not accept, persist, or replay the browser's
`crabbox_session` cookie. There is no fixture fallback: without a valid native
credential, deployment Fleet data remains disconnected. API redirects are rejected so a
bearer cannot follow a deployment or proxy redirect to another origin. Response
bodies are accumulated incrementally and the URL session is canceled as soon
as a body crosses the 5 MiB limit. While an approved device code remains valid,
the app retries transient network and `503` failures without opening a second
browser approval, including transient session validation after the token
handoff. Cancellation or permanent validation failure revokes a handed-off
token from a fresh cleanup task. The device-link bearer exposes only the current
user's redacted, tenant-visible Fleet registry; it cannot mutate sessions,
attach terminals, mint desktop connections, or call the browser REST surface.
Retired deployment clients finish their cleanup and explicitly invalidate the
delegate-backed URL session so reconnects do not retain old network stacks.

Deployments behind a trusted identity proxy must route only these exact native
requests to Crabfleet without browser-SSO interception:

- `POST /api/native/v1/auth/device`
- `POST /api/native/v1/auth/token`
- `DELETE /api/native/v1/auth/token`
- `GET /api/native/v1/session`
- `GET /api/native/v1/fleet`

`/native/link/*` stays browser-authenticated: approval uses the signed-in
browser identity and never trusts identity asserted by the native app.
GitHub-approved grants are rechecked against live organization membership,
team state, and the deployment allowlist before handoff and on every native API
use. The encrypted GitHub credential used for those checks remains server-side
and is never exposed to the app.

The app also accepts a manual loopback host, port, and in-memory credential for
the actual RFB connection. The Worker browser endpoint
`/api/interactive-sessions/:id/vnc` redirects to browser/noVNC desktop
connections; it is not a raw-RFB contract for native clients.

For a controllable desktop-capable Crabbox lease, the native Fleet response
includes its non-secret provider lease identifier. The app starts the installed
`crabbox vnc --native-handoff` helper directly, consumes one bounded JSON line
from a private stdout pipe, and connects only to the returned IPv4 loopback
endpoint. The helper owns the SSH tunnel in the foreground. Closing, replacing,
evicting, or losing the VNC session terminates that helper and tunnel. The VNC
password remains in process memory and never enters argv, a URL, defaults, or a
file. Manual entry remains the fallback for non-Crabbox targets.

Share This Mac does not use the runtime-adapter boundary. Its direct Mac-to-Mac
path depends only on the local Tailscale client; registered token-owned shares
may also publish the optional owner-scoped browser relay described above.

## Build

```sh
pnpm macos:test
pnpm macos:bundle
```

The bundle command creates an ad-hoc signed local app for visual testing by
default. For a stable Screen Recording permission across rebuilds, create or
synchronize an Apple Development identity in Xcode Settings > Accounts, then
use it consistently:

```sh
CODE_SIGN_IDENTITY="Apple Development: Your Name (TEAMID)" pnpm macos:bundle
```

Production needs a Developer ID Application identity, hardened runtime, secure
timestamp, notarization, and final third-party-notice review. The bundle script
enables the signing-side distribution requirements when
`CODE_SIGN_HARDENED_RUNTIME=1` is set with a Developer ID identity.
