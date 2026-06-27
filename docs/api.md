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

Deployments may instead accept a trusted reverse-proxy identity when all trusted-proxy bindings are configured. The request URL must use the exact configured backend origin, and the proxy must send the shared secret and configured identity header. The asserted user needs a direct login/email allowlist entry unless `CRABFLEET_TRUSTED_PROXY_AUTO_ROLE` grants valid proxy identities the `viewer` or `maintainer` role; allowlist matches take precedence and all other automatic-role values fail closed. Mutations and WebSocket upgrades must also prove the configured public origin. Crabfleet strips proxy assertions, cookies, and upstream authorization credentials before app and terminal routing.

`CRABFLEET_TENANCY_MODE` defaults to `private`. Private API reads return only cards and sessions owned by the authenticated stable subject, plus sessions covered by an unexpired named grant or delegated-control lease. Global roles do not bypass this boundary. Set the mode to exact `shared` only for the legacy team-wide visibility contract.

## Native Device Link

The versioned native API gives the macOS client read-only access to the Fleet
registry without copying a browser cookie. Device links expire after 10 minutes.
The resulting bearer lasts 24 hours, has the exact `fleet:read` scope, and is
accepted only by the native session, Fleet, and revocation endpoints. All
responses use `cache-control: no-store`; timestamps are Unix epoch milliseconds.
The one-time bearer handoff is encrypted with `CRABBOX_TOKEN_ENCRYPTION_KEY`,
falling back to `GITHUB_CLIENT_SECRET` when GitHub OAuth is configured. A
trusted-proxy-only deployment must set the explicit encryption key before
native device approval can succeed. GitHub-approved grants also retain the
approving session's OAuth credential as encrypted ciphertext on the native
token row so membership and team access can be refreshed throughout the
grant. That credential is never returned to the native app and is erased when
the token is revoked. The scheduled Worker cleanup deletes expired device-link
and access-token rows even when no later authorization request arrives;
approved grants that are never polled are deleted with the 10-minute device
link instead of retaining their encrypted GitHub credential for 24 hours.

### POST /api/native/v1/auth/device

Starts an unauthenticated device link. `clientName` is required and limited to
120 characters.

```json
{
  "clientName": "Crabfleet for macOS"
}
```

Returns `201`:

```json
{
  "deviceCode": "<one-time-device-secret>",
  "verificationUri": "https://fleet.example/native/link/<one-time-link-secret>",
  "expiresAt": 1782288600000,
  "intervalSeconds": 5
}
```

The app opens `verificationUri` in the user's browser. A `GET /native/link/:code`
never approves the device: it requires a normal browser-authenticated `viewer`
and renders a confirmation form. A `POST /native/link/:code` requires that
browser session and the exact configured public origin. Cookie-authenticated
deployments also require the link-bound CSRF cookie; trusted-proxy deployments
use their asserted browser identity plus exact-Origin enforcement because the
Worker strips upstream cookies. Development identities cannot approve native
clients. When `GITHUB_REDIRECT_URI` names another authoritative origin, the
link redirects there before lookup or cookie creation. An expired or
already-used link returns `410`.

When the trusted-proxy public origin is also the OAuth callback origin, an
already authenticated proxy request is served on the configured backend origin
rather than redirected back through its browser-visible origin. This avoids a
proxy-to-Worker canonicalization loop while the form's unsafe request still
requires the exact public `Origin`. A genuinely separate OAuth callback origin
still receives one canonical redirect before lookup or cookie creation.

### POST /api/native/v1/auth/token

Polls the device link without browser credentials:

```json
{
  "deviceCode": "<one-time-device-secret>"
}
```

While approval is pending, the endpoint returns `202`, includes
`Retry-After: 5`, and returns:

```json
{
  "status": "pending"
}
```

Polling before the advertised interval returns `429`, includes the same
`Retry-After`, and returns `{ "error": "slow_down" }`. After approval, one
poll consumes the device code and returns `200`:

```json
{
  "accessToken": "<native-bearer-secret>",
  "tokenType": "Bearer",
  "expiresAt": 1782374400000,
  "user": {
    "subject": "github:1234",
    "login": "octocat",
    "email": null,
    "name": "Octo Cat",
    "role": "viewer",
    "allowed": true,
    "teams": []
  }
}
```

