---
title: API Reference
layout: default
permalink: /api/
description: "REST API reference for Crabfleet."
---

# API Reference

Crabfleet exposes same-origin REST APIs and terminal WebSocket APIs from the Worker. Browser clients keep app state in D1-backed REST calls and attach to live Codex terminals through the multiplex terminal hub.

## Auth

Session cookie: `crabbox_session`

- GitHub OAuth: `/login/github`
- Bootstrap token: `POST /api/login/token`
- Logout: `POST /api/logout`

GitHub sessions last 15 minutes. Bootstrap sessions last 1 hour. API JSON responses use `cache-control: no-store`.

Deployments may instead accept a trusted reverse-proxy identity when all trusted-proxy bindings are configured. The request URL must use the exact configured backend origin, the proxy must send the shared secret and configured identity header, and the asserted user must still have a direct login/email allowlist entry. Mutations and WebSocket upgrades must also prove the configured public origin. Crabfleet strips proxy assertions, cookies, and upstream authorization credentials before app and terminal routing.

## Public Endpoints

### GET /healthz

Returns:

```text
ok
```

### GET /api/auth

Returns available login methods without requiring a session.

```json
{
  "auth": {
    "github": true,
    "token": true
  },
  "deployment": {
    "label": "Crabfleet",
    "canonicalUrl": "https://crabfleet.openclaw.ai",
    "productUrl": "https://crabfleet.ai",
    "sshHost": "crabd.sh"
  }
}
```

The unauthenticated response exposes branding and SSH connection fields only. Preferred repository, default runtime, adapter profile, and other routing configuration are returned after authentication through `/api/state`.

### POST /api/login/token

```json
{
  "token": "bootstrap-token"
}
```

Returns the bootstrap owner user and sets `crabbox_session`.

### GET /login/github

Starts GitHub OAuth with `read:user read:org repo`.

When `GITHUB_REDIRECT_URI` is configured, that validated HTTPS callback is authoritative for both authorization and token exchange. Login and SSH-link requests received on another origin redirect to the configured origin before any host-only state cookie is created, preserving the pending SSH code through callback. Without the binding, Crabfleet uses the request-origin callback; insecure non-loopback HTTP origins are rejected.

### GET /auth/github/callback

Completes OAuth, verifies active org membership, applies the allowlist, stores the user, and redirects to `/app`.

With `GITHUB_REDIRECT_URI` configured, callback requests whose origin or path does not exactly match the configured callback are rejected before token exchange.

## Session Endpoints

### POST /api/logout

Deletes the session and clears the cookie.

### GET /api/session

Returns current user and enabled auth methods.

### GET /api/state

Returns app state:

```json
{
  "user": {},
  "auth": {},
  "org": "OpenClaw",
  "cap": 20,
  "retention": "30",
  "merge": "guarded",
  "allow": [],
  "repos": ["openclaw/crabfleet", "openclaw/crabbox"],
  "workflows": [],
  "cards": []
}
```

Owner-only fields:

- `allow`
- `workflows`

Every card may include:

- `changes`: changed file summary; list responses omit diff patches
- `run`: active run attempt, including `selectionReason` and `capabilities`
- `logs`: last 80 events

## GitHub Lookup

### GET /api/github/refs?number=76552

Maintainer+. Searches enabled repos for issue/PR number matches.

```json
{
  "matches": [
    {
      "repo": "openclaw/crabfleet",
      "number": 76552,
      "title": "Fix runtime policy",
      "source": "Issue",
      "state": "open",
      "url": "https://github.com/openclaw/crabfleet/issues/76552",
      "author": "octocat",
      "updatedAt": "2026-05-17T10:00:00Z",
      "body": "..."
    }
  ]
}
```

With `GITHUB_TOKEN`, lookup runs across all enabled repos. Without it, lookup falls back to the preferred repo.

## Cards

### POST /api/cards

Maintainer+. Creates a card.

```json
{
  "prompt": "Implement allowlisted admin workflow",
  "repo": "openclaw/crabfleet",
  "source": "Prompt",
  "runtime": "auto",
  "policy": ""
}
```

Fields:

- `prompt`: required, max 4000 chars.
- `repo`: required, enabled repo.
- `title`: optional, max 140 chars; derived from prompt if blank.
- `source`: optional `Prompt`, `Issue`, or `PR`.
- `runtime`: optional `auto`, `container`, or `crabbox`.
- `policy`: optional. Blank, `default`, or `repo_default` uses a valid repo workflow policy, then `open_pr`.

Invalid explicit merge policies return `400`.

### POST /api/cards/:id/actions

Actions:

- `start`: maintainer, claim run or pulse active run.
- `pulse`: maintainer, same as start for active runs.
- `advance`: maintainer, move to next lane.
- `attach`: viewer, fetch current card/logs.
- `watch`: viewer, record watch event.
- `takeover`: maintainer, requires active run and `capabilities.takeover`.
- `stall`: maintainer, mark active run stalled and move to Human Review.

