---
title: Architecture
layout: default
permalink: /architecture/
description: "System design, data model, and runtime architecture for Crabfleet."
---

# Architecture

Crabfleet is a Cloudflare Worker backed by D1. The deployed Worker is the control plane: auth, repo gates, crabboxes, cards, run attempts, workflow evaluation, issue/PR lookup, docs, the Ghostty WASM attach grid, and the same-origin PTY WebSocket proxy all run there today.

Crabbox PTY/VNC links, Durable Object fanout, Discord/OpenClaw orchestration, and merge automation are represented by adapter metadata and product docs; backend bindings are explicit deployment work. Crabbox session events are archived to R2 when the `SESSION_LOGS` binding is configured.

## System Overview

```
Browser app
  | HTTPS
  v
Cloudflare Worker
  - app/docs/static assets
  - REST API
  - GitHub OAuth + repo/issue/PR lookup
  - runtime selection policy
  |
  +-- D1: users, sessions, repos, cards, events, run_attempts, repo_workflows
  +-- SessionControl DO: sandbox credential policy and checkpoint handles
  +-- GitHub API: OAuth, org/team membership, CRABBOX.md, issue/PR previews
  +-- Ghostty WASM: terminal grid asset served by Worker
```

## Core Components

### Worker

`src/index.ts` handles the app shell, docs routes, auth, API routes, Kysely D1 queries, GitHub calls, generated asset serving, and built-in Cloudflare Sandbox lifecycle paths. Sandbox model and GitHub credentials stay in the Worker/DO control path; sandbox env receives placeholders and outbound requests get credentials injected only for approved upstreams.

### D1 + Kysely

Structured persistence uses D1 through a small Kysely dialect.

- `settings`: org config such as cap, retention, and merge policy.
- `allow_entries`: user/team allowlist with roles.
- `repos`: enabled repositories.
- `users`: GitHub users and cached team membership.
- `sessions`: hashed session tokens.
- `cards`: task metadata, prompt, repo, lane, policy, diff summary, active run id.
- `run_attempts`: durable attempt state, heartbeat, runtime, lease fields, operator, selection reason, and runtime capabilities.
- `repo_workflows`: last `CRABBOX.md` evaluation per repo, including status, source SHA, parsed config, prompt guidance, and error.
- `events`: card/run event log.
- `audit_events`: admin action log.

## Runtime Adapter Contract

When a card is claimed, Crabfleet records a runtime descriptor:

- `runtime`: `container` or `crabbox`
- `reason`: card override, repo workflow default, prompt-required desktop/manual/perf capability, or product default
- `capabilities`: terminal, takeover, VNC, desktop, logs, artifacts

The UI and API both use capabilities. Takeover is visible and accepted only for an active run whose descriptor advertises takeover.

Interactive sessions can use the versioned external lifecycle adapter configured by `CRABBOX_RUNTIME_ADAPTER_URL`. The public contract is provider-neutral:

- `POST /v1/workspaces` creates an idempotent workspace from a stable tenant-namespaced DNS-safe adapter ID, repo/ref, opaque profile, command, ownership, TTL, and requested capabilities. Crabfleet persists the identity, canonical control-plane registration, and complete immutable lifecycle snapshot before the network request so timeouts remain recoverable without moving the workspace ID between providers.
- `GET /v1/workspaces/:id` reconciles status, terminal connection, adapter capabilities, expiry, and the separate opaque provider resource ID.
- `DELETE /v1/workspaces/:id` releases the provider workspace before Crabfleet marks the session stopped.
- `POST /v1/workspaces/:id/connections/desktop` mints a current desktop connection after Crabfleet authorization.