Invalid, expired, consumed, or no-longer-authorized device codes return `401`.
Transient GitHub membership-refresh failures return retryable `503` without
consuming the approved device code; clients may continue polling until the
original link expiry.

### GET /api/native/v1/session

Requires `Authorization: Bearer <native-bearer-secret>`. Returns the currently
authorized user and public deployment metadata:

```json
{
  "user": {
    "subject": "github:1234",
    "login": "octocat",
    "email": null,
    "name": "Octo Cat",
    "role": "viewer",
    "allowed": true,
    "teams": []
  },
  "deployment": {
    "label": "Crabfleet",
    "canonicalUrl": "https://fleet.example",
    "productUrl": "https://product.example",
    "sshHost": "ssh.example"
  }
}
```

### GET /api/native/v1/fleet

Requires the native bearer and returns the same tenant-filtered, redacted
`{ "fleet": ... }` envelope as `GET /api/fleet`. It does not return an attach
credential, native RFB endpoint, or mutation authority.

### POST /api/native/v1/sessions/:id/native-vnc

Requires the native bearer, a current controllable Crabbox runtime-adapter
session, and `capabilities.nativeVnc=true`. Crabfleet asks the session's
registered adapter for a one-minute, single-use grant and returns it with
`Cache-Control: no-store`. Fleet exposes the Crabfleet session ID for this
request instead of the provider lease ID. The macOS app sends the grant ticket
to the installed Crabbox CLI on stdin; the ticket is never placed in argv or a
URL.

### DELETE /api/native/v1/auth/token

Requires the native bearer, revokes that token without depending on an external
identity-provider refresh, and returns:

```json
{
  "ok": true
}
```

Expired, revoked, malformed, or ambiguous proxy-plus-bearer credentials return a
uniform `401` from every bearer-authenticated native endpoint. Each use also
rechecks the stored user against current deployment authorization. GitHub
grants additionally refresh active organization membership and current teams
before the device-code handoff and every bearer use. Inactive membership,
identity mismatch, invalid GitHub credentials, or allowlist denial revokes the
native token and clears its encrypted GitHub credential. A transient GitHub
failure or incomplete email lookup returns retryable `503` without destroying
the grant or granting access from stale identity data.

Trusted identity gateways must bypass browser SSO only for this exact native API
method/path set:

- `POST /api/native/v1/auth/device`
- `POST /api/native/v1/auth/token`
- `DELETE /api/native/v1/auth/token`
- `GET /api/native/v1/session`
- `GET /api/native/v1/fleet`
- `POST /api/native/v1/sessions/IS-<number>/native-vnc`

They must pass those requests directly to Crabfleet and must not add a competing
asserted identity to bearer requests. Every `/native/link/*` browser route
remains behind browser SSO and Crabfleet's normal browser authentication; do
not add a wildcard `/api/native/*` bypass.

If a gateway cannot bypass browser SSO for exact routes but supports OAuth 2.0
dynamic client registration and authorization-code PKCE, it may instead return
a Bearer challenge whose same-origin `resource_metadata` describes the protected
resource and authorization server and whose `scope` names the required read-only
scope, plus these two exact authenticated reads:

- `GET /mcp/crabfleet/native/v1/session`
- `GET /mcp/crabfleet/native/v1/fleet`
- `POST /mcp/crabfleet/native/v1/sessions/IS-<number>/native-vnc`

Both challenges must resolve to the same authorization server. RFC 9728
metadata identifies each exact challenged route, and the client requests both
resource identifiers. A compatibility profile may return authorization-server
metadata directly only when it omits a `resource` field and its explicit
`api://` scope can be matched to the issued JWT's `aud` claim before the bearer
is sent to either route. Scope lists must
remain within the client's advertised aggregate limit. Before contacting an
OAuth issuer or endpoint outside the deployment origin, the client requires
explicit user trust for that provider origin.

The gateway must consume and strip its OAuth bearer, assert the authenticated
browser identity through the deployment's trusted-proxy boundary, and map the
two reads to `/api/session` and `/api/fleet`. It must reject queries, mutations,
unknown suffixes, and WebSocket upgrades under that prefix. This alternative
does not expose Crabfleet's device-code or token endpoints through the gateway.

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

