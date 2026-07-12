---
title: Runs
layout: default
permalink: /runs/
description: "Runtime execution, logs, attach/takeover, and debugging for Codex runs."
---

# Runs

A card run is a durable scheduling attempt. Crabfleet records heartbeats, runtime selection evidence, operator intent, and event logs in D1; the run row does not launch a process. Live execution is represented by Fleet interactive sessions, which attach to PTYs through the Worker terminal hub and can expose authorized desktop access.

## Run Lifecycle

Current statuses:

```text
queued -> leasing -> running -> review | completed | failed | stalled | canceled
```

Claiming creates a `queued` run attempt and pulses it to `running` on activity. Moving the card to Human Review or Done finishes the active run as `review` or `completed`; moving away from a running card cancels it.

## Claiming

When a maintainer starts or advances a card into Running, the Worker:

1. Reconciles stale active runs.
2. Verifies the repo allowlist.
3. Checks the configured concurrent cap, default `20`.
4. Refreshes cached repo workflow config if needed.
5. Selects runtime descriptor.
6. Inserts a `run_attempts` row.
7. Records scheduler and runtime evidence events.

If the cap is reached, the card stays queued and receives a capacity event.

## Runtime Selection

Selection order:

1. Explicit card runtime `container` or `crabbox`.
2. Prompt cues `vnc`, `manual`, `takeover`, `gpu`, `perf`, or `performance` route to Crabbox.
3. Valid repo `CRABBOX.md` runtime default.
4. Default Container runtime.

Each selected runtime stores:

- `selectionReason`
- `capabilities.terminal`
- `capabilities.takeover`
- `capabilities.vnc`
- `capabilities.desktop`
- `capabilities.logs`
- `capabilities.artifacts`

The UI labels sessions from capabilities, and the API rejects takeover unless the active run advertises takeover.

## Repo Workflow Defaults

Owners can evaluate `CRABBOX.md` in Admin.

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

Supported runtime values are `auto`, `container`, and `crabbox`. Supported merge policies are `open_pr`, `merge_when_green`, and `fix_until_green_and_merge`. Only runtime and merge defaults are enforced. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed and stored for visibility. Invalid files are visible in Admin and ignored for defaults.

## Heartbeats and Stalls

Active statuses are `queued`, `leasing`, and `running`. A run stalls when its heartbeat is older than the configured threshold, default 5 minutes. Reconciliation marks the run `stalled`, sets `endedAt`, stores `heartbeat timeout`, moves the card to Human Review, and logs the event.

Manual `stall` marks the card Human Review and preserves the active run record with the supplied reason.

## Terminal Grid

Attach opens a fullscreen Ghostty WASM grid. Current behavior:

- Shows one or more Codex session tiles.
- Includes standalone interactive Codex CLI sessions created from New session.
- Uses the local `ghostty-web` bundle served by the Worker.
- Streams live PTY bytes through the multiplex `/api/terminal/ws` hub when a Sandbox or versioned adapter terminal is available.
- Replays D1 event logs into the terminal surface while a live PTY is unavailable.
- Falls back to a text terminal if Ghostty cannot initialize.
- Copies terminal selection, pastes clipboard text when the viewer has writable control, and uploads clipboard images/files for Cloudflare Sandbox sessions.
- Persists local grid layout preferences: auto or 1-10 columns, compact mode, drag reorder, and per-tile width/height sizing.
- Supports focused fullscreen card view.
- Supports focused share URLs with public read-only event scrollback and owner-approved writable control requests for signed-in viewers.

The Take over action records `controlIntent = "takeover"` and operator only for active runs with takeover capability.

## Interactive CLI Sessions

Maintainers can create a standalone Codex CLI session without making a board card. The Worker stores the requested repo, branch, runtime, command, owner, attach/VNC URLs, status, and event log in D1. `CRABFLEET_INTERACTIVE_RUNTIMES` limits manual creation to `container`, `crabbox`, or both. `CRABFLEET_DEFAULT_RUNTIME` selects the deployment default (`container` when enabled, otherwise the only enabled runtime); the CLI and SSH gateway leave runtime unspecified unless the operator passes `--runtime`. Internal automation can also register `github_actions` sessions; private-tenancy registrations bind browser visibility to an explicit active user while the exact creating service retains lifecycle authority. This runtime is visible in Fleet but is not offered in the manual session form.