Active external sessions are reconciled with compare-and-swap updates so a stale inspect cannot overwrite a concurrent stop. The reconciliation claim and completion both fence the original session revision, and changed state commits a completion-time revision strictly newer than the snapshot; slow provider I/O therefore cannot regress `updated_at` or overwrite a concurrent same-status edit. Credential-cleanup completion and confirmed runtime release use the same ownership CAS and `MAX(updated_at + 1, now)` rule, so terminal archive versions cannot move backward. A durable create-ambiguity marker prevents a stop from becoming terminal while an idempotent request outcome is unknown; a parsed response clears the marker, while ambiguous outcomes replay the exact serialized original request and issue DELETE on every stopping pass until release is confirmed. Replay during `stopping` has its own exact-row path fenced by the pending marker, registered control plane, immutable payload/settings, requested terminal state, and session version; it does not pass through generic provision staging. Definitive create failures read the provider response once, redact it through the shared sanitizer, durably enter `stopping`, clear create ambiguity, and record failed terminal intent plus the actionable failure reason before the DELETE request. All adapter bodies use one 64 KiB bounded stream reader before parsing, including chunked responses, so oversized provider output cannot consume unbounded Worker memory or starve reconciliation. Redaction removes credential and URL structure before substituting opaque provider identifiers, preventing identifier text from masking a secret-bearing field. Redacted provider messages from successful, pending, and failed DELETE responses are persisted while release is pending and retained as events in the final archive. After confirmed release, Crabfleet re-reads and compare-and-swaps the current marker and terminal intent, preventing a pre-DELETE snapshot from either losing failed intent or leaving a resolved create stuck in `stopping`; the original reason remains in the terminal event, API state, and archive. Every terminal event insert and finalization-marker update share one D1 batch, including the finalizer's idempotent synthetic event; summary, sharing, multiplayer, and control mutations include their row update in that same batch. Legacy local stop records its request event, stopped event, terminal state, and finalization marker in one exact-owner D1 batch; cron and targeted reconciliation recover pre-existing or interrupted `stopping` rows. The winning terminal transition forces the final archive, R2 transcript, and summary; equal-count archive replacement is monotonic by mutable session version, while concurrent writers use unique object keys and delete only keys proven not to be the committed archive. Status-only inspection preserves omitted capability, expiry, and terminal fields, while explicit clears remain explicit, including explicit terminal-capability withdrawal despite a terminal URL. Raw terminal URLs, attachability, and UI terminal/SSH affordances are redacted from every outward session shape while terminal capability is false. Known signed connection URLs are also removed from JSON and common slash-escaped provider-message representations before persistence or display. Adapter failures enter provider release first and become locally failed only after release confirmation. State reads with an `ExecutionContext` have a short reconciliation budget and hand at most one three-workspace wave to the Worker background, keeping worst-case adapter timeouts inside the platform lifetime; callers without a context await completion. D1 stores the immutable adapter workspace ID and optional opaque provider resource ID separately, plus the immutable payload and TTL/idle/capability snapshot, create-ambiguity marker, current capabilities, expiry, desired terminal status, last-reconcile, and reconcile-error state. Provider resource IDs never enter legacy lease parsing. Authenticated adapter calls reject redirects. Versioned-adapter terminal and VNC bearer URLs are validated without normalization and accepted values retain their exact signed bytes. Terminal URLs remain server-side and API clients receive only the authenticated Worker PTY route; VNC URLs are never persisted, and browser, CLI, and SSH views receive an absolute canonical Crabfleet browser route which authenticates control before redirecting to the transient adapter URL. After desktop mint, Crabfleet re-reads the exact session status, control grant, capability, and adapter identity before releasing the transient redirect, so concurrent revocation discards the URL. Legacy adapters keep their existing absolute URL contract.

The versioned adapter is reachable only through the durable interactive-session lifecycle, never the stateless provision hook. Existing lifecycle operations resolve through the persisted canonical control-plane identity and fail closed if the live deployment binding differs or disappears. An explicit stop that loses its initial compare-and-swap succeeds only after rereading the exact workspace in `stopping` or terminal state; a concurrent active mutation instead returns conflict. Terminal attach and recurring socket grants require the adapter's current `terminal` capability; withdrawing it closes active sockets. Direct adapter `attachUrl` values stay server-side and receive the configured adapter bearer only when their origin matches both the persisted and currently configured control plane, so reusable shell credentials never enter arbitrary origins, URLs, or the browser; only Crabfleet-owned bridge and runner endpoints receive `cols` and `rows` query parameters. A PTY transport failure leaves the lifecycle workspace detached and retryable rather than terminalizing it without provider release.