When `GITHUB_REDIRECT_URI` is configured, that validated HTTPS callback is authoritative for both authorization and token exchange. Login, SSH-link, and native-link requests received on another origin redirect to the configured origin before any host-only state cookie is created, preserving the pending link code through callback. Without the binding, Crabfleet uses the request-origin callback; insecure non-loopback HTTP origins are rejected.

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
- `schedule`, `nextRunAt`, and `lastScheduledRunAt`: recurring cadence and persisted scheduler evidence

In private tenancy mode, `cards`, `interactiveSessions`, and derived Fleet state contain only the current tenant's visible records.

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
  "policy": "",
  "schedule": { "kind": "interval", "everyMs": 86400000 }
}
```

Fields:

- `prompt`: required, max 4000 chars.
- `repo`: required, enabled repo.
- `title`: optional, max 140 chars; derived from prompt if blank.
- `source`: optional `Prompt`, `Issue`, or `PR`.
- `runtime`: optional `auto`, `container`, or `crabbox`.
- `policy`: optional. Blank, `default`, or `repo_default` uses a valid repo workflow policy, then `open_pr`.
- `schedule`: optional interval schedule. `everyMs` must be an integer from 60000 through 2678400000. Optional `startAt` is a non-negative Unix epoch millisecond timestamp. The first occurrence is the first cadence-aligned timestamp after creation unless `startAt` is in the future.

Invalid explicit merge policies or schedules return `400`.

Scheduled cards include `schedule`, `nextRunAt`, and `lastScheduledRunAt` in card responses. Due occurrences are atomically claimed and advanced. If an active run or capacity limit prevents dispatch, the occurrence is recorded as skipped and the next cadence remains aligned.

### POST /api/admin/scheduler/tick

Owner only. Runs one recurring-card scheduler tick and returns bounded counters:

```json
{
  "status": "ok",
  "now": 1779000000000,
  "scanned": 1,
  "claimed": 1,
  "queued": 1,
  "skipped": 0,
  "invalid": 0
}
```

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

Provision hook for built-in Cloudflare Sandbox workspaces. It accepts the managed session request shape and returns normalized provision status.

Auth:

- Callers must send `Authorization: Bearer <CRABBOX_INTERACTIVE_PROVISION_TOKEN>`.
- Provision, PTY, and standalone stop fail closed when the token is absent, including after the Sandbox binding is removed.

Backends:

- Versioned lifecycle adapters are deliberately excluded from this stateless hook. Create those workspaces through `POST /api/interactive-sessions`, which durably records ownership before calling the adapter.
- Direct built-in Sandbox calls without a managed interactive-session row acquire a durable standalone ownership fence before credential-policy registration. Standalone IDs cannot use the case-insensitive `IS-<number>` managed-session namespace. Retries with the same ID must match the original immutable request; abandoned claims and failed provisions enter the same generation-fenced cleanup path as managed sessions.
- A request whose ID already belongs to a managed interactive session is rejected unless every immutable request field matches that row and the call wins an exact session-version ownership claim before allocating a Sandbox. Completion commits through the immutable lease, claim, agent-token, and status ownership fence while monotonically advancing the session version, so an intervening metadata edit does not discard the non-replayable result.
- Only `runtime=container` is accepted. Crabbox workspaces must use the versioned managed lifecycle.
- Without the `SANDBOX` binding, the request fails instead of selecting another provider.

For a successful direct built-in Sandbox provision, `attachUrl` is an absolute `wss://` URL under `/api/provision/interactive/:id/pty`, and `expiresAt` is bounded by `CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS` (default four hours, maximum one day). Connect with the same `Authorization: Bearer <CRABBOX_INTERACTIVE_PROVISION_TOKEN>` header used for provisioning. The Worker validates the unexpired standalone owner and exact active credential-policy generation, strips the bearer before opening the Sandbox terminal, proxies the WebSocket while periodically revalidating that ownership, and closes both peers after stop, expiry, or policy revocation. It never routes the connection through `interactive_sessions`. `POST /api/provision/interactive/:id/stop` always requires that configured bearer, even if runtime backend bindings were removed after creation, and atomically moves the exact owner plus every matching policy into durable cleanup; expiry follows the same path from cron and PTY access, and cleanup terminates the Sandbox terminal execution session before deleting its owner row.

#### Versioned runtime adapter