Deployments can expose an allowlisted set of generic Crabbox profiles. The create drawer, Go CLI, and SSH gateway pass the selected opaque profile ID to Crabfleet; the Worker validates it and includes it in the immutable adapter create request. Profile capability flags are previews and requested capabilities, not a substitute for provider enforcement. A profile may also configure a provider-neutral Codex SSH handoff: after a versioned-adapter workspace is ready, its managers receive a validated concrete alias and optional copyable local setup command derived from non-secret session/provider identifiers. The handoff remains fenced to the workspace's immutable adapter control-plane registration. Crabfleet does not execute the command or emulate an SSH login shell; the deployment helper must install the alias and the remote host must expose an authenticated `codex` command on its login-shell `PATH`.

Interactive sessions also store `parentSessionId`, `rootSessionId`, `createdBy`, `purpose`, and `summary`. Built-in Sandbox sessions export `CRABFLEET_SESSION_ID`, `CRABFLEET_PARENT_SESSION_ID`, `CRABFLEET_ROOT_SESSION_ID`, `CRABFLEET_AGENT_TOKEN`, and `CRABFLEET_API_URL`; the Go CLI uses those values to list sibling/child sessions, create children, send PTY messages, fetch transcripts, and update summaries without an SSH key.

Adapter capability arrays are authoritative: omitting `terminal`, `pty`, or `ssh` withdraws terminal access. A valid WSS (or literal-loopback WS) terminal URL implies terminal access only when capabilities are omitted entirely or an object omits all terminal-related keys. `ptyAvailable` additionally requires a ready lifecycle state and a resolvable configured Sandbox or direct adapter WebSocket route.

Session events are mirrored into the `SESSION_LOGS` R2 binding when configured. Crabfleet writes NDJSON, Markdown transcript, and summary objects under `orgs/openclaw/interactive-sessions/<id>/`, while D1 keeps the compact event list and archive keys for the app, CLI, and SSH gateway. If the binding is enabled after D1-only terminal archives were finalized, cron and targeted reconciliation requeue their null-key snapshots and backfill the objects before cleanup. Cleanup transactionally removes the finalized D1 session, events, and archive pointers before best-effort R2 deletion, so a partial object-delete failure is an unreferenced leak rather than a dangling archive reference. Live session lifecycle operations support only built-in Sandbox, the versioned runtime adapter, and GitHub Actions relay sessions.

Sandbox credential policies have a separate durable cleanup lifecycle. Registration commits a generation and expiring claim in D1 before posting the exact owner-bound policy to `SessionControlDO`. Reconciliation promotes a complete accepted generation to active only while the matching Sandbox owner remains current; transient lookup or ownership failures defer cleanup. Credential injection requires that complete active generation and exact D1 owner, so expired standalone policies and orphaned generations fail closed. A registration error for an expected live lease clears into a retryable registration state; an owner transition instead stages the generation for cleanup. Stop, expiry, provisioning failure, and superseded-resource cleanup atomically pair the durable owner transition with policy staging, revoke the session agent token and terminal control, terminate standalone terminal execution sessions, wait out live registration claims, and revalidate that no live owner still expects the Sandbox before persisting a matching generation tombstone. Bounded persisted scan/group cursors keep large cleanup backlogs fair. Failed or partial deletes remain `stopping` and retry from cron until every recorded policy lookup is gone, then enter normal terminal archive finalization with the original failure reason intact. A standalone terminal-destruction failure is recorded on that owner and retried without blocking other cleanup owners, runtime-adapter reconciliation, or terminal archives.

Managed session creation first uses the built-in Sandbox when `runtime=container` and the `SANDBOX` binding is available. Otherwise a configured versioned adapter owns the durable lifecycle. If neither supported path exists, the session stays `pending_adapter` and remains visible in the Ghostty grid.

Crabfleet also ships a built-in Sandbox provision hook at `/api/provision/interactive`. Every provision, PTY, and stop request requires `CRABBOX_INTERACTIVE_PROVISION_TOKEN`. Direct standalone Sandboxes reject the reserved `IS-<number>` namespace, expire after the bounded `CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS`, and stop through `/api/provision/interactive/:id/stop`. The hook accepts only `runtime=container`; external workspaces are deliberately created through the managed versioned lifecycle instead.