Response:

```json
{
  "card": {}
}
```

Takeover errors:

- `400 no active run to take over`
- `400 runtime does not support takeover`

### GET /api/cards/:id/runs

Returns all run attempts for a card, newest first.

```json
{
  "runs": [
    {
      "id": "CY-101-R1",
      "cardId": "CY-101",
      "attempt": 1,
      "runtime": "container",
      "status": "running",
      "controlIntent": null,
      "leaseId": null,
      "attachUrl": null,
      "vncUrl": null,
      "selectionReason": "default container runtime",
      "capabilities": {
        "terminal": true,
        "takeover": false,
        "vnc": false,
        "desktop": false,
        "logs": true,
        "artifacts": true
      },
      "operator": null,
      "lastHeartbeatAt": 1779000000000,
      "startedAt": 1779000000000,
      "endedAt": null,
      "createdAt": 1779000000000,
      "updatedAt": 1779000000000,
      "error": null
    }
  ]
}
```

## Interactive Sessions

### GET /api/shared-sessions/:id?token=:token

Public read-only endpoint for a generated session share link. Returns the shared interactive session, D1 event scrollback, and `sharedReadOnly: true`. Invalid, disabled, or rotated tokens return `404`.

```json
{
  "session": {
    "id": "IS-105",
    "sharedReadOnly": true,
    "canControl": false,
    "logs": []
  }
}
```

### POST /api/provision/interactive

Provision hook used by `CRABBOX_INTERACTIVE_PROVISION_URL`. It accepts the same session request payload as the external adapter contract and returns normalized provision status.

Auth:

- If `CRABBOX_INTERACTIVE_PROVISION_TOKEN` is set, callers must send `Authorization: Bearer <token>`.
- The token is required when `CRABBOX_RUNTIME_ADAPTER_URL`, `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE`, `CRABBOX_RUNTIME_PROVISION_URL`, `CRABBOX_CLOUDFLARE_RUNNER_URL`, or `CRABBOX_CLAWFLEET_URL` is configured; backend-enabled deployments fail closed without it.

Backends:

- Versioned lifecycle adapters are deliberately excluded from this stateless hook. Create those workspaces through `POST /api/interactive-sessions`, which durably records ownership before calling the adapter.
- Direct built-in Sandbox calls without a managed interactive-session row acquire a durable standalone ownership fence before credential-policy registration. Standalone IDs cannot use the case-insensitive `IS-<number>` managed-session namespace. Retries with the same ID must match the original immutable request; abandoned claims and failed provisions enter the same generation-fenced cleanup path as managed sessions.
- A request whose ID already belongs to a managed interactive session is rejected unless every immutable request field matches that row and the call wins an exact session-version ownership claim before allocating a Sandbox. Completion commits through the immutable lease, claim, agent-token, and status ownership fence while monotonically advancing the session version, so an intervening metadata edit does not discard the non-replayable result.
- `CRABBOX_RUNTIME_PROVISION_URL`: forwards the session payload to a legacy create-only runtime adapter.
- `CRABBOX_CLOUDFLARE_RUNNER_URL`: creates a Crabbox Cloudflare container sandbox and returns its lease reference.
- `CRABBOX_CLAWFLEET_URL`: creates a ClawFleet OpenClaw instance and returns console/noVNC links.
- ClawFleet handles `crabbox` sessions only; use `CRABBOX_RUNTIME_PROVISION_URL` or `CRABBOX_CLOUDFLARE_RUNNER_URL` for `container` sessions.
- If neither backend is configured, returns `pending_adapter` with a message that the route is live.

For a successful direct built-in Sandbox provision, `attachUrl` is an absolute `wss://` URL under `/api/provision/interactive/:id/pty`, and `expiresAt` is bounded by `CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS` (default four hours, maximum one day). Connect with the same `Authorization: Bearer <CRABBOX_INTERACTIVE_PROVISION_TOKEN>` header used for provisioning. The Worker validates the unexpired standalone owner and exact active credential-policy generation, strips the bearer before opening the Sandbox terminal, proxies the WebSocket while periodically revalidating that ownership, and closes both peers after stop, expiry, or policy revocation. It never routes the connection through `interactive_sessions`. `POST /api/provision/interactive/:id/stop` always requires that configured bearer, even if runtime backend bindings were removed after creation, and atomically moves the exact owner plus every matching policy into durable cleanup; expiry follows the same path from cron and PTY access, and cleanup terminates the Sandbox terminal execution session before deleting its owner row.

#### Versioned runtime adapter