Crabfleet authenticates every adapter request with `Authorization: Bearer CRABBOX_RUNTIME_ADAPTER_TOKEN`. Configure either one fixed `CRABBOX_RUNTIME_ADAPTER_URL` or a profile-routed `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE`, never both. A template contains exactly one `{profile}` full path segment and accepts only lowercase DNS-label profile IDs. This lets a generic profile catalog select separate outbound adapters without teaching Crabfleet about their providers. Adapter URLs must use HTTPS, except literal loopback HTTP for same-host deployments. The original or resolved base URL may include a nested path, whose semantics are preserved, but any raw `?` or `#` delimiter is rejected even when its query or fragment is empty. Authenticated adapter requests reject redirects so the bearer token cannot cross origins. The resolved canonical control-plane base URL is persisted with the lifecycle registration before create. Replay, inspect, desktop connection, and delete recompute the route from the persisted profile and fail closed unless it exactly matches that registered identity, so a configuration change cannot redirect an existing workspace ID or turn a 404 from another origin into release proof.

- `POST /v1/workspaces`: idempotent create. Crabfleet persists the deterministic adapter identity, TTL, idle timeout, requested capabilities, and exact serialized create payload before the request, then sends the same namespaced DNS-safe lowercase `id` and `Idempotency-Key`, plus repo, branch, runtime, opaque profile, command, prompt, ownership/lineage, and lifecycle settings. A definitive non-2xx response to the initial request is read once, sanitized, and durably recorded as the failure reason before provider release begins. After an ambiguous result, a bounded reconciliation pass retries only that immutable payload and key before any inspect; later edits to session metadata do not alter it. Replay-time authentication, routing, validation, or other non-success responses cannot prove the original request failed and therefore keep create ambiguity pending.
- An adapter that finds the requested ID already bound to a different immutable request returns `409` with `error.code = "workspace_id_conflict"`. Crabfleet marks only its local session failed and atomically drops that adapter identity when the exact pending create attempt still owns the lifecycle revision and reconciliation claim; a stale conflict response is ignored. It never adopts, inspects, or deletes the pre-existing workspace. Other `409` responses remain ambiguous and retryable.
- `GET /v1/workspaces/:id`: inspect current status, capabilities, terminal URL, expiry, and provider resource identity. Status-only responses preserve previously stored capabilities and expiry; explicit `null` clears those fields. Active external sessions are reconciled in bounded batches; state responses wait only for a short foreground budget while remaining work continues in the Worker background.
- `DELETE /v1/workspaces/:id`: stop/release. Crabfleet enters `stopping` before calling the adapter and marks the session stopped only after `204`, `404`, or a valid exact-ID terminal response confirms release; malformed successful bodies remain `stopping`. Plain-text and malformed-JSON responses are read once and sanitized before their evidence is retained. An explicit stop whose ownership claim loses returns success only when the exact workspace is already stopping or terminal; otherwise it returns a lifecycle conflict.
- `POST /v1/workspaces/:id/connections/desktop`: mint a current transient desktop URL. The request has no body. `expiresAt` is optional; when present it must be in the future and no more than 15 minutes away. Accepted HTTPS URLs are treated as opaque signed connection material and redirected byte-for-byte without URL normalization. After minting, Crabfleet re-reads the exact current session status, control grant, capabilities, and registered adapter identity before redirecting; a concurrent stop, revocation, capability withdrawal, or lifecycle replacement discards the URL and denies access.
- `POST /v1/workspaces/:id/connections/native-vnc`: mint a short-lived, single-use native VNC grant. The response must use the `crabbox/native-vnc-grant/v1` schema, an HTTPS broker URL (literal loopback HTTP is allowed for development), the exact opaque lease ID, a 32-byte-hex `native_vnc_` ticket, and an expiry no more than two minutes away. Crabfleet never exposes the provider lease ID in Fleet state and requests this grant only after revalidating current session control and the persisted adapter identity.