Interactive session numbers come from a persistent monotonic sequence, so cleanup never reuses an adapter route or idempotency key. `CRABBOX_RUNTIME_ADAPTER_NAMESPACE` must also be unique and stable for each tenant sharing an adapter.

Deployment identity is runtime configuration rather than an adapter concern. The API returns the configured label, canonical/product URLs, SSH host, preferred repo, default runtime, and opaque default profile so the same public Worker and UI can front different private adapters without source changes.

The public `/api/auth` bootstrap exposes only label, canonical/product URLs, and SSH host. Preferred repo, runtime/profile defaults, and adapter routing remain in authenticated state.

Runtime lifecycle reconciliation runs from the Worker cron every minute and from bounded, CAS-claimed targeted refreshes on direct session, PTY, and VNC access. Active provider inspection remains scoped to the versioned adapter, while pending terminal archives for every adapter share the same retryable finalizer. Archive metadata includes the mutable session version; pending finalization and D1 deletion proceed only when event count, terminal status, failure reason, summary, and session version all match. Enabling `SESSION_LOGS` later requeues finalized D1-only archives with null object keys, so the same finalizer backfills R2 before cleanup. WebSocket input and recurring permission checks read only cached D1 authorization state; each subscription schedules provider reconciliation separately, with one throttled request in flight, so provider latency cannot block the multiplex frame queue. Fleet polling remains an opportunistic accelerator rather than the lifecycle clock; terminal archive markers retry even when provider credentials are unavailable. Sandbox credential-policy registrations and deletions use a durable D1 outbox. Every registration begin, renewal, activation, and reference repair proves either the exact currently stored Sandbox lease or a live durable initial/refresh/standalone claim; there is no unfenced registration path. Initial and managed provision claims fence the current session revision before external effects; required bindings and token-encryption material are checked before managed claim/token rotation, and every later non-ready result atomically stages the exact claim for terminal cleanup. Their non-replayable completion instead fences the immutable lease, claim, agent-token hash, and status ownership while advancing the mutable session version monotonically, so concurrent metadata writes survive. A winning managed retry atomically adopts its new lease and retires the original Sandbox policy. Stop and failure cleanup uses an exact current or stored refresh fence, stages every current/refresh Sandbox policy in the same batch, and merges terminal intent with `failed > expired > stopped` precedence so a lower-priority race cannot erase failure evidence. Managed sessions and direct stateless Sandbox provisions first acquire durable ownership claims; standalone IDs are excluded from the managed `IS-<number>` namespace. Standalone activation bumps all matching active policy-generation rows and activates the owner in one D1 batch, with a bounded expiry. Its PTY route terminates at a Worker WebSocket proxy that periodically rechecks the exact owner revision, expiry, lease, and active policy generation; stop, expiry, or revocation closes both peers. Standalone stop always requires the provision bearer, including after backend bindings are removed. Authenticated stop, cron expiry, and expired PTY access atomically stage that exact owner and its policy cleanup, and the retryable cleanup destroys the terminal execution session before deleting the owner. Registration claims and generations are committed before any policy POST and renewed before each lookup. Same-generation Durable Object writes may renew the current claim monotonically or replace it only with a later-expiring claim, preventing a delayed abandoned POST from overwriting the newer policy. A registration error on an expected live current lease clears its claim into a retryable state instead of staging cleanup that the live owner forbids; once ownership is gone, the same transition stages cleanup. Cleanup waits for live claims, then atomically stores a generation tombstone before deleting the matching policy. Whether a late POST or cleanup reaches the Durable Object first, the tombstone prevents credential resurrection, including when a Worker dies after POST but before its D1 completion update. Cleanup discovery and alias normalization use bounded high-water pages with persisted row and group cursors; deletion retries are ordered by oldest attempt with deterministic ties, so a large or continuously growing backlog cannot keep an invocation from reaching tombstone work or starve older rows. Session or standalone-owner cleanup transitions and their policy transitions share one D1 batch, and the unregister claim revalidates that neither a current lease/refresh nor a live standalone owner still expects that Sandbox; losing the owner CAS therefore cannot tombstone a live policy. Cron retries partial or failed cleanup idempotently and finalizes only after every policy reference is gone. Dead-session cleanup captures the archive keys, then claims, revalidates, and deletes the event, archive, and session rows in one D1 batch. R2 objects are deleted only after that commit, so an object-delete failure can leak unreferenced objects but cannot leave a surviving D1 row pointing at deleted keys.