Crabfleet authenticates every adapter request with `Authorization: Bearer CRABBOX_RUNTIME_ADAPTER_TOKEN`. Configure either one fixed `CRABBOX_RUNTIME_ADAPTER_URL` or a profile-routed `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE`, never both. A template contains exactly one `{profile}` full path segment and accepts only lowercase DNS-label profile IDs. This lets a generic profile catalog select separate outbound adapters without teaching Crabfleet about their providers. Adapter URLs must use HTTPS, except literal loopback HTTP for same-host deployments. The original or resolved base URL may include a nested path, whose semantics are preserved, but any raw `?` or `#` delimiter is rejected even when its query or fragment is empty. Authenticated adapter requests reject redirects so the bearer token cannot cross origins. The resolved canonical control-plane base URL is persisted with the lifecycle registration before create. Replay, inspect, desktop connection, and delete recompute the route from the persisted profile and fail closed unless it exactly matches that registered identity, so a configuration change cannot redirect an existing workspace ID or turn a 404 from another origin into release proof.

- `POST /v1/workspaces`: idempotent create. Crabfleet persists the deterministic adapter identity, TTL, idle timeout, requested capabilities, and exact serialized create payload before the request, then sends the same namespaced DNS-safe lowercase `id` and `Idempotency-Key`, plus repo, branch, runtime, opaque profile, command, prompt, ownership/lineage, and lifecycle settings. A definitive non-2xx response to the initial request is read once, sanitized, and durably recorded as the failure reason before provider release begins. After an ambiguous result, a bounded reconciliation pass retries only that immutable payload and key before any inspect; later edits to session metadata do not alter it. Replay-time authentication, routing, validation, or other non-success responses cannot prove the original request failed and therefore keep create ambiguity pending.
- An adapter that finds the requested ID already bound to a different immutable request returns `409` with `error.code = "workspace_id_conflict"`. Crabfleet marks only its local session failed and atomically drops that adapter identity when the exact pending create attempt still owns the lifecycle revision and reconciliation claim; a stale conflict response is ignored. It never adopts, inspects, or deletes the pre-existing workspace. Other `409` responses remain ambiguous and retryable.
- `GET /v1/workspaces/:id`: inspect current status, capabilities, terminal URL, expiry, and provider resource identity. Status-only responses preserve previously stored capabilities and expiry; explicit `null` clears those fields. Active external sessions are reconciled in bounded batches; state responses wait only for a short foreground budget while remaining work continues in the Worker background.
- `DELETE /v1/workspaces/:id`: stop/release. Crabfleet enters `stopping` before calling the adapter and marks the session stopped only after `204`, `404`, or a valid exact-ID terminal response confirms release; malformed successful bodies remain `stopping`. Plain-text and malformed-JSON responses are read once and sanitized before their evidence is retained. An explicit stop whose ownership claim loses returns success only when the exact workspace is already stopping or terminal; otherwise it returns a lifecycle conflict.
- `POST /v1/workspaces/:id/connections/desktop`: mint a current transient desktop URL. The request has no body. `expiresAt` is optional; when present it must be in the future and no more than 15 minutes away. Accepted HTTPS URLs are treated as opaque signed connection material and redirected byte-for-byte without URL normalization. After minting, Crabfleet re-reads the exact current session status, control grant, capabilities, and registered adapter identity before redirecting; a concurrent stop, revocation, capability withdrawal, or lifecycle replacement discards the URL and denies access.

`CRABBOX_RUNTIME_ADAPTER_NAMESPACE` is required and must remain stable for the deployment. It prevents workspace and idempotency collisions when an adapter serves more than one Crabfleet tenant. The adapter workspace `id` is an immutable lifecycle route key and remains separate from an opaque `providerResourceId`; the provider identity is never interpreted as a legacy lease or sandbox ID. Create, inspect, and stop responses must echo the byte-exact requested DNS-safe `id`; whitespace normalization is not accepted. Responses use `status`, `id`, optional `providerResourceId`, `attachUrl`, `capabilities`, `expiresAt`, and `message`. Only a literal `null` clears a previously stored expiry; a malformed non-null timestamp invalidates the response. A terminal URL implies terminal capability only when the response omits a terminal capability; an explicit `terminal: false` wins. Supported status values include `provisioning`, `ready`, `stopping`, `stopped`, `expired`, and `failed`. Create-only legacy adapters cannot return `stopping`, because they do not own a later reconciliation lifecycle. Every session-bound provider DELETE is gated on the persisted create ambiguity marker being clear.

Every create, inspect, delete, and desktop response body is consumed through one 64 KiB bounded stream reader before JSON or text parsing. Declared or chunked oversized bodies are cancelled and fail safely: ambiguous create remains reconcilable, delete remains pending, inspect retries later, and desktop access is denied.

Adapter messages are untrusted display text. Crabfleet removes raw and slash-escaped HTTP/WebSocket connection URLs directly from arbitrary message/detail text; Bearer and Basic credentials; authorization, cookie, and API-key headers; and sensitive assignments such as quoted JSON, colon fields, `token`, `ticket`, `access_token`, passwords, signatures, and secrets before replacing opaque provider identifiers and storing text in `lastEvent`, events, terminal failure evidence, or archives. For non-successful or malformed responses, opaque `providerResourceId`, `provider_resource_id`, `leaseId`, and `lease_id` values are collected from body, workspace, and error envelopes before redaction. Sanitizing credential structure first prevents an identifier such as `token` from hiding `token=secret`.