`CRABBOX_RUNTIME_ADAPTER_NAMESPACE` is required and must remain stable for the deployment. It prevents workspace and idempotency collisions when an adapter serves more than one Crabfleet tenant. The adapter workspace `id` is an immutable lifecycle route key and remains separate from an opaque `providerResourceId`; the provider identity is never interpreted as a Sandbox lease ID. Create, inspect, and stop responses must echo the byte-exact requested DNS-safe `id`; whitespace normalization is not accepted. Responses use `status`, `id`, optional `providerResourceId`, `attachUrl`, `capabilities`, `expiresAt`, and `message`. The optional `capabilities.nativeVnc` flag advertises a native-client handoff without asserting that the browser desktop endpoint exists; `vnc` and `desktop` remain the browser endpoint capability. Only a literal `null` clears a previously stored expiry; a malformed non-null timestamp invalidates the response. A terminal URL implies terminal capability only when the response omits a terminal capability; an explicit `terminal: false` wins. Supported status values include `provisioning`, `ready`, `stopping`, `stopped`, `expired`, and `failed`. Every session-bound provider DELETE is gated on the persisted create ambiguity marker being clear.

Every create, inspect, delete, and desktop response body is consumed through one 64 KiB bounded stream reader before JSON or text parsing. Declared or chunked oversized bodies are cancelled and fail safely: ambiguous create remains reconcilable, delete remains pending, inspect retries later, and desktop access is denied.

Adapter messages are untrusted display text. Crabfleet removes raw and slash-escaped HTTP/WebSocket connection URLs directly from arbitrary message/detail text; Bearer and Basic credentials; authorization, cookie, and API-key headers; and sensitive assignments such as quoted JSON, colon fields, `token`, `ticket`, `access_token`, passwords, signatures, and secrets before replacing opaque provider identifiers and storing text in `lastEvent`, events, terminal failure evidence, or archives. For non-successful or malformed responses, opaque `providerResourceId`, `provider_resource_id`, `leaseId`, and `lease_id` values are collected from body, workspace, and error envelopes before redaction. Sanitizing credential structure first prevents an identifier such as `token` from hiding `token=secret`.

An adapter-reported `failed` workspace is not locally terminal until Crabfleet calls DELETE and confirms release. Crabfleet durably clears create ambiguity and records the requested failed terminal state and original failure reason before awaiting DELETE, so reconciliation cannot replay the create or replace useful failure evidence with a generic release message. Asynchronous or uncertain release remains `stopping`; reconciliation records `failed` only after the workspace is gone. A stop racing an ambiguous create also remains `stopping`: every reconciliation pass uses a dedicated replay path fenced to the exact `stopping` row, pending marker, registered control plane, immutable payload, settings, and session version, then issues DELETE before recording the requested terminal state. Generic provisioning cannot restage that row. After confirmed release, Crabfleet re-reads and compare-and-swaps the current ambiguity marker and terminal intent: a cleared marker terminalizes immediately, while a still-pending create remains `stopping`. Only a valid exact-ID successful replay, including `provisioning`, proves ownership and clears ambiguity. An explicit `workspace_id_conflict` proves non-ownership and atomically detaches the local lifecycle without DELETE; every other replay response leaves the marker pending.

### GET /api/terminal/ws

Visible session owner, user with a current named viewer/controller grant, current delegated controller, SSH gateway linked-key identity, scoped session agent, or a public shared-link token for read-only sessions. In shared tenancy mode, legacy maintainer/owner visibility also applies. Multiplex WebSocket endpoint used by the Ghostty WASM session grid, Go CLI, and SSH gateway. One socket can subscribe to multiple interactive sessions, receive PTY output frames, resize terminals, and send input only when the current user has control.

The wire format is a compact binary frame:

```text
u16 magic 0x5943
u8 version 2
u8 message_type
u32 session_id_length
utf8 session_id
u32 payload_length
payload bytes
```

Supported client actions:

- `Subscribe`: attach to a session with output/snapshot/event flags. Its payload is exactly five little-endian `u32` fields: flags, snapshot minimum interval, snapshot maximum interval, initial cols, and initial rows. Zero dimensions select server defaults.
- `Unsubscribe`: detach one session without closing the hub.
- `Input` / `Key`: send terminal bytes when control is granted.
- `Resize`: forward terminal dimensions to the upstream PTY.
- `Stop`: close the upstream subscription.
- `Ping`: keepalive, answered with `Pong`.
- `Ack`: acknowledge consumed output bytes for negotiated flow control.

