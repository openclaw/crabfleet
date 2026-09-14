---
title: Administration
layout: default
permalink: /admin/
description: "Configure the Crabfleet desktop discovery and VNC relay service."
---

# Administration

The desktop service uses Cloudflare Workers, D1, and `DesktopRelayDO`. The public product router sends `crabfleet.ai` to the documentation site. GitHub Pages hosts the docs.

## Access

Configure GitHub OAuth and an allowlist, or a trusted identity proxy. Owners can use **Manage access** in the browser companion to allow GitHub users, teams, or email identities. Desktop registrations remain private to their owner regardless of role.

The native Mac app receives `fleet:read` after browser approval. Linux connectors request `desktop:publish` and can renew that grant while running. Removing an allowlist entry or changing identity-provider configuration invalidates later authorization checks.

## Configuration

| Setting                                                               | Purpose                                                                    |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `DB`                                                                  | D1 desktop and identity database                                           |
| `DESKTOP_RELAY`                                                       | `DesktopRelayDO` namespace                                                 |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`                            | GitHub OAuth credentials                                                   |
| `GITHUB_ORG`                                                          | Membership organization; defaults to `openclaw`                            |
| `GITHUB_REDIRECT_URI`                                                 | Exact HTTPS callback ending in `/auth/github/callback`                     |
| `CRABBOX_BOOTSTRAP_TOKEN`                                             | Optional owner recovery token                                              |
| `CRABBOX_TOKEN_ENCRYPTION_KEY`                                        | Encryption for device token handoff and membership refresh credentials     |
| `CRABFLEET_LABEL`, `CRABFLEET_CANONICAL_URL`, `CRABFLEET_PRODUCT_URL` | Desktop service branding and origins                                       |
| `CRABFLEET_TRUSTED_PROXY_ORIGIN`, `CRABFLEET_TRUSTED_PROXY_SECRET`    | Exact trusted backend origin and identity assertion secret                 |
| `CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN`                               | Browser-visible proxy origin when different                                |
| `CRABFLEET_TRUSTED_USER_HEADER`                                       | Trusted identity header; defaults to `X-Authenticated-User`                |
| `CRABFLEET_TRUSTED_PROXY_AUTO_ROLE`                                   | Optional automatic `viewer` or `maintainer` role                           |
| `CRABFLEET_DEV_LOGIN_ENABLED`                                         | Loopback-only browser development login; cannot approve native credentials |

The existing `CRABBOX_*` credential names, browser cookie names, Worker name `crabbox-ai`, and database identity remain stable for deployed desktop clients. They do not enable a workspace runtime.

A trusted proxy must strip caller-supplied identity assertions. Pass the exact native device/token/discovery routes, connector routes, and authenticated host relay transport through without browser SSO redirects. `/native/link/*` and browser viewer routes remain browser-authenticated. Independent credentials are still checked by Crabfleet.

## Deploy

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm deploy
```

`CLOUDFLARE_API_TOKEN` supplies deployment and D1 migration access. `CLOUDFLARE_DNS_API_TOKEN` is required when converging the configured app, product, and docs domains. Domain setup no longer manages an SSH gateway.

Pushes to main run the desktop deployment workflow. `pnpm deploy:product` deploys only the docs router. These commands publish live infrastructure.

## Upgrade from the retired workspace product

Before deploying the desktop-only backend, stop or migrate any remaining agent workspaces using the previous version and export any history you need. The new backend has no workspace lifecycle, terminal, card, or agent APIs.

The appended Durable Object migration removes the retired `Sandbox` and `SessionControlDO` classes and their stored state. Only `DesktopRelayDO` remains. Sandbox containers, runtime coordinator services, R2 archive bindings, and model credential injection are removed from the deployment configuration.

D1 migration history is retained intact so existing users, grants, and desktop registrations survive upgrades. Historical workspace tables are left untouched; deleting production data is a separate operator action. Old R2 archives and external runtime resources are not deleted by this source change.