An adapter-reported `failed` workspace is not locally terminal until Crabfleet calls DELETE and confirms release. Crabfleet durably clears create ambiguity and records the requested failed terminal state and original failure reason before awaiting DELETE, so reconciliation cannot replay the create or replace useful failure evidence with a generic release message. Asynchronous or uncertain release remains `stopping`; reconciliation records `failed` only after the workspace is gone. A stop racing an ambiguous create also remains `stopping`: every reconciliation pass uses a dedicated replay path fenced to the exact `stopping` row, pending marker, registered control plane, immutable payload, settings, and session version, then issues DELETE before recording the requested terminal state. Generic provisioning cannot restage that row. After confirmed release, Crabfleet re-reads and compare-and-swaps the current ambiguity marker and terminal intent: a cleared marker terminalizes immediately, while a still-pending create remains `stopping`. Only a valid exact-ID successful replay, including `provisioning`, proves ownership and clears ambiguity. An explicit `workspace_id_conflict` proves non-ownership and atomically detaches the local lifecycle without DELETE; every other replay response leaves the marker pending.

### GET /api/terminal/ws

Session owner, maintainer/owner role, viewer with a current delegated control grant, SSH gateway linked-key identity, scoped session agent, or a public shared-link token for read-only sessions. Multiplex WebSocket endpoint used by the Ghostty WASM session grid, Go CLI, and SSH gateway. One socket can subscribe to multiple interactive sessions, receive PTY output frames, resize terminals, and send input only when the current user has control.

The wire format is a compact binary frame:

```text
u16 magic 0x5943
u8 version 1
u8 message_type
u32 session_id_length
utf8 session_id
u32 payload_length
payload bytes
```

Supported client actions:

- `Subscribe`: attach to a session with output/snapshot/event flags and optional initial cols/rows.
- `Unsubscribe`: detach one session without closing the hub.
- `Input` / `Key`: send terminal bytes when control is granted.
- `Resize`: forward terminal dimensions to the upstream PTY.
- `Stop`: close the upstream subscription.
- `Ping`: keepalive, answered with `Pong`.
- `Ack`: acknowledge consumed output bytes for negotiated flow control.

Server messages include `Welcome`, `Output`, `Event`, `Error`, `ControlRevoked`, and `Pong`. Shared-link viewers can subscribe and scroll output, but input frames are rejected unless an owner/maintainer grants writable control. Subscriptions require the current `terminal` capability; withdrawing it prevents new attaches, closes existing terminal sockets on the next authorization check, suppresses attachable state from app, API, fleet, CLI, and SSH responses, and removes Fleet terminal/SSH affordances. Recurring and per-input authorization use short-lived D1 snapshots only; throttled subscription reconciliation runs independently and never blocks an input frame on provider I/O.

Target resolution:

- `CRABBOX_PTY_BRIDGE_URL`: explicit bridge WebSocket URL/template. Templates support `{id}`, `{leaseId}`, `{repo}`, `{branch}`, and `{runtime}`. Crabfleet appends `sessionId`, `leaseId`, `repo`, `branch`, `runtime`, and `command` query parameters.
- Provider terminal connection: if the provision adapter returned a `wss://` URL, or literal loopback `ws://` URL, Crabfleet retains it server-side and proxies to it unchanged, including its path and signed query string.
- `CRABBOX_CLOUDFLARE_RUNNER_URL`: for `cloudflare:<sandbox>` leases, Crabfleet proxies to `/v1/sandboxes/:sandbox/pty` on the runner.

The hub appends terminal `cols` and `rows` only to configured bridge and Cloudflare runner endpoints, never to an adapter `attachUrl`. Crabfleet authenticates versioned-adapter terminal upgrades with `CRABBOX_RUNTIME_ADAPTER_TOKEN` only when the terminal shares the persisted and currently configured adapter origin; adapter URLs never carry reusable shell credentials. If `CRABBOX_PTY_BRIDGE_TOKEN` or `CRABBOX_CLOUDFLARE_RUNNER_TOKEN` is set, Crabfleet sends it as a bearer token only to the upstream bridge/runner. Clients never receive upstream credentials.

### POST /api/interactive-sessions/:id/clipboard

Viewer+ with writable terminal control. Uploads a browser clipboard image/file body into the controlled Cloudflare Sandbox workspace and returns `{ path, name, mediaType, byteCount }`. The browser then pastes the returned path into the PTY. Max body size: 10 MiB. Non-Sandbox PTY backends do not expose file paste.

### GET /api/interactive-sessions/:id/vnc