Server messages include `Welcome`, `Output`, `Event`, `Error`, `ControlRevoked`, and `Pong`. Shared-link and named-viewer clients can subscribe and scroll output, but input frames are rejected without current controller or owner access. Subscriptions require the current `terminal` capability; withdrawing it prevents new attaches, closes existing terminal sockets on the next authorization check, suppresses attachable state from app, API, fleet, CLI, and SSH responses, and removes Fleet terminal/SSH affordances. Recurring and per-input authorization use short-lived D1 snapshots only; throttled subscription reconciliation runs independently and never blocks an input frame on provider I/O.

Target resolution:

- Built-in Sandbox terminal: Crabfleet opens the session PTY through the `SANDBOX` binding and forwards the requested terminal dimensions.
- Provider terminal connection: if the provision adapter returned a `wss://` URL, or literal loopback `ws://` URL, Crabfleet retains it server-side and proxies to it unchanged, including its path and signed query string.

Crabfleet never rewrites an adapter `attachUrl`. It authenticates versioned-adapter terminal upgrades with `CRABBOX_RUNTIME_ADAPTER_TOKEN` only when the terminal shares the persisted and currently configured adapter origin; adapter URLs never carry reusable shell credentials. Clients never receive upstream credentials.

### POST /api/interactive-sessions/:id/clipboard

Viewer+ with writable terminal control. Uploads a browser clipboard image/file body into the controlled Cloudflare Sandbox workspace and returns `{ path, name, mediaType, byteCount }`. The browser then pastes the returned path into the PTY. Max body size: 10 MiB. Non-Sandbox PTY backends do not expose file paste.

### GET /api/interactive-sessions/:id/vnc

Viewer+ with writable session control. For `runtime-v1`, Crabfleet authenticates the browser session, asks the adapter to mint a current desktop connection, validates its HTTPS URL and optional bounded expiry, and issues a no-store redirect. Versioned-adapter desktop URLs are never persisted in D1 or returned by fleet state. API and CLI session views expose an absolute canonical Crabfleet browser URL for this cookie-authenticated route; the SSH gateway does not mint or receive the underlying adapter URL. Built-in Sandbox sessions may expose their validated desktop URL while active.

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
  "owner": "operator@example.test",
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

Every new work key requires `owner`; it must resolve to exactly one active Crabfleet user by login, email, or stable subject. Existing owned work keys can resume without repeating it, and a work key cannot transfer to a different stable owner. `runnerPtyUrl` is directly usable with Node's global `WebSocket`; no custom headers are required. The query credential is session-scoped, rotates on registration, is stored only as a hash, and is not exposed through viewer/session APIs.

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
- `runtime`: optional `crabbox` or `container`; the value must be enabled by `CRABFLEET_INTERACTIVE_RUNTIMES`. Omission uses `CRABFLEET_DEFAULT_RUNTIME`, which defaults to `container` when enabled or otherwise the only enabled runtime.
- `profile`: optional opaque adapter profile, defaulted by `CRABFLEET_DEFAULT_PROFILE`. When `CRABFLEET_RUNTIME_PROFILES_JSON` is configured, the value must name a configured profile; its capability flags seed the requested adapter capabilities for Crabbox sessions.
- `github_actions` is service-created through `/api/openclaw/action-sessions` and is not accepted by this endpoint.
- `command`: optional, default `codex`.
- `prompt`: optional initial context note.
- `parentSessionId`: optional parent session for supervision trees.
- `rootSessionId`: optional root session; inferred from the parent when present.
- `purpose`: optional short mission label.
- `summary`: optional list/closeout summary.

Container sessions use the built-in Sandbox when its binding is available. Otherwise, and for Crabbox sessions, `CRABBOX_RUNTIME_ADAPTER_URL` or `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` creates and reconciles the versioned adapter workspace and records its resolved lifecycle identity, status, capabilities, expiry, and terminal connection. Without either supported backend the session is stored as `pending_adapter`.

Session responses include `ptyAvailable`, the authenticated Worker's authoritative answer for whether the current terminal capability, lifecycle state, grant, and configured Sandbox or adapter route permit a PTY connection. Owners, controllers, and named viewers with live read-only access receive only the Worker-owned `/api/terminal/ws` route in `attachUrl`; signed provider connections remain server-side, and every input frame is independently restricted to current controllers.

