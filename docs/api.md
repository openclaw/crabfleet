---
title: Desktop API
layout: default
permalink: /api/
description: "Desktop sign-in, discovery, publication, and authenticated VNC relay APIs."
---

# Desktop API

Crabfleet exposes desktop identity, private discovery, host registration, and an opaque RFB relay. JSON endpoints return structured errors with HTTP status codes. Native request bodies are limited to 1 KiB.

## Browser identity

| Method     | Route                     | Result                                                               |
| ---------- | ------------------------- | -------------------------------------------------------------------- |
| GET        | `/api/auth`               | Available authentication methods and public deployment configuration |
| GET        | `/login/github`           | Start GitHub OAuth                                                   |
| GET        | `/auth/github/callback`   | Complete OAuth and set the browser session                           |
| POST       | `/api/login/token`        | Owner recovery login with `{ "token": "…" }`                         |
| POST       | `/api/logout`             | Delete the current browser session                                   |
| GET        | `/api/session`            | Authenticated user and authentication methods                        |
| GET        | `/api/fleet`              | Private desktop discovery                                            |
| GET / POST | `/api/admin/allow`        | Owner-only allowlist read/update; POST accepts `value` and `role`    |
| DELETE     | `/api/admin/allow/:value` | Owner-only removal of an encoded allowlist value                     |

## Native device authorization

`POST /api/native/v1/auth/device` accepts `clientName` and optional `scope`. The default is `fleet:read`; connectors explicitly request `desktop:publish`. It returns `deviceCode`, `verificationUri`, `expiresAt`, and `intervalSeconds`.

Open `verificationUri` in a signed-in browser and approve the device. Poll `POST /api/native/v1/auth/token` with `{ "deviceCode": "…" }`. Pending responses use 202; polling too quickly returns 429 with `retry-after`. Approval returns `accessToken`, `tokenType`, `expiresAt`, and `user`. Store the token securely for that deployment.

Approval and completion pages adapt to phone screens; the link can be opened on another device signed into the same deployment. GET never approves a device. POST requires the authenticated browser identity and exact public origin, plus the link-bound CSRF cookie for cookie-authenticated sessions. Expired or already-used links return `410` with an HTML recovery page. An unauthenticated deployment without GitHub login returns `401` with a link to sign in.

Each GitHub-backed native request allows up to 10 seconds for GitHub membership refresh, including team pagination. A timeout returns a retryable `503` without revoking the native credential.

| Method     | Route                       | Authorization                                                      |
| ---------- | --------------------------- | ------------------------------------------------------------------ |
| GET        | `/api/native/v1/session`    | Native bearer; returns user and deployment                         |
| GET        | `/api/native/v1/fleet`      | `fleet:read`; returns private desktop discovery                    |
| DELETE     | `/api/native/v1/auth/token` | Revoke the presented native bearer                                 |
| GET / POST | `/native/link/:code`        | Browser-authenticated approval with origin and confirmation checks |

The fleet envelope contains `generatedAt`, `registryAvailable`, `desktopHosts`, `canonicalUrl`, and `productUrl`. For released Mac clients, it also retains `sessions: []` and `totals: { "active": 0, "sessions": 0, "vnc": 0 }`. These legacy counters describe retired workspace sessions; use `desktopHosts.length` for the desktop count. There are no workspace sessions or workspace VNC grants.

Each desktop contains `id`, `owner`, `name`, `address`, `port`, `relayOnly`, `quicPort`, `quicCertHash`, `webtransport`, `relayCapable`, `createdAt`, and `updatedAt`. Times are Unix milliseconds. Ownership secrets are omitted from discovery responses.

## Host registration

Browser-authenticated Mac publication uses the routes below. A native viewer's `fleet:read` token is a discovery credential and does not authorize host registration. The Mac publisher currently receives its browser session through launch configuration; Linux uses the separate connector API.

| Method | Route                              | Action                                       |
| ------ | ---------------------------------- | -------------------------------------------- |
| PUT    | `/api/desktop-hosts/:id`           | Register/refresh a desktop                   |
| POST   | `/api/desktop-hosts/:id?recover=1` | Recover ownership using body `publicationID` |
| DELETE | `/api/desktop-hosts/:id`           | Remove the owned publication                 |

Registration accepts `name`, `address`, `port`, optional `quicPort` and `quicCertHash`, optional `webtransport`, and optional `relayOnly`. Direct addresses must be Tailscale IPv4 addresses. A relay-only host requires token ownership.

Use `x-crabfleet-ownership-mode: token-v1` and a durable `x-crabfleet-publication-id` to obtain an `ownershipToken`. Keep both private. Removal uses `x-crabfleet-ownership-token`. Publication retries and recovery preserve the existing ownership fences; an older publisher cannot remove a replacement.

## Linux connector

These routes require a `desktop:publish` bearer:

| Method | Route                                         | Action                                                                 |
| ------ | --------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | `/api/connector/v1/session`                   | Validate the connector identity                                        |
| POST   | `/api/connector/v1/auth/renew`                | Renew current publication authorization                                |
| PUT    | `/api/connector/v1/desktop-hosts/:id`         | Publish with `x-crabfleet-publication-id`; token ownership is required |
| POST   | `/api/connector/v1/desktop-hosts/:id/recover` | Recover ownership with the publication ID header                       |
| DELETE | `/api/connector/v1/desktop-hosts/:id`         | Remove with `x-crabfleet-ownership-token`                              |

## VNC relay

`GET /api/desktop-hosts/:id/relay/host` upgrades to WebSocket after verifying the host's ownership token. `GET /api/desktop-hosts/:id/relay/viewer` upgrades after checking the browser identity owns that desktop and validating any browser Origin header.

The relay transports opaque RFB bytes with bounded queues and deadline-aware endpoint behavior. It does not expose host ownership credentials or store video. Direct VNC authentication remains separate; RFB None is allowed only inside an ownership-authenticated relay publication.