Viewer+ with writable session control. For `runtime-v1`, Crabfleet authenticates the browser session, asks the adapter to mint a current desktop connection, validates its HTTPS URL and optional bounded expiry, and issues a no-store redirect. Versioned-adapter desktop URLs are never persisted in D1 or returned by fleet state. API and CLI session views expose an absolute canonical Crabfleet browser URL for this cookie-authenticated route; the SSH gateway does not mint or receive the underlying adapter URL. Legacy adapters retain their existing validated absolute VNC URL behavior for browser and CLI clients.

### POST /api/openclaw/action-sessions

Internal OpenClaw service endpoint authenticated with `Authorization: Bearer CRABBOX_OPENCLAW_TOKEN`. Registers or resumes one durable `github_actions` session per `workKey`. Re-registration returns the same logical session and rotates its scoped agent token.

See [GitHub Actions Sessions](/github-actions-sessions/) for the complete
integration lifecycle and operational invariants.

Request:

```json
{
  "workKey": "openclaw/crabfleet:pr:42",
  "workKind": "pr_repair",
  "repo": "openclaw/crabfleet",
  "branch": "fix/pr-42",
  "sourceUrl": "https://github.com/openclaw/crabfleet/pull/42",
  "runUrl": "https://github.com/openclaw/crabfleet/actions/runs/123",
  "purpose": "repair PR 42",
  "summary": "starting repair"
}
```

Response:

```json
{
  "session": {},
  "agentToken": "rotated-session-token",
  "runnerPtyUrl": "wss://crabfleet.openclaw.ai/api/agent/interactive-sessions/IS-123/runner-pty?agentToken=...",
  "browserUrl": "https://crabfleet.openclaw.ai/app/sessions/IS-123"
}
```

`runnerPtyUrl` is directly usable with Node's global `WebSocket`; no custom headers are required. The query credential is session-scoped, rotates on registration, is stored only as a hash, and is not exposed through viewer/session APIs.

### GET /api/agent/interactive-sessions/:id/runner-pty

WebSocket endpoint for the outbound GitHub Actions runner. Authentication uses the scoped `agentToken` query parameter embedded in `runnerPtyUrl`. The runner sends raw terminal output bytes and receives raw viewer input bytes. One runner is current; a reconnect replaces the previous runner while browser viewers remain attached.

### POST /api/agent/interactive-sessions/:id/work-state

Agent-authenticated heartbeat and state update. Use `Authorization: Bearer <agentToken>`.

```json
{
  "state": "running",
  "phase": "fixing_tests",
  "summary": "two tests fixed; checking CI",
  "codexThreadId": "thread-id",
  "codexTurnId": "turn-id",
  "completionReason": null
}
```

Every call updates `lastHeartbeatAt`. Active states are `registered` and `running`; `phase` keeps active steps distinguishable. Terminal states are `completed`, `blocked`, `failed`, and `canceled`.

### POST /api/interactive-sessions

Maintainer+. Creates a standalone Codex CLI workspace request.

```json
{
  "repo": "openclaw/crabfleet",
  "branch": "main",
  "runtime": "container",
  "profile": "default",
  "command": "codex",
  "prompt": "Investigate flaky release CI",
  "parentSessionId": "IS-100",
  "rootSessionId": "IS-100",
  "purpose": "debug release CI",
  "summary": "checking the release workflow"
}
```

Fields:

- `repo`: required, enabled repo.
- `branch`: optional, default `main`.
- `runtime`: optional `crabbox` or `container`; omission uses `CRABFLEET_DEFAULT_RUNTIME`, which defaults to `container`.
- `profile`: optional opaque adapter profile, defaulted by `CRABFLEET_DEFAULT_PROFILE`. When `CRABFLEET_RUNTIME_PROFILES_JSON` is configured, the value must name a configured profile; its capability flags seed the requested adapter capabilities for Crabbox sessions.
- `github_actions` is service-created through `/api/openclaw/action-sessions` and is not accepted by this endpoint.
- `command`: optional, default `codex`.
- `prompt`: optional initial context note.
- `parentSessionId`: optional parent session for supervision trees.
- `rootSessionId`: optional root session; inferred from the parent when present.
- `purpose`: optional short mission label.
- `summary`: optional list/closeout summary.

If `CRABBOX_RUNTIME_ADAPTER_URL` or `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` is configured, the Worker creates and reconciles the versioned adapter workspace and records its resolved lifecycle identity, status, capabilities, expiry, and terminal connection. Otherwise `CRABBOX_INTERACTIVE_PROVISION_URL` retains the legacy create-only behavior. Without an adapter the session is stored as `pending_adapter`.

Session responses include `ptyAvailable`, the authenticated Worker's authoritative answer for whether the current terminal capability, lifecycle state, and configured Sandbox/bridge/runner route can resolve a PTY connection. Every controllable session exposes only the Worker-owned `/api/terminal/ws` route in `attachUrl`; signed provider connections remain server-side even for owners and controllers.