Credential injection fails closed unless the generation-wrapped Durable Object policy matches the complete active D1 generation and an exact live managed or standalone owner; raw legacy records and expired standalone policies are never served. If the Worker dies after the Durable Object accepts a current registration but before D1 activation, reconciliation verifies every lookup alias and the exact live owner, then promotes the matching expired registration claim to active before cleanup scanning. A lookup or ownership error defers cleanup for that pass. Raw records discovered during upgrade remain retained but unavailable while cron promotes their migrated D1 generation under an exact current-lease registration claim. An early raw lookup synchronously invokes that same repair and retries once, so an unattended session need not wait for cron. Each alias is wrapped transactionally in the Durable Object, successful completion replaces the legacy D1 generation, and an interrupted pass resumes idempotently after its claim expires. Cleanup accepts the old wrapped generation when stop races promotion, preventing a stranded Durable Object record. Standalone terminal-destruction failures remain on that owner's cleanup row with a monotonic retry revision, while other owners, runtime-adapter reconciliation, and terminal archives continue. The managed ID allocator compares standalone reservations case-insensitively, and the upgrade migration advances its sequence beyond every numeric standalone reservation before allocating again.

Current selection order:

1. Explicit card runtime `container` or `crabbox`
2. Hard prompt cues: `vnc`, `manual`, `takeover`, `gpu`, `perf`, `performance` route to Crabbox
3. Valid repo `CRABBOX.md` runtime default
4. Product default: Crabbox

## Repo Workflow Config

Owners can evaluate `CRABBOX.md` for an allowlisted repo. The Worker fetches it from GitHub, decodes UTF-8 base64 content, parses simple frontmatter, stores status/errors in D1, and applies only valid `ok` configs.

For private repos, workflow refresh requires a deployment `GITHUB_TOKEN` with contents access. The Worker does not use the logged-in user's OAuth token for this fetch.

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

Only runtime and merge defaults are effective today. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed/stored for future policy work. Invalid runtime or merge values are stored as `invalid` and do not affect card defaults.

## Data Model

### Card

```typescript
{
  id: string
  title: string
  prompt: string
  repo: string
  source: "Prompt" | "Issue" | "PR"
  runtime: "auto" | "container" | "crabbox"
  policy: "open_pr" | "merge_when_green" | "fix_until_green_and_merge"
  lane: "Todo" | "Running" | "Human Review" | "Done"
  owner: string
  startedAt: number | null
  createdAt: number
  logs: string[]
  changes: CardChanges
  run: RunAttempt | null
}
```

### RunAttempt

```typescript
{
  id: string;
  cardId: string;
  attempt: number;
  runtime: string;
  status: "queued" |
    "leasing" |
    "running" |
    "review" |
    "completed" |
    "failed" |
    "stalled" |
    "canceled";
  controlIntent: string | null;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  selectionReason: string | null;
  capabilities: RuntimeCapabilities;
  operator: string | null;
  lastHeartbeatAt: number;
  startedAt: number | null;
  endedAt: number | null;
  error: string | null;
}
```

## Auth Flow

GitHub OAuth uses `read:user read:org repo`, verifies active org membership, maps teams to `@org/team`, checks the allowlist, and creates a short-lived D1-backed session with an encrypted OAuth token for runtime GitHub CLI access. Bootstrap token login creates an owner session for setup/recovery.

## Planned Integrations

- Cloudflare Container lease binding for autonomous Codex runs.
- Crabbox lease binding for VNC/manual/heavy sessions.
- Runner-side PTY/app-server process hosting behind the Ghostty grid.
- R2 terminal/artifact archival with retention cleanup.
- Durable Object fanout for lower-latency live streams.
- Merge automation handoff once runtime output and PR state are real.
