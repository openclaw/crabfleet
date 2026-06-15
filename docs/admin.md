---
title: Admin
layout: default
permalink: /admin/
description: "Access control, allowlists, policy, authentication, and operations for Crabfleet."
---

# Admin

The Admin drawer manages user/team access, enabled repos, card policy defaults, and `CRABBOX.md` evaluation. Owner role is required for mutations.

## Roles

### Owner

- Manage user/team allowlists.
- Enable or disable repos.
- Configure concurrency, retention selection, and merge intent.
- Evaluate repo `CRABBOX.md`.
- Perform all maintainer actions.

### Maintainer

- Create and move cards.
- Start/pulse/stall card attempts.
- Create, attach, share, control, delete, and clean up visible interactive sessions.
- Take over active card attempts when the runtime descriptor advertises takeover.

Maintainers cannot edit org policy or allowlists.

### Viewer

- Read Board and Fleet state.
- Open session logs.
- Use a public session share link.
- Request delegated terminal control where enabled.

Viewers cannot create cards or sessions or mutate policy. Terminal subscription additionally requires session ownership, a valid share token, or an approved control grant.

## Access Control

### Direct Users

Format:

```text
@login
email@example.com
```

Direct email/login entries are also the identity form accepted from trusted reverse proxies.

### Teams

Format:

```text
@org/team
```

GitHub OAuth refreshes org/team membership at login. The strongest matching role wins across direct and team entries:

```text
owner > maintainer > viewer
```

Trusted-proxy assertions cannot claim team entries; proxy users need a direct login/email allowlist entry.

### Repositories

Enabled repos use `owner/repo` syntax. They control:

- card creation and runtime claims;
- issue/PR number lookup;
- `CRABBOX.md` evaluation;
- interactive-session repo selection;
- scoped Sandbox GitHub credential injection.

Disabling a repo preserves existing rows but blocks new work against it.

## Policy

### Concurrent Cap

Range: `1` to `200`; default `20`.

The cap applies to cards in Running. When capacity is exhausted, a start request leaves the card queued and records a capacity event. Crabfleet does not run a background FIFO scheduler; an operator or caller starts/pulses cards as capacity changes.

### Retention Selection

Allowed values: `14`, `30`, or `60` days; default `30`.

This is stored product policy. Current cleanup behavior is session-state driven:

- finalized interactive sessions retain D1 events and R2 archive pointers until explicit dead-session cleanup;
- cleanup transactionally removes D1 session/event/archive rows, then best-effort deletes R2 objects;
- card/run events remain in D1.

The numeric retention selection is not currently a time-based deletion job.

### Merge Intent

Allowed values:

- `guarded`
- `maintainers`
- `disabled`

The setting is stored and displayed with card merge policy. Crabfleet does not currently inspect PR checks, merge PRs, or call ClawSweeper. Treat this field as future policy intent, not active merge authority.

## Repo Workflows

Owners can refresh `CRABBOX.md` for an enabled repo from Admin.

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

Stored evaluation state:

- `ok`, `missing`, `invalid`, or `error`;
- source path and commit SHA;
- parsed config;
- prompt guidance body;
- parse/fetch error;
- evaluation timestamps.

Only runtime and merge defaults are enforced. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body remain visible stored metadata. Invalid configs do not affect card defaults or runtime selection.

Private repo refresh requires deployment `GITHUB_TOKEN` contents access. The Worker does not use the current browser OAuth token for this fetch.

## Authentication

### GitHub OAuth

Normal OpenClaw browser and SSH-link authentication.

Required:

- `GITHUB_CLIENT_ID`
- `GITHUB_CLIENT_SECRET`
- `GITHUB_ORG` (defaults to `openclaw`)

Requested scopes:

```text
read:user read:org repo
```

The repo scope supports per-session GitHub CLI access inside managed Sandbox sessions. OAuth tokens are encrypted in D1 only when `CRABBOX_TOKEN_ENCRYPTION_KEY` or the `GITHUB_CLIENT_SECRET` fallback is available.

`GITHUB_REDIRECT_URI`, when configured, is authoritative and must be an absolute HTTPS URL with exact `/auth/github/callback` path and no credentials, query, or fragment. Login and SSH-link flows canonicalize to it before creating host-only state cookies.

GitHub sessions last 15 minutes and require reauthentication after expiry.

### Trusted Reverse Proxy

Required:

- `CRABFLEET_TRUSTED_PROXY_ORIGIN`
- `CRABFLEET_TRUSTED_PROXY_SECRET`

Optional:

- `CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN`
- `CRABFLEET_TRUSTED_USER_HEADER` (default `X-Authenticated-User`)

The proxy must:

1. prevent untrusted direct access to the backend origin;
2. remove caller-supplied identity and secret headers;
3. authenticate the user;
4. inject the configured identity header;
5. inject `X-Crabfleet-Proxy-Secret`;
6. preserve browser `Origin`.

Crabfleet requires exact backend origin and constant-time shared-secret proof, then applies the normal direct allowlist and role. Unsafe methods and WebSocket upgrades also require the exact browser-visible origin. Missing, partial, malformed, or unexpected assertions fail closed.

Authenticated proxy requests have asserted identity, proxy secret, local cookie, `Authorization`, and `Proxy-Authorization` stripped before app or terminal routing. Service-token routes keep their own scoped auth model.