When the selected runtime profile configures `codexSsh`, a ready `runtime-v1` session response may include `codexSsh: { alias, setupCommand }` for session managers. The alias and optional command are resolved from bounded `{providerResourceId}`, `{workspaceId}`, `{sessionId}`, and `{profile}` placeholders. Alias components use a strict OpenSSH-safe character set. `codexSsh.setupCommand` is an argv-like array whose first and static items use a shell-safe character set and whose dynamic items must each be one complete placeholder; Crabfleet POSIX-shell-quotes every substituted argument so opaque provider identifiers remain data. Missing values, an unsafe resolved alias, or a current profile route that differs from the workspace's immutable registered adapter control plane suppresses the handoff. Shared links and delegated terminal-only controllers never receive it. The command is display/copy data only; Crabfleet never executes it.

Built-in Sandbox sessions receive `CRABFLEET_SESSION_ID`, `CRABFLEET_PARENT_SESSION_ID`, `CRABFLEET_ROOT_SESSION_ID`, `CRABFLEET_AGENT_TOKEN`, and `CRABFLEET_API_URL`. The managed provision hook rotates a fresh agent token in the same durable claim that owns provisioning, then injects that exact token into the Sandbox. The agent token can call the `/api/agent/*` endpoints below for same-owner session discovery, child creation, transcripts, and summary updates.

### POST /api/interactive-sessions/cleanup

Viewer+. Deletes manageable stopped, expired, or failed sessions only after terminal finalization, credential-policy cleanup, and complete archive finalization. Pass an optional `ids` array to limit cleanup; an empty list considers all eligible dead sessions visible to the caller.

```json
{
  "ids": ["IS-105", "IS-109"]
}
```

Returns refreshed app state plus `removedIds`.

### GET /api/interactive-sessions/:id

Viewer+. Returns one current decorated session after a bounded lifecycle refresh.

### GET /api/interactive-sessions/:id/logs

Viewer+. Returns up to 5,000 recent D1 events, the total event count, truncation state, and current R2 archive snapshot metadata when available. It does not read or return the archived R2 objects.

### GET /api/interactive-sessions/:id/transcript

Session owner or maintainer/owner role. Returns the Markdown transcript from R2 when archived, or a D1 event-log transcript fallback.

### POST /api/interactive-sessions/:id/summary

Viewer+ with owner/maintainer access. Updates `purpose` and/or `summary`.

```json
{
  "purpose": "review sibling fix",
  "summary": "waiting on CI"
}
```

### GET /api/interactive-sessions/:id/diagnostics

Viewer+ with writable control. Runs a bounded environment, checkout, GitHub, Codex, and tool inventory inside a Cloudflare Sandbox session. Other backends return an unavailable result instead of executing diagnostics.

### GET /api/interactive-sessions/:id/checkpoints

Session owner or maintainer. Lists registered Cloudflare Sandbox checkpoints without exposing provider backup material.

### POST /api/interactive-sessions/:id/checkpoints

Session owner or maintainer. Creates a backup of the current Sandbox worktree and returns `201`. Checkpoint storage requires the configured backup R2 binding and, for presigned backups, the matching Cloudflare account and R2 credentials.

### POST /api/interactive-sessions/:id/checkpoints/:checkpoint/restore

Session owner or maintainer. Restores a registered checkpoint into the active Cloudflare Sandbox session.

### POST /api/interactive-sessions/:id/actions

Actions:

- `attach`: viewer with control, mark seen/attached and return the session.
- `share_link`: owner/maintainer, enable or rotate a public read-only share URL; response includes `shareUrl` once.
- `disable_share`: owner/maintainer, disable the share URL and clear pending/granted control.
- `request_control`: viewer, request writable terminal control.
- `approve_control`: owner/maintainer, grant pending requester 30 minutes of writable terminal control.
- `deny_control`: owner/maintainer, clear a pending control request.
- `revoke_control`: owner/maintainer, revoke active delegated control.
- `enable_multiplayer`: session creator, prefix submitted terminal prompts with the actor.
- `disable_multiplayer`: session creator, stop prefixing submitted terminal prompts with the actor.
- `stop`: owner/maintainer, internal wire action behind user-facing Delete, Stop, or End. Versioned adapters release the provider workspace before marking stopped, and asynchronous releases remain `stopping` until reconciliation confirms completion. Legacy create-only and ClawFleet sessions stop only in Crabfleet because those integrations expose no release lifecycle. For GitHub Actions, End disconnects and finalizes only the Crabfleet terminal session; it does not call GitHub's workflow-cancellation API, so the workflow run may continue.

Response:

```json
{
  "session": {},
  "shareUrl": "https://crabfleet.openclaw.ai/app/sessions/IS-105?token=..."
}
```

## SSH Gateway

The Go gateway terminates raw SSH and calls Worker APIs with `Authorization: Bearer
CRABBOX_SSH_GATEWAY_TOKEN`. These endpoints are not browser APIs.

