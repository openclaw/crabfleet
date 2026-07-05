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
- Share This Mac captures the primary display with ScreenCaptureKit and serves
  RFB 3.8 Tight/JPEG frames without enabling Apple's Screen Sharing daemon.
- The host binds port 5901 only to a verified Tailscale `100.64.0.0/10` address,
  requires a valid identity on the active tailnet, and admits only a
  Tailscale-authorized peer owned by that same user.
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
or depend on `screensharingd`, Remote Management, a VNC password, a public
relay, Cloudflare, or the Crabfleet Worker.

1. Tailscale status must report `BackendState=Running`, a valid active tailnet,
   an online signed-in user, and a CGNAT address in `100.64.0.0/10`.
2. The app captures the selected display (default: main) at a bounded even
   resolution no larger than 1600×1000 and encodes at most 15 Tight/JPEG frames
   per second. When the connected viewer requests a desktop size, the host
   re-targets the capture to aspect-fit that request up to the display's native
   pixel resolution (bounded at 2560×1600), so the remote desktop follows the
   viewer window.
3. An RFB listener binds port 5901. Binding the Tailscale address directly is
   not viable on current macOS — accepted Network-framework child connections
   re-bind a required local endpoint and fail with `EADDRINUSE` — so instead
   every accepted connection must prove it arrived on the exact Tailscale
   address before the server emits a single protocol byte; connections on any
   other interface are dropped immediately.
4. Before sending the RFB banner or any framebuffer data, the app resolves the
   peer through `tailscale whois` and requires an authorized node with the same
   user ID and login as the host.
5. With an authenticated Crabfleet API configuration, the host registers its
   stable endpoint in the signed-in user's private Fleet registry. The receiving
   app discovers and directly connects that card with no VNC password. Quick
   Connect with the displayed `vnc://100.x.y.z:5901` address remains a fallback.
6. Clipboard sync with the connected peer is on by default and can be disabled
   before starting the share. Text copied on either Mac lands on the other
   through Extended Clipboard UTF-8 when the viewer negotiates it, with
   ISO-8859-1 cut text as the fallback; text that cannot be represented is
   dropped rather than mangled.
7. "Start sharing when I log in" registers the bundled app as a login item and
   persists an auto-share preference, so the Mac comes back reachable after a
   reboot without manual setup (the equivalent of `--share-this-mac` for
   unattended hosts).

After the first Screen Recording grant, restart the bundled app before starting
the share. Ad-hoc development signatures do not provide a stable TCC identity,
so a rebuilt prototype may need permission again. Sign every iterative build
with the same Apple Development or Developer ID identity to preserve the app's
code requirement and permission identity.

Accessibility is not required to start the listener. Without it, Crabfleet
serves a view-only desktop and discards remote keyboard and pointer events.

Tailscale supplies the encrypted, ACL-controlled transport and peer identity;
RFB None authentication is accepted only inside that already-authenticated
channel. The listener is not reachable on Wi-Fi, Ethernet, loopback, or a public
address. The host app must remain running, and stopping the share cancels the
listener and capture stream.

## License boundary

The macOS artifact links only a repo-local RoyalVNCKit source fork and its
permissively licensed dependency. The fork is based on pinned upstream commit
`337197afdb32020d3dfdb7d058989115b740cdc4`, preserves the MIT license, and
records provenance beside its source. It adds remote-input size limits and
restricts decoders/authentication to reviewed paths. The app does not copy,
import, link, or embed KasmVNC, TurboVNC, TigerVNC, or their browser clients.

A GPL VNC server may remain a separate Linux process or image. Communication
must stay at arm's length through ordinary RFB over an SSH tunnel. Distribution
and modification obligations still apply to that server or image. A container
is packaging, not a license boundary. OSPO or counsel must approve the final
organizational and distribution model.

RoyalVNCKit also bundles a modified D3DES implementation. Its header identifies
the original implementation as public domain but does not contain an explicit
permission grant for the separately copyrighted VNC changes. Before distributing
the native client, either replace that implementation with a reviewed system
crypto implementation, remove VNC-password authentication and exclude D3DES
from the build, or obtain written provenance approval.

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
- RoyalVNCKit provides raw TCP only. Generic production connections must remain
  bound to loopback behind an authenticated SSH tunnel; Share This Mac is the
  identity-gated tailnet exception.
- The hardened prototype negotiates standard VNC password or no-auth security
  only. ARD Diffie-Hellman, UltraVNC MS Logon II, Tight security, and TLS remain
  disabled until their parsers and cryptography are replaced or fully tested.
- Password authentication uses a process-global DES key schedule. The fork
  serializes that path; replace it before concurrent password-auth sessions.
- App-owned hosting shares one selected display at a time to a single client,
  as lossy Tight/JPEG at most 15 fps, capped at 1600×1000 until the viewer
  requests a size (then up to native pixels, bounded at 2560×1600).
- Audio is not implemented.
- A connecting peer must be another device owned by the same Tailscale user.
  Team-wide or named-user sharing is intentionally unsupported.

## Next RoyalVNCKit fork requirements

Keep further changes narrow and upstreamable:

1. Extended clipboard image and file formats on top of the existing UTF-8 text
   negotiation.
2. Public read-only framebuffer IOSurface plus update notifications so one
   Metal compositor can render all fleet previews without one drawable and
   command queue per card.
3. Replace or isolate the process-global D3DES key schedule before concurrent
   password authentication.

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

Share This Mac does not use this Worker/runtime-adapter boundary. It is a local
Mac-to-Mac path whose only network dependency is the local Tailscale client.

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