Runtime profiles can optionally expose a Codex SSH handoff to managers of ready provider workspaces. Treat `codexSsh.setupCommand` as trusted deployment configuration: keep credentials out of its argv-like static tokens, use only the documented complete-token placeholders, never invoke a shell evaluator, and point it at a local helper that treats dynamic arguments as data while installing a concrete SSH alias. Crabfleet displays and copies the shell-quoted command but does not run it.

Proxy-only identity cannot link SSH keys. Use a separate OAuth-capable origin through `GITHUB_REDIRECT_URI` for SSH onboarding.

### Bootstrap Token

`CRABBOX_BOOTSTRAP_TOKEN` is owner break-glass access for initial setup or OAuth recovery.

- Session lifetime: one hour.
- Store in 1Password.
- Do not use for routine onboarding.
- Open `/app?auth=token` when GitHub auto-login is enabled.

### Scoped Service Auth

- SSH gateway: `CRABFLEET_SSH_GATEWAY_TOKEN` or `CRABBOX_SSH_GATEWAY_TOKEN`.
- OpenClaw service: `CRABBOX_OPENCLAW_TOKEN`.
- Session agent: `CRABFLEET_AGENT_TOKEN` plus session ID.
- Stateless provision hook: `CRABBOX_INTERACTIVE_PROVISION_TOKEN`.
- Runtime adapter: `CRABBOX_RUNTIME_ADAPTER_TOKEN`.

These credentials are independent of browser trusted-proxy assertions.

## Secrets

Worker secrets live in Cloudflare bindings, not D1/R2:

- GitHub OAuth/client and optional deployment token.
- Bootstrap token.
- Runtime adapter and standalone Sandbox provision tokens.
- OpenClaw and SSH gateway service tokens.
- OpenAI API key.
- token-encryption key.
- trusted-proxy shared secret.

Managed Sandbox environments receive placeholders. Worker-controlled outbound routing injects OpenAI and GitHub credentials only for approved upstream requests. GitHub REST/GraphQL mutation paths remain repo-scoped and fail closed.

Rotate secrets with `wrangler secret put` or the Cloudflare dashboard. Existing browser/service sessions can fail immediately or at their normal expiry, depending on which secret changed.

## Audit Events

`audit_events` records:

- allowlist and repo mutations;
- policy and workflow evaluation changes;
- SSH key linking;
- interactive-session creation, cleanup, sharing, multiplayer, delegated control, and stop/delete operations;
- OpenClaw/GitHub Actions registration lifecycle.

Card watch/takeover and run state are recorded in card `events`; they are not duplicated into `audit_events`.

There is no audit-log UI or API response today. Owners can query D1:

```bash
pnpm exec wrangler d1 execute DB --remote \
  --command 'SELECT actor, message, created_at FROM audit_events ORDER BY created_at DESC LIMIT 100'
```

Crabfleet has no merge or secret-use events because it currently performs neither merge execution nor runtime secret disclosure.

## API

### Allowlist

```http
POST /api/admin/allow
Content-Type: application/json

{"value":"@jane","role":"maintainer"}
```

```http
DELETE /api/admin/allow/%40jane
```

### Repositories

```http
POST /api/admin/repos
Content-Type: application/json

{"repo":"openclaw/crabbox"}
```

```http
DELETE /api/admin/repos/openclaw%2Fcrabbox
```

### Policy

```http
PUT /api/admin/policy
Content-Type: application/json

{"cap":30,"retention":"30","merge":"guarded"}
```

The endpoint normalizes all three fields on every update; omitted or invalid values receive defaults.

### Workflow Evaluation

```http
POST /api/admin/workflows/evaluate
Content-Type: application/json

{"repo":"openclaw/crabfleet"}
```

## Monitoring

The app shows:

- Running card count versus cap.
- Todo queue count.
- Human Review count.
- Fleet totals by runtime/status.
- attachable, archived, VNC, and policy-registration counts.
- registry availability and default egress host count.

Operational checks:

```bash
curl -fsS https://crabfleet.openclaw.ai/healthz
crabfleet doctor
crabfleet list
```

For deployment state, use GitHub `deploy-worker` and `pages` workflow runs plus the exact production health/docs URLs.

## Troubleshooting

### GitHub Login Rejected

Verify:

1. active `GITHUB_ORG` membership;
2. direct user or matching team allowlist;
3. exact OAuth callback;
4. fresh login after team changes.

### Trusted Proxy Rejected

Verify:

1. request URL origin equals `CRABFLEET_TRUSTED_PROXY_ORIGIN`;
2. browser mutation/WebSocket `Origin` equals the public origin;
3. both identity and secret headers are present;
4. the asserted direct identity is allowlisted;
5. the backend is not reachable around the proxy.

### Repo Missing

Enable the exact normalized `owner/repo`. Private workflow refresh and cross-repo issue lookup may also require `GITHUB_TOKEN`.

### Card Cannot Start

Check the repo allowlist, Running-card cap, and existing active run. Card start only creates/pulses durable attempt state; it does not provision an interactive session.

### Session Stuck `pending_adapter`

Check the selected runtime and deployment backend:

- built-in `SANDBOX` binding for Container;
- `CRABBOX_RUNTIME_ADAPTER_URL` or `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE`, plus token and namespace, for versioned Crabbox;

### Delete Remains `stopping`

Versioned adapters stay `stopping` until create ambiguity resolves and provider release is confirmed. Inspect the session logs/diagnostics and adapter health; cron retries every minute.