- `POST /api/ssh/auth`: checks a public-key fingerprint. Unknown keys receive a short `/ssh/link/:code` GitHub OAuth URL only when the gateway is in explicit link mode, e.g. `ssh link@host`.
- `GET /api/ssh/state`: returns the same board/session state for the linked SSH user.
- `POST /api/ssh/interactive-sessions`: creates an interactive Codex session for the linked SSH user.
- `GET /api/ssh/interactive-sessions/:id`: reads one visible session.
- `POST /api/ssh/interactive-sessions/:id/actions`: performs the same authorized session actions as the browser API.
- `GET /api/ssh/interactive-sessions/:id/logs`: returns the D1 event stream plus R2 archive metadata for a visible crabbox session.
- `GET /api/ssh/interactive-sessions/:id/transcript`: returns the Markdown transcript.
- `POST /api/ssh/interactive-sessions/:id/summary`: updates `purpose` and/or `summary`.
- `GET /api/ssh/interactive-sessions/:id/checkpoints`: lists Cloudflare Sandbox checkpoints.
- `POST /api/ssh/interactive-sessions/:id/checkpoints`: creates a Cloudflare Sandbox checkpoint.
- `POST /api/ssh/interactive-sessions/:id/checkpoints/:checkpoint/restore`: restores a checkpoint.

PTY attach and message commands use `/api/terminal/ws` with the gateway bearer and linked-key fingerprint headers.

## Agent Session API

Crabfleet-issued session agents use `Authorization: Bearer <CRABFLEET_AGENT_TOKEN>` plus `X-Crabfleet-Session-ID: <CRABFLEET_SESSION_ID>`. These endpoints mirror the SSH lifecycle subset without requiring an SSH key inside the sandbox.

- `GET /api/agent/state`: returns app/fleet state plus `{ agent: { sessionId, rootSessionId } }`.
- `POST /api/agent/interactive-sessions`: creates a child session owned by the same user and linked under the current agent session.
- `GET /api/agent/interactive-sessions/:id`: reads a visible same-owner session.
- `GET /api/agent/interactive-sessions/:id/logs`: returns event logs.
- `GET /api/agent/interactive-sessions/:id/transcript`: returns the Markdown transcript.
- `POST /api/agent/interactive-sessions/:id/summary`: updates `purpose` and/or `summary`.

Same-owner terminal steering uses `/api/terminal/ws` with the agent bearer and session ID header; the CLI uses this protocol for `crabfleet message`.

## OpenClaw Service

Internal automation uses `Authorization: Bearer CRABBOX_OPENCLAW_TOKEN`.

### POST /api/openclaw/crabboxes

Creates a repo-ready crabbox for an operator, e.g. from a Discord meeting handoff or a MultiCodex room.

```json
{
  "owner": "@steipete",
  "repo": "openclaw/crabfleet",
  "branch": "main",
  "runtime": "crabbox",
  "command": "codex --yolo",
  "prompt": "prep the meeting follow-up",
  "requestId": "multicodex-room-123-host"
}
```

`requestId` is optional, limited to 200 characters, and strongly recommended for
automation. Crabfleet persists it in a durable replay ledger with the session
reservation before branch preparation or runtime creation. Replaying the same
request returns the original crabbox; reusing the ID with a different request is
rejected. A replay while the original reservation is still preparing returns a
retryable service-unavailable response instead of claiming the crabbox is ready.
After finalized-session cleanup, the retained replay tombstone rejects the
request instead of provisioning duplicate work. The fingerprint includes a
nonreversible digest of any supplied GitHub credential; the credential itself is
not stored in the replay ledger.

Response:

```json
{
  "session": {
    "id": "IS-105",
    "owner": "@steipete",
    "runtime": "crabbox",
    "vncUrl": "https://..."
  },
  "browserUrl": "https://crabfleet.openclaw.ai/app/sessions/IS-105"
}
```

### OpenClaw crabbox supervision

Internal OpenClaw automation can supervise a created room/session tree without
using browser cookies or an individual session's agent token:

- `GET /api/openclaw/session-roots/:rootSessionId`: list the exact root and up to
  63 service-created or agent-created descendants, with logs omitted from each
  session summary.
- `GET /api/openclaw/crabboxes/:id`: read one current crabbox.
- `GET /api/openclaw/crabboxes/:id/transcript`: read a bounded recent transcript.
- `POST /api/openclaw/crabboxes/:id/message`: send one terminal message/nudge.
- `POST /api/openclaw/crabboxes/:id/actions`: request the supported `stop` action.
- `POST /api/openclaw/crabboxes/:id/embed-ticket`: mint a short-lived browser URL
  that can view and control only that crabbox terminal without a Crabfleet login.
- `POST /api/openclaw/session-roots/:rootSessionId/actions`: freeze room-tree
  admission and recursively stop every pending or active descendant.

