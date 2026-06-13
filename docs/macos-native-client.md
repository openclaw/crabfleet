# Native macOS client experiment

Status: early prototype. The app lives in `macos/CrabfleetMac` and provides a
SwiftUI fleet browser plus an AppKit-hosted, Metal-rendered VNC surface.

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

The fork exposes an externally managed clipboard mode, so no VNC connection
polls or writes `NSPasteboard.general` directly. One app-owned coordinator sends
only stable local text changes to the focused desktop, baselines rather than
sending the existing clipboard on focus/connect, suppresses server echoes, and
quarantines clipboard text received from background desktops. The focus toolbar
provides explicit Send Clipboard and Get Clipboard recovery actions. Clipboard
sync remains opt-in. A deliberate local copy supersedes a quarantined value for
the focused desktop. Versioned pasteboard snapshots and bounded SHA-256 echo
fingerprints prevent delayed server echoes from erasing a newer copy without
retaining clipboard history. Inbound and outbound text is capped at 1 MiB;
standard RFB clipboard text must encode losslessly as ISO-8859-1, and
unsupported text is rejected instead of silently becoming empty data.

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

- Text clipboard only; the current protocol path is ISO-8859-1, not complete
  Unicode, image, or file clipboard support.
- Clipboard mode is bidirectional or off, with explicit Send Clipboard and Get
  Clipboard recovery. Directional send-only/receive-only modes remain future.
- The fleet deck uses paced framebuffer decoding plus cached previews, not six
  continuously rendering Metal surfaces. A production live mosaic should use
  one app-owned Metal compositor for zero-copy multi-tile rendering.
- No input method editor integration.
- Server-driven framebuffer resize works; client-requested remote resize does
  not exist yet.
- RoyalVNCKit provides raw TCP only. Production connections must remain bound
  to loopback behind an authenticated SSH tunnel.
- The hardened prototype negotiates standard VNC password or no-auth security
  only. ARD Diffie-Hellman, UltraVNC MS Logon II, Tight security, and TLS remain
  disabled until their parsers and cryptography are replaced or fully tested.
- Password authentication uses a process-global DES key schedule. The fork
  serializes that path; replace it before concurrent password-auth sessions.

## Next RoyalVNCKit fork requirements

Keep further changes narrow and upstreamable:

1. UTF-8 extended clipboard negotiation, advertised server limits, images,
   files, and directional clipboard modes.
2. Public read-only framebuffer IOSurface plus update notifications so one
   Metal compositor can render all fleet previews without one drawable and
   command queue per card.
3. Replace or isolate the process-global D3DES key schedule before concurrent
   password authentication.

## Integration seam

The prototype accepts a manual loopback host, port, and in-memory credential.
One-click operation should add two narrow, versioned Crabbox CLI contracts:

```text
crabbox fleet list --state active --json
crabbox vnc connect --id <lease> --json
```

`fleet list` should normalize the coordinator's user-visible leases and rely on
the CLI's existing login. It must not put an administrator token in the app.

`vnc connect` should be a foreground child process that owns the SSH tunnel and
emits one versioned NDJSON readiness event:

```json
{
  "schemaVersion": 1,
  "type": "ready",
  "leaseId": "lease-id",
  "endpoint": { "host": "127.0.0.1", "port": 5907 },
  "auth": { "kind": "vnc-password", "secret": "ephemeral-secret" },
  "expiresAt": "2026-06-13T09:00:00Z"
}
```

The secret crosses only the anonymous stdout pipe: never argv, URLs, logs,
files, or defaults. Closing the viewer terminates the child and its tunnel.
Until these contracts exist, `/api/fleet` can populate a Crabfleet-specific
preview but is not authoritative coordinator-wide discovery.

## Build

```sh
pnpm macos:test
pnpm macos:bundle
```

The bundle command creates an ad-hoc signed local app for visual testing.
Production needs an Xcode app target, hardened runtime, signing, notarization,
and final third-party-notice review.