When the selected runtime profile configures `codexSsh`, a ready `runtime-v1` session response may include `codexSsh: { alias, setupCommand }` for session managers. The alias and optional command are resolved from bounded `{providerResourceId}`, `{workspaceId}`, `{sessionId}`, and `{profile}` placeholders. Alias components use a strict OpenSSH-safe character set. `codexSsh.setupCommand` is an argv-like array whose first and static items use a shell-safe character set and whose dynamic items must each be one complete placeholder; Crabfleet POSIX-shell-quotes every substituted argument so opaque provider identifiers remain data. Missing values, an unsafe resolved alias, or a current profile route that differs from the workspace's immutable registered adapter control plane suppresses the handoff. Shared links and delegated terminal-only controllers never receive it. The command is display/copy data only; Crabfleet never executes it.

Built-in Sandbox sessions receive `CRABFLEET_SESSION_ID`, `CRABFLEET_PARENT_SESSION_ID`, `CRABFLEET_ROOT_SESSION_ID`, `CRABFLEET_AGENT_TOKEN`, and `CRABFLEET_API_URL`. The managed provision hook rotates a fresh agent token in the same durable claim that owns provisioning, then injects that exact token into the Sandbox. The agent token can call the `/api/agent/*` endpoints below for its authenticated session and direct children, including child creation, transcripts, and summary updates; it cannot discover unrelated sessions owned by the same human.

### POST /api/interactive-sessions/cleanup

Viewer+. Deletes manageable stopped, expired, or failed sessions only after terminal finalization, credential-policy cleanup, and complete archive finalization. Pass an optional `ids` array to limit cleanup; an empty list considers all eligible dead sessions visible to the caller.

```json
{
  "ids": ["IS-105", "IS-109"]
}
```

Returns refreshed app state plus `removedIds`.

### GET /api/interactive-sessions/:id

Authenticated viewer. Returns one current decorated session after a bounded lifecycle refresh only when the caller owns it, has a current named grant, or holds the active delegated-control lease. Hidden sessions return `404`.

### GET /api/interactive-sessions/:id/logs

Visible-session viewer. Returns up to 5,000 recent D1 events, the total event count, truncation state, and current R2 archive snapshot metadata when available. It does not read or return the archived R2 objects.

### GET /api/interactive-sessions/:id/transcript

Visible-session viewer. Returns the Markdown transcript from R2 when archived, or a D1 event-log transcript fallback.

### POST /api/interactive-sessions/:id/summary

Session manager. In private mode this is the stable session owner. Updates `purpose` and/or `summary`.

```json
{
  "purpose": "review sibling fix",
  "summary": "waiting on CI"
}
```

### GET /api/interactive-sessions/:id/grants

Session owner. Lists named access grants, including role and expiry. Expired grants remain visible for owner audit but do not authorize access. Listing remains available while a session is stopping so access can be audited and revoked during teardown.

### POST /api/interactive-sessions/:id/grants

Session owner. Creates or replaces one time-limited named grant for exactly one active Crabfleet user. Resolution rechecks the current allowlist or configured trusted-proxy automatic role instead of trusting persisted historical admission state. Returns `201` and the refreshed grant list.

```json
{
  "principal": "teammate@example.com",
  "role": "controller",
  "expiresInSeconds": 86400
}
```

- `principal`: unique active user subject, login, or email.
- `role`: `viewer` for state/log/transcript/read-only terminal access, or `controller` to add terminal input, diagnostics, clipboard, and desktop access.
- `expiresInSeconds`: optional; defaults to 24 hours and must be between 5 minutes and 30 days.

### DELETE /api/interactive-sessions/:id/grants/:subject

Session owner. Revokes the named grant, atomically clears any pending or active delegated-control lease for that subject, and advances the session revision so an older concurrent approval cannot restore control. Revocation remains available while the session is stopping. Returns the refreshed grant list. `:subject` is URL encoded.

### GET /api/interactive-sessions/:id/diagnostics

Viewer+ with writable control. Runs a bounded environment, checkout, GitHub, Codex, and tool inventory inside a Cloudflare Sandbox session. Other backends return an unavailable result instead of executing diagnostics.

### GET /api/interactive-sessions/:id/checkpoints

Session manager. In private mode this is the stable session owner. Lists registered Cloudflare Sandbox checkpoints without exposing provider backup material.

### POST /api/interactive-sessions/:id/checkpoints