Terminal contract:

- Crabfleet accepts browser, CLI, agent, and SSH gateway WebSockets on `/api/terminal/ws` and multiplexes one or more subscribed sessions.
- Browser-to-Crabfleet messages use binary terminal frames for subscribe, input, resize, and stop.
- Upstream output is wrapped in terminal output frames with session IDs.
- Crabfleet resolves each subscription to the built-in Sandbox, a versioned adapter terminal, or the GitHub Actions relay.

GitHub Actions PTY contract:

- OpenClaw registers or resumes work through `POST /api/openclaw/action-sessions`.
- The returned `runnerPtyUrl` is a `wss:` URL with a rotated session-scoped query credential. Node's global `WebSocket` can open it without custom headers.
- Legacy runners open the returned URL unchanged and retain raw input/output with relay-level delivery reporting.
- Generation-fenced runners offer `cfr1-framed-io-v2` as a WebSocket subprotocol and use `CFR1` only when the upgrade response selects it. A relay that ignores the offer leaves `WebSocket.protocol` empty, so the runner remains raw-compatible during rolling upgrades. Viewer input and acknowledgements carry the relay-owned runner generation, stale input is rejected before forwarding, and the runner returns the matching generation and correlation ID only after its PTY accepts the write. The relay continues translating v1 framed and raw sockets.
- `SessionControlDO` allows one current runner and multiple viewers. A new runner replaces the previous runner; viewers remain connected and receive runner lifecycle events.
- Authorized browser viewers attach through the existing `/api/terminal/ws` hub. Service and agent credentials are never included in viewer responses.
- The runner updates `state`, `phase`, `summary`, Codex thread/turn IDs, and heartbeat through the agent work-state endpoint. `completed`, `blocked`, `failed`, and `canceled` are terminal.

See [GitHub Actions Sessions](/github-actions-sessions/) for the full lifecycle,
authentication, resumption, steering, cancellation, archive, and operational
verification contract.

Session sharing:

- Sessions are tenant-private by default; global maintainer/owner roles do not reveal another tenant's sessions.
- `Access` creates an expiring named `viewer` or `controller` grant for one authenticated user.
- Named viewer grants allow logs, transcript, and terminal output; controller grants add terminal input, diagnostics, clipboard, and desktop access.
- Owners can revoke a named grant independently; revocation atomically clears that subject's pending or active delegated-control lease.
- `Share` creates a public read-only URL at `/app/sessions/:id?token=...`.
- The share token is stored as a hash; generating a new link rotates the old one.
- Public viewers can scroll the persisted session event buffer without signing in.
- Writable PTY access still requires owner access, a current controller grant, or an owner-approved delegated-control lease.

Sandbox checkpoints:

- Session managers can list, create, and restore checkpoints for supported Sandbox sessions; in private mode only the stable session owner is a manager.
- Delegated terminal control alone does not grant checkpoint access.
- Browser APIs use `/api/interactive-sessions/:id/checkpoints`.
- CLI and SSH use `checkpoints`, `checkpoint`, and `restore`.
- `CRABFLEET_LOCAL_SANDBOX_BACKUPS=0` selects SDK-presigned R2 uploads; otherwise the deployment uses the bound backup bucket path.

## Run APIs

Start or pulse:

```bash
POST /api/cards/:id/actions
{"action":"start"}
```

Attach:

```bash
POST /api/cards/:id/actions
{"action":"attach"}
```

Take over:

```bash
POST /api/cards/:id/actions
{"action":"takeover"}
```

Requires maintainer role, active run, and `capabilities.takeover = true`.

History:

```bash
GET /api/cards/:id/runs
```

Returns all attempts for the card, newest first.

## Test Stack

- `pnpm run check`: asset generation, `tsc --noEmit`, `oxlint`, `oxfmt --check`.
- SQLite migration smoke with migrations applied in order.
- Structured autoreview per non-trivial change until no accepted/actionable findings remain.
- Browser/live smoke after deploy for `/app`, `/docs/`, auth surface, and docs subdomain.
