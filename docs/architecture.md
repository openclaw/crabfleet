---
title: Architecture
layout: default
permalink: /architecture/
description: "Native viewers, desktop hosts, discovery, and the VNC relay."
---

# Architecture

Crabfleet's main application is the native macOS VNC viewer and host. Go connectors implement desktop hosting on Linux and Windows. The optional Cloudflare Worker supports desktop identity, discovery, and an authenticated browser relay.

```text
Mac viewer ── RFB over private TCP / pinned QUIC ── Desktop host
                                                       │
                                               outbound WebSocket
                                                       │
Browser VNC viewer ── authenticated WebSocket ── DesktopRelayDO
                            │
                     Desktop backend
                      identity + D1
```

## Native and Go components

`macos/CrabfleetMac` contains the Mac UI, saved connections, Metal viewer, ScreenCaptureKit host, and vendored RoyalVNCKit protocol implementation. `cmd/crabfleet-connect` uses the Go host in `internal/rfb` and platform capture/input backends in `internal/connect`. `internal/connector` handles device authorization and desktop publication; `internal/rfbclient` bridges the Linux Wayland host.

Direct connections negotiate supported RFB capabilities. New media behavior requires explicit negotiation, inbound lengths are bounded, media writes have deadlines, and input teardown is fenced and idempotent.

## Desktop service

`src/index.ts` dispatches browser sign-in, device authorization, native discovery, connector publication, and desktop relay routes. `WorkerApplication` composes only the desktop host repository/service and native authorization service. `src/app` is the browser companion, with an independent RFB client in `src/app/rfb`.

D1 stores users, allowlists, browser sessions, native device links and access tokens, desktop registrations, and access audit events. Existing SQL migration history remains unchanged for deployed databases. Retired workspace tables are not read or written by the application.

Desktop discovery always filters by the authenticated user's stable owner subject. Bootstrap token rotation retains the same desktop owner identity. Role changes do not grant access to someone else's desktops.

## Relay ownership

`DesktopRelayDO` pairs one authenticated host publication with one owner-authenticated viewer. The host uses a publication ownership token; the browser uses its authenticated session. The relay carries a bounded opaque RFB stream without persisting frames or VNC passwords. Replacement and close callbacks are generation-fenced.

Only the ownership-authenticated relay may use RFB None internally. Direct listeners retain their own password authentication. Desktop host publication recovery and removal use the existing ownership token and publication ID contracts.

## Authorization

Browser access supports GitHub membership plus an allowlist, a configured trusted identity proxy, or an owner recovery token. GitHub OAuth requests identity, email, and membership scopes. Native viewer tokens use `fleet:read`; Linux connectors request `desktop:publish` separately. Credentials are scoped to the deployment, expire, and are reauthorized against current membership/access policy.

Cron only prunes expired device authorization state. Crabfleet does not provision agent workspaces, run boards, relay terminals, or inject model credentials.