Room supervision endpoints require a configured service capability: the
existing `CRABBOX_OPENCLAW_TOKEN`, or the dedicated `CRABBOX_MULTICODEX_TOKEN`
for a MultiCodex deployment. Action-session registration accepts only
`CRABBOX_OPENCLAW_TOKEN`; the narrower MultiCodex credential cannot register or
resume GitHub Actions sessions.
Crabbox creation can explicitly include `baseBranch`; after request validation,
when the requested branch is missing, Crabfleet creates it from that base with
its deployment GitHub credential before provisioning the session. If that
control-plane credential is denied with `403` or GitHub's masked `404`,
Crabfleet defers branch validation to the separately credentialed runtime
adapter so an existing branch can still launch. A missing control-plane
credential is also deferrable. Without an explicit `baseBranch`, Crabfleet does
not mutate GitHub. A missing or inaccessible branch then fails during runtime
checkout.
Per-crabbox reads require `X-Crabfleet-Root-Session-ID`; message and action
bodies require `rootSessionId`. A session outside that exact root is returned
as not found. Creation rejects a supervised descendant that would exceed the
64-session room-tree limit before runtime provisioning begins. Transcript
responses contain at most the newest 240 events and
64 KiB of UTF-8 text and report whether evidence was truncated. Every message
and stop request writes an audit event.

Embed-ticket bodies require `rootSessionId` and may include `ttlSeconds`.
Lifetimes default to one hour and are clamped between one minute and four
hours. The returned signed bearer is scoped to one terminal session and never
exposes the room service credential. It cannot read fleet state, manage the
session, paste files, or access sibling sessions.

Message request:

```json
{
  "rootSessionId": "IS-100",
  "message": "Align the response contract with the frontend lane.",
  "enter": true
}
```

Stop request:

```json
{
  "rootSessionId": "IS-100",
  "action": "stop"
}
```

Root stop request:

```json
{
  "action": "stop"
}
```

Root stop closes descendant admission before rolling back pending reservations
and driving the remaining root tree terminal in bounded batches, including a
legacy tree above the normal supervision limit. It returns only after the whole
tree is quiescent; a failed request leaves admission closed and can be retried
safely.

## Admin

Owner role required.

### POST /api/admin/allow

```json
{
  "value": "@openclaw/maintainer",
  "role": "maintainer"
}
```

Values can be `@login`, `@org/team`, or email. Returns full state.

### DELETE /api/admin/allow/:value

Removes an allowlist entry. `:value` is URL encoded.

### POST /api/admin/repos

```json
{
  "repo": "openclaw/crabfleet"
}
```

Enables a repo. Returns full state.

### DELETE /api/admin/repos/:repo

Disables a repo by setting `enabled = 0`.

### PUT /api/admin/policy

```json
{
  "cap": 20,
  "retention": "30",
  "merge": "guarded"
}
```

Fields:

- `cap`: 1-200.
- `retention`: `14`, `30`, or `60`.
- `merge`: `guarded`, `disabled`, or `maintainers`.

### POST /api/admin/workflows/evaluate

Fetches and evaluates `CRABBOX.md` for an enabled repo. Private repos require deployment `GITHUB_TOKEN` access; the logged-in user's OAuth token is not used for this fetch.

```json
{
  "repo": "openclaw/crabfleet"
}
```

Returns full state. Owner state includes workflow summaries with:

- `repo`
- `status`: `ok`, `missing`, `invalid`, or `error`
- `sourcePath`
- `sourceSha`
- `config`
- `error`
- `evaluatedAt`
- `updatedAt`

The stored prompt body is not returned in state summaries.

### GET /api/fleet

Returns the redacted fleet registry for the signed-in viewer.

Includes:

- `canonicalUrl`
- `productUrl`
- `registryAvailable`
- `egress`
- `totals`
- `sessions`

Secrets, ciphertext, and token values are never returned.

## Static Routes

- `/` and `/app`: app shell.
- `/docs`, `/docs/`, `/docs/spec`, `/docs/spec/`: generated docs page, or Markdown when `Accept` includes `text/markdown`.
- `/docs/spec.md`: Markdown spec.
- `/docs/spec-v2`, `/docs/spec-v2/`: generated v2 spec page, or Markdown when `Accept` includes `text/markdown`.
- `/docs/spec-v2.md`: Markdown v2 spec.
- `/crabbox-logo.png`: logo.
- `/vendor/ghostty-web.js`: local Ghostty WASM bundle.

## Error Shape

```json
{
  "error": "message"
}
```

Common statuses:

- `400`: invalid input or unsupported action.
- `401`: missing/expired session.
- `403`: insufficient role, repo blocked, or no longer allowlisted.
- `404`: missing card or route.
- `409`: lifecycle or immutable workspace identity conflict.
- `413`: request or upstream response exceeded its bounded size.
- `429`: rate limit.
- `502`: runtime adapter returned an invalid or failed response.
- `503`: GitHub dependency unavailable or rate limited.
