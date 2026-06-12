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
  }
}
```

### POST /api/login/token

```json
{
  "token": "bootstrap-token"
}
```

Returns the bootstrap owner user and sets `crabbox_session`.

### GET /login/github

Starts GitHub OAuth with `read:user read:org repo`.

### GET /auth/github/callback

Completes OAuth, verifies active org membership, applies the allowlist, stores the user, and redirects to `/app`.

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
- The token is required when `CRABBOX_RUNTIME_PROVISION_URL`, `CRABBOX_CLOUDFLARE_RUNNER_URL`, or `CRABBOX_CLAWFLEET_URL` is configured; backend-enabled deployments fail closed without it.

Backends:

- `CRABBOX_RUNTIME_PROVISION_URL`: forwards the session payload to a generic runtime adapter.
- `CRABBOX_CLOUDFLARE_RUNNER_URL`: creates a Crabbox Cloudflare container sandbox and returns its lease reference.
- `CRABBOX_CLAWFLEET_URL`: creates a ClawFleet OpenClaw instance and returns console/noVNC links.
- ClawFleet handles `crabbox` sessions only; use `CRABBOX_RUNTIME_PROVISION_URL` or `CRABBOX_CLOUDFLARE_RUNNER_URL` for `container` sessions.
- If neither backend is configured, returns `pending_adapter` with a message that the route is live.

### GET /api/terminal/ws

Viewer+, or public shared-link token for read-only sessions. Same-origin multiplex WebSocket endpoint used by the Ghostty WASM session grid. One browser socket can subscribe to multiple interactive sessions, receive PTY output frames, resize terminals, and send input only when the current user has control.

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

Supported browser actions:

- `Subscribe`: attach to a session with output/snapshot/event flags and optional initial cols/rows.
- `Unsubscribe`: detach one session without closing the hub.
- `Input` / `Key`: send terminal bytes when control is granted.
- `Resize`: forward terminal dimensions to the upstream PTY.
- `Stop`: close the upstream subscription.
- `Ping`: keepalive, answered with `Pong`.

Server messages include `Welcome`, `Output`, `Event`, `Error`, `ControlRevoked`, and `Pong`. Shared-link viewers can subscribe and scroll output, but input frames are rejected unless an owner/maintainer grants writable control.

### POST /api/interactive-sessions/:id/clipboard

Viewer+ with writable terminal control. Uploads a browser clipboard image/file body into the controlled Cloudflare Sandbox workspace and returns `{ path, name, mediaType, byteCount }`. The browser then pastes the returned path into the PTY. Max body size: 10 MiB. Non-Sandbox PTY backends do not expose file paste.

### GET /api/interactive-sessions/:id/pty

Viewer+. Legacy single-session WebSocket endpoint. Crabfleet authenticates the browser session, verifies the interactive session is still attachable, verifies terminal control, then proxies PTY bytes to the configured runner. Owners and maintainers have control by default; other viewers require an approved control request.

Target resolution:

- `CRABBOX_PTY_BRIDGE_URL`: explicit bridge WebSocket URL/template. Templates support `{id}`, `{leaseId}`, `{repo}`, `{branch}`, and `{runtime}`. Crabfleet appends `sessionId`, `leaseId`, `repo`, `branch`, `runtime`, and `command` query parameters.
- `attachUrl`: if the provision adapter returned a `ws://` or `wss://` URL, Crabfleet proxies to it.
- `CRABBOX_CLOUDFLARE_RUNNER_URL`: for `cloudflare:<sandbox>` leases, Crabfleet proxies to `/v1/sandboxes/:sandbox/pty` on the runner.

If `CRABBOX_PTY_BRIDGE_TOKEN` or `CRABBOX_CLOUDFLARE_RUNNER_TOKEN` is set, Crabfleet sends it as a bearer token only to the upstream bridge/runner. The browser never receives runner credentials.

### POST /api/interactive-sessions