Session manager. In private mode this is the stable session owner. Creates a backup of the current Sandbox worktree and returns `201`. Checkpoint storage requires the configured backup R2 binding and, for presigned backups, the matching Cloudflare account and R2 credentials.

### POST /api/interactive-sessions/:id/checkpoints/:checkpoint/restore

Session manager. In private mode this is the stable session owner. Restores a registered checkpoint into the active Cloudflare Sandbox session.

### POST /api/interactive-sessions/:id/actions

Actions:

- `attach`: viewer with control, mark seen/attached and return the session.
- `share_link`: session manager, enable or rotate a public read-only share URL; response includes `shareUrl` once.
- `disable_share`: session manager, disable the share URL and clear pending/granted control.
- `request_control`: viewer, request writable terminal control.
- `approve_control`: session manager, grant pending requester 30 minutes of writable terminal control.
- `deny_control`: session manager, clear a pending control request.
- `revoke_control`: session manager, revoke active delegated control.
- `enable_multiplayer`: session creator, prefix submitted terminal prompts with the actor.
- `disable_multiplayer`: session creator, stop prefixing submitted terminal prompts with the actor.
- `stop`: session manager, internal wire action behind user-facing Delete or End. Versioned adapters release the provider workspace before marking stopped, and asynchronous releases remain `stopping` until reconciliation confirms completion. Built-in Sandbox sessions clean up their durable lease and credential policy. For GitHub Actions, End disconnects and finalizes only the Crabfleet terminal session; it does not call GitHub's workflow-cancellation API, so the workflow run may continue.

Response:

```json
{
  "session": {},
  "shareUrl": "https://crabfleet.openclaw.ai/app/sessions/IS-105?token=..."
}
```

## SSH Gateway

The Go gateway terminates raw SSH and calls Worker APIs with `Authorization: Bearer
CRABFLEET_SSH_GATEWAY_TOKEN`. These endpoints are not browser APIs.

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
- `GET /api/agent/interactive-sessions/:id`: reads the authenticated session or one of its direct children.
- `GET /api/agent/interactive-sessions/:id/logs`: returns event logs.
- `GET /api/agent/interactive-sessions/:id/transcript`: returns the Markdown transcript.
- `POST /api/agent/interactive-sessions/:id/summary`: updates `purpose` and/or `summary`.

Session-scoped terminal steering uses `/api/terminal/ws` with the agent bearer and session ID header; the CLI uses this protocol for `crabfleet message`.

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
request instead of provisioning duplicate work. The fingerprint includes the
resolved stable owner subject and a nonreversible digest of any supplied GitHub
credential; the credential itself is not stored in the replay ledger.
Request IDs created before stable-owner fingerprints were introduced are intentionally not replayed; callers must allocate a new request ID.

`owner` must resolve to exactly one active Crabfleet user by login, email, or stable subject. Crabfleet persists both the stable subject and the user's actor-compatible login/email so Sandbox credential and lease checks agree with the human owner. That subject owns human visibility and management; the exact OpenClaw service separately retains automation lifecycle and terminal authority for its own session and only descendants first validated inside that service-owned lineage.

Response:

```json
{
  "session": {
    "id": "IS-105",
    "owner": "steipete",
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
session, paste files, or access sibling sessions. Ticket signing requires the
Crabfleet-only `CRABBOX_EMBED_TICKET_SECRET`; room-service consumers must never
receive that signing secret.

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
tree above the normal supervision limit. It returns only after the whole
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
- `desktopHosts`: private registered Tailscale VNC endpoints owned by the signed-in stable subject

Secrets, ciphertext, and token values are never returned.

### PUT /api/desktop-hosts/:id

Registers or updates one private desktop owned by the signed-in viewer. The ID
is a stable 1-80 character machine identifier. The address must be a canonical
IPv4 address in Tailscale's `100.64.0.0/10` range; arbitrary LAN and public
addresses are rejected.

```json
{
  "name": "Studio",
  "address": "100.64.12.34",
  "port": 5901
}
```

The host is visible only to the same stable user, regardless of shared or
private session-tenancy mode. Re-registering the same ID updates its name,
address, port, and timestamp while preserving its creation time.

### DELETE /api/desktop-hosts/:id

Removes one registered desktop owned by the signed-in viewer. The route cannot
remove another user's record with the same ID.

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