Maintainer+. Creates a standalone Codex CLI workspace request.

```json
{
  "repo": "openclaw/crabfleet",
  "branch": "main",
  "runtime": "container",
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
- `runtime`: optional `crabbox` or `container`, default `container`.
- `command`: optional, default `codex`.
- `prompt`: optional initial context note.
- `parentSessionId`: optional parent session for supervision trees.
- `rootSessionId`: optional root session; inferred from the parent when present.
- `purpose`: optional short mission label.
- `summary`: optional list/closeout summary.

If `CRABBOX_INTERACTIVE_PROVISION_URL` is configured, the Worker posts the request to that adapter and records returned `status`, `leaseId`, `attachUrl`, `vncUrl`, and `message`. Without an adapter the session is stored as `pending_adapter`.

Built-in Sandbox sessions receive `CRABFLEET_SESSION_ID`, `CRABFLEET_PARENT_SESSION_ID`, `CRABFLEET_ROOT_SESSION_ID`, `CRABFLEET_AGENT_TOKEN`, and `CRABFLEET_API_URL`. The agent token can call the `/api/agent/*` endpoints below for same-owner session discovery, child creation, transcripts, and summary updates.

### GET /api/interactive-sessions/:id/transcript

Viewer+. Returns the Markdown transcript from R2 when archived, or a D1 event-log transcript fallback.

### POST /api/interactive-sessions/:id/summary

Viewer+ with owner/maintainer access. Updates `purpose` and/or `summary`.

```json
{
  "purpose": "review sibling fix",
  "summary": "waiting on CI"
}
```

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
- `stop`: owner/maintainer, mark stopped.

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
- `GET /api/ssh/interactive-sessions/:id/logs`: returns the D1 event stream plus R2 archive metadata for a visible crabbox session.
- `GET /api/ssh/interactive-sessions/:id/transcript`: returns the Markdown transcript.
- `POST /api/ssh/interactive-sessions/:id/summary`: updates `purpose` and/or `summary`.
- `GET /api/ssh/interactive-sessions/:id/pty`: WebSocket PTY attach for the gateway, scoped by linked key fingerprint.

## Agent Session API

Crabfleet-issued session agents use `Authorization: Bearer <CRABFLEET_AGENT_TOKEN>` plus `X-Crabfleet-Session-ID: <CRABFLEET_SESSION_ID>`. These endpoints mirror the SSH lifecycle subset without requiring an SSH key inside the sandbox.

- `GET /api/agent/state`: returns app/fleet state plus `{ agent: { sessionId, rootSessionId } }`.
- `POST /api/agent/interactive-sessions`: creates a child session owned by the same user and linked under the current agent session.
- `GET /api/agent/interactive-sessions/:id`: reads a visible same-owner session.
- `GET /api/agent/interactive-sessions/:id/logs`: returns event logs.
- `GET /api/agent/interactive-sessions/:id/transcript`: returns the Markdown transcript.
- `POST /api/agent/interactive-sessions/:id/summary`: updates `purpose` and/or `summary`.
- `GET /api/agent/interactive-sessions/:id/pty`: WebSocket PTY attach/input for same-owner steering; the CLI uses this for `crabfleet message`.

## OpenClaw Service

Internal automation uses `Authorization: Bearer CRABBOX_OPENCLAW_TOKEN`.

### POST /api/openclaw/crabboxes

Creates a repo-ready crabbox for an operator, e.g. from a Discord meeting handoff.

```json
{
  "owner": "@steipete",
  "repo": "openclaw/crabfleet",
  "branch": "main",
  "runtime": "crabbox",
  "command": "codex --yolo",
  "prompt": "prep the meeting follow-up"
}
```

Response:

```json
{
  "session": {
    "id": "IS-105",
    "owner": "@steipete",
    "runtime": "crabbox",
    "vncUrl": "https://..."
  }
}
```

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
- `503`: GitHub dependency unavailable or rate limited.
