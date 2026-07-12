---
layout: default
title: Spec
permalink: /spec/
description: "Living specification for the shipped Crabfleet control plane."
---

# Crabfleet Spec

Status: living specification of the deployed product.

Canonical OpenClaw app/API: <https://crabfleet.openclaw.ai>

Public product/docs host: <https://crabfleet.ai>

SSH onboarding and CLI gateway: `crabd.sh`

Crabfleet is the OpenClaw control plane for visible, attachable Codex workspaces. It combines a fleet registry, live browser terminals, provider lifecycle management, sharing and supervision, SSH/CLI access, and a lightweight planning board.

## Product Boundaries

Crabfleet currently does:

- create and reconcile interactive Codex sessions;
- provision Cloudflare Sandbox workspaces directly;
- call a versioned external Crabbox runtime adapter;
- attach browser, CLI, SSH, shared-link, and agent clients to live terminals;
- expose transient desktop connections when a backend supports them;
- preserve session events, transcripts, summaries, and archive metadata;
- register and steer durable GitHub Actions sessions;
- model prompt/GitHub work as cards and scheduling attempts;
- apply user, team, repo, runtime, and workflow policy.

Crabfleet currently does not:

- execute card attempts as autonomous background jobs;
- inspect PR checks or merge PRs;
- call ClawSweeper;
- discover arbitrary processes or machines that were not registered as sessions;
- preserve raw terminal byte recordings or arbitrary artifacts in R2;
- expose raw provider VNC credentials or endpoints through the Worker.

Those boundaries are deliberate. This document describes shipped behavior, not an aspirational orchestration layer.

## Product Model

### Fleet

Fleet is the default authenticated page. It groups visible interactive sessions by owner and summarizes:

- runtime and lifecycle status;
- terminal and desktop readiness;
- logs and archive state;
- parent/root supervision lineage;
- GitHub Actions work state;
- redacted Sandbox egress-policy registration.

Fleet state is available through `/api/fleet`, inside `/api/state`, and through
the bearer-authenticated read-only `/api/native/v1/fleet` contract.

### Interactive Session

An interactive session is the live execution object. It owns:

- repository, branch, runtime, profile, command, and prompt;
- creator, owner, parent, and root session identity;
- provider lifecycle identity and immutable create request;
- status, capabilities, expiry, terminal route, and last event;
- share/control/multiplayer state;
- purpose, summary, work state, and work phase;
- D1 events and optional R2 archive pointers.

Session IDs use the `IS-<number>` namespace. Managed session creation reserves that namespace from standalone provision-hook callers.

### Card

A card captures work intent:

- prompt or GitHub issue/PR source;
- enabled repository;
- board lane;
- runtime preference;
- stored merge-policy intent;
- run attempts and events.

Starting or pulsing a card creates or updates a D1 `run_attempts` record. It does not launch a process. Live work belongs to interactive sessions or an external system.

### Run Attempt

A run attempt records scheduler evidence:

- selected runtime and reason;
- status and heartbeat;
- capabilities;
- lease/attach metadata when supplied;
- operator and control intent;
- error and timestamps.

Runtime selection order:

1. explicit card runtime;
2. prompt cues such as VNC, manual takeover, GPU, or performance;
3. valid repo workflow default;
4. Container fallback.

## Access Model

Roles:

- `owner`: deployment administration, plus all maintainer/viewer actions;
- `maintainer`: session creation and card mutation; in shared mode, management of team-visible sessions;
- `viewer`: authorized state, logs, public share links, named grants, and delegated control requests.

`CRABFLEET_TENANCY_MODE` defaults to `private`. Private mode scopes cards to their stable owner subject and sessions to their owner, an unexpired named viewer/controller grant, or the current delegated controller. Global roles do not bypass another tenant. Only the stable owner manages session lifecycle, metadata, checkpoints, links, and named grants; an exact internal service creator retains lifecycle and terminal authority for its own session and explicitly validated descendants in a service-owned lineage. Exact `shared` mode preserves legacy team-wide visibility and role management.

Authorization layers:

1. authenticate by GitHub OAuth, bootstrap token, trusted reverse proxy, linked SSH key, scoped service token, or a browser-approved native device token;
2. verify active OpenClaw org membership for GitHub users;
3. resolve direct user/email or team allowlist role, or a configured trusted-proxy automatic `viewer`/`maintainer` role;
4. enforce enabled repository access;
5. apply action-specific ownership/control checks.

GitHub sessions last 15 minutes. Bootstrap sessions last 1 hour. Browser sessions are not silently refreshed; expiry requires authentication again. Native device tokens last 24 hours, carry only `fleet:read`, and are revocable independently from the approving browser session.

Trusted-proxy identity is accepted only on the exact configured backend origin with the shared secret and configured identity header. The asserted identity needs a direct allowlist entry unless `CRABFLEET_TRUSTED_PROXY_AUTO_ROLE` is exactly `viewer` or `maintainer`; malformed or elevated automatic roles fail closed. Mutation and WebSocket requests also prove the public origin. Proxy assertions and upstream credentials are stripped before downstream routing.

A trusted identity gateway bypasses browser SSO only for the exact native API method/path set: device creation and token polling, native bearer session/Fleet reads, and native bearer revocation. `/native/link/*` remains browser-authenticated and CSRF-protected; a GET never authorizes a device.

## Runtime Backends

### Cloudflare Sandbox

When `runtime=container` and the `SANDBOX` binding is available, Crabfleet:

- allocates a fresh Sandbox and terminal lease;
- checks out the enabled repository;
- prepares a reusable shell with Codex and common tools;
- registers a generation-fenced credential and egress policy;
- injects session-scoped Crabfleet variables and credentials;
- returns a Worker-owned terminal route;
- reconciles expiry, stop, archive, and credential cleanup.

Sandbox checkpoints use provider backups plus a Durable Object registry. They require configured backup storage.

### Versioned Runtime Adapter

`CRABBOX_RUNTIME_ADAPTER_URL` or the mutually exclusive profile-routed `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` enables the durable `/v1/workspaces` contract.

Crabfleet persists the canonical adapter identity, namespaced workspace ID, immutable create payload, idempotency key, lifecycle state, provider identity, capabilities, expiry, and create ambiguity before or during provider calls.

Deployments may expose a bounded allowlist of generic runtime profiles through `CRABFLEET_RUNTIME_PROFILES_JSON`. Authenticated users see those labels when creating Crabbox sessions. The selected opaque profile ID is validated server-side, included in the immutable adapter request, and can seed the requested capability preview. The adapter remains responsible for mapping the profile to a provider and enforcing actual capabilities. Profiles may define a generic `codexSsh` alias and setup-command template. Crabfleet resolves only bounded non-secret identifiers, returns the handoff only to managers of ready versioned-adapter sessions, and leaves provider-specific alias installation outside the public control plane.

`CRABFLEET_INTERACTIVE_RUNTIMES` limits manual session creation to `container`, `crabbox`, or both. The authenticated deployment metadata drives the create drawer, and the API enforces the same allowlist. A deployment with only one enabled runtime omits the selector; `crabbox`-only deployments therefore expose profiles without advertising an unavailable built-in container runtime.

Required properties:

- adapter base URL uses HTTPS, except literal loopback HTTP;
- raw query/fragment delimiters are rejected;
- redirects are rejected;
- every request uses `CRABBOX_RUNTIME_ADAPTER_TOKEN`;
- `CRABBOX_RUNTIME_ADAPTER_NAMESPACE` remains stable;
- create and inspect responses echo the exact workspace ID;
- DELETE must confirm release before a session becomes terminal;
- transient desktop URLs are minted on demand and re-authorized before redirect.

Ambiguous creates are replayed only with the original payload and key. A `workspace_id_conflict` proves non-ownership and never causes Crabfleet to adopt or delete the pre-existing workspace.

### Provision Hook

`POST /api/provision/interactive` provisions only built-in Cloudflare Sandbox workspaces. External workspaces use the versioned runtime-adapter lifecycle through managed interactive sessions.

### GitHub Actions

OpenClaw services register one durable `github_actions` session per stable `workKey`.

Crabfleet owns:

- session identity and metadata;
- rotating scoped agent token;
- outbound runner relay through `SessionControlDO`, preserving legacy raw runner traffic while capability-negotiated runners use correlated binary `CFR1` input, output, acknowledgement, and lifecycle frames;
- browser terminal steering;
- work-state heartbeats;
- event and transcript finalization.

The Action remains the execution host and mutation authority. A negotiated
runner acknowledges viewer input only after its PTY accepts the correlated
write; relay queueing is not acceptance. Legacy runners keep raw input/output
and relay-level delivery reporting. Ending the Crabfleet session does not
cancel the workflow run.

## Session Lifecycle

Statuses:

- `provisioning`
- `pending_adapter`
- `ready`
- `attached`
- `detached`
- `stopping`
- `stopped`
- `expired`
- `failed`

Active means any status except `stopped`, `expired`, or `failed`.

Terminal attachability requires:

- active lifecycle status;
- current `terminal` capability;
- a resolvable built-in Sandbox or provider terminal;
- current viewer authorization and control state.

`ptyAvailable` is the Worker-authoritative result. Raw provider terminal credentials are never returned to clients.

Provider-backed failure is not terminal until release is confirmed. Stop/failure races remain `stopping` while create ambiguity, credential cleanup, or provider deletion is unresolved.

Scheduled reconciliation and foreground reads advance bounded lifecycle batches. Cleanup deletes dead sessions only after terminal finalization, policy cleanup, and complete archive finalization.

## Terminal And Control

The browser, CLI, session agents, and SSH gateway use one multiplex WebSocket protocol at `/api/terminal/ws`. Wire version 2 is the only accepted version. Frames support subscribe, unsubscribe, input, resize, stop, ping, output, events, errors, control revocation, acknowledgements, and pong.

Control rules:

- owners and maintainers can control by default;
- viewers can request control;
- owners/maintainers can approve a 30-minute grant, deny, or revoke;
- public share links are read-only unless a signed-in viewer receives control;
- multiplayer mode prefixes submitted prompts with the actor;
- capability withdrawal or lifecycle transition closes or denies terminal access.

The terminal hub validates recurring authorization from short-lived D1 snapshots. Input does not block on provider inspection.

## Desktop Access

`GET /api/interactive-sessions/:id/vnc` is the browser desktop entrypoint.

For versioned adapters, Crabfleet:

1. authenticates the browser and verifies writable control;
2. asks the registered adapter for a current connection;
3. accepts only HTTPS with an optional future expiry no more than 15 minutes away;
4. re-reads lifecycle, capability, control, and adapter identity;
5. redirects with `cache-control: no-store`.

The signed provider URL is not stored in D1 or returned through Fleet.

## Sharing And Supervision

Session sharing:

- the stable owner creates expiring named `viewer` or `controller` grants for active users;
- revoking a named grant atomically clears that subject's pending or active delegated-control lease;
- the session manager enables or rotates a public read-only URL;
- disabling sharing invalidates the token and clears delegated control;
- shared state includes D1 event scrollback but no write permission.

Supervision:

- sessions may store `parentSessionId`, `rootSessionId`, `purpose`, and `summary`;
- built-in Sandboxes receive a scoped agent token;
- session-scoped agent APIs allow reads and PTY messaging for the authenticated session and its direct children, plus child creation, transcript reads, and summary updates;
- CLI tree, transcript, message, and summary commands use those APIs.

## Persistence

### D1

Primary tables cover:

- users, sessions, allowlist, repositories, workflow configs;
- pending native device links and hashed, expiring native access tokens;
- cards, run attempts, card events, changes;
- interactive sessions, events, stable owner subjects, and expiring named grants;
- share/control state and supervision metadata;
- provider lifecycles, standalone Sandbox ownership, credential-policy ownership;
- terminal finalization and archive pointers;
- audit events and SSH links.

D1 is the source of truth for current app state.

### Durable Objects

`SessionControlDO` owns:

- GitHub Actions runner/viewer relay;
- Sandbox credential-policy registry;
- checkpoint registry.

The Worker owns the general multiplex terminal hub and connects each subscription to its Sandbox, adapter, or GitHub Actions backend. There is no `BoardDO` or `RunDO`. Board and Fleet state use D1 plus REST polling. The browser refreshes general state every 15 seconds; terminal bytes use WebSockets.

### R2

When `SESSION_LOGS` is configured, active session events periodically refresh archive snapshots:

```text
orgs/openclaw/interactive-sessions/<session-id>/events-*.ndjson
orgs/openclaw/interactive-sessions/<session-id>/transcript-*.md
orgs/openclaw/interactive-sessions/<session-id>/summary-*.json
```

R2 stores normalized events, a Markdown transcript, and a summary. Terminal completion forces a current snapshot and clears finalization state only after its event count and session version match. R2 is not a raw terminal-byte recording or arbitrary artifact store.

Checkpoint backups use the separate configured backup bucket.

## Repository Workflow Policy

Enabled repos may provide `CRABBOX.md` with simple colon-delimited frontmatter and optional Markdown prompt text. Nested `runtime:` and `merge:` sections use indentation as shown in the examples; this is not a general YAML or TOML parser.

Recognized config:

- runtime default: `runtime`, `runtime_default`, or `runtime.default`;
- merge default: `policy`, `merge_policy`, `merge_default_policy`, `merge.default_policy`, or `merge.policy`;
- positive numeric metadata: `stall_ms`, `stallMs`, `runtime.stall_ms`, and `cap`;
- prompt metadata: `prompt_prefix`;
- Markdown body after the closing frontmatter delimiter.

Supported runtime values are `auto`, `container`, and `crabbox`. Supported merge values are `open_pr`, `merge_when_green`, and `fix_until_green_and_merge`.

Only runtime and merge defaults affect card creation and runtime selection. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed and stored for visibility but are not enforced by the scheduler.

## Merge Policy

Supported values:

- `open_pr`
- `merge_when_green`
- `fix_until_green_and_merge`

Crabfleet validates and stores merge intent. It does not inspect check runs, merge, enable GitHub automerge, or hand work to ClawSweeper.

The organization policy setting (`guarded`, `disabled`, `maintainers`) is also stored/displayed policy metadata, not active merge authority.

## Archives And Audit

Event archive snapshots refresh during active sessions and are finalized on terminal completion. Reconciliation repairs snapshots when archive counts or session versions diverge.

Current audit coverage includes:

- allowlist changes;
- repo changes;
- policy changes;
- workflow evaluation;
- interactive session cleanup;
- interactive session create and control/lifecycle actions.

There is no audit log UI/API. Card history is stored separately in card events. There are no merge or secret-use audit events because Crabfleet performs neither operation.

## Clients

### Browser

The Worker serves a server-rendered TypeScript app shell with D1-backed REST state and Ghostty WASM terminals. It has Fleet, Board, Sessions, Admin, login, sharing, and focused session routes.

### Go CLI

The `crabfleet` CLI supports:

- SSH linking and session creation;
- session listing/status/attach/delete;
- logs and transcripts;
- supervision tree, message, and summary operations;
- diagnostics;
- checkpoint creation/list/restore.

### SSH Gateway

The Go gateway maps linked SSH keys to Worker API identities and provides interactive session creation, listing, logs, transcripts, actions, checkpoints, and PTY attach.

### Native macOS Prototype

`macos/CrabfleetMac` is an experimental SwiftUI/AppKit/Metal VNC client. It can open saved or ad-hoc VNC endpoints in a local-only mode with no deployment dependency. For Fleet data, a user enters a deployment URL, approves a short-lived device link in an authenticated browser, and receives a 24-hour `fleet:read` token for the versioned native session and Fleet endpoints. The app stores that token per deployment origin in Keychain, rejects redirects, and has no browser-cookie or fixture fallback. For controllable desktop-capable Crabbox sessions, Fleet exposes only the non-secret provider lease identifier. The app launches the installed Crabbox CLI's versioned foreground handoff, reads a bounded loopback endpoint and ephemeral VNC credential from its private stdout pipe, and terminates that helper when the viewer disconnects.

## Deployment

The repository contains:

- the canonical OpenClaw Worker deployment;
- a product-host redirect Worker;
- D1 migrations;
- R2 and Durable Object bindings;
- the docs-site generator and GitHub Pages workflow;
- the Go CLI/SSH gateway;
- the native macOS prototype.

OpenClaw production uses:

- canonical app/API/OAuth host `crabfleet.openclaw.ai`;
- public docs/product redirects on `crabfleet.ai`;
- built-in Sandbox for container sessions;
- the versioned Crabbox adapter with namespace `openclaw`;
- D1, R2, and `SessionControlDO`;
- scheduled lifecycle reconciliation.

Every push to `main` runs checks, tests, builds, migrations, deploys, and endpoint verification through the deployment workflow. The documentation workflow publishes the generated site when documentation inputs change.

## Security Invariants

- No raw application secrets in D1, R2 event bodies, Fleet state, adapter messages, or client URLs.
- Service credentials are scoped to their routes and never accepted as browser identity.
- Native device and browser-link codes are stored hashed, expire after 10 minutes, and can approve or hand off a bearer only once. The issued bearer exists as encrypted ciphertext only until that handoff, is stored by hash thereafter, is limited to `fleet:read`, expires after 24 hours, and is revocable without an external identity-provider round trip. GitHub grants keep only an encrypted server-side OAuth credential for live membership, team, and allowlist revalidation; revocation erases it, scheduled cleanup deletes expired native credential rows, and an approved but unclaimed grant is removed with its 10-minute device link.
- Adapter requests reject redirects and cross-origin credential movement.
- Provider URLs and messages are bounded, validated, and redacted before persistence.
- Workspace IDs and immutable create requests are fenced against replay and adoption.
- Browser mutations and WebSocket upgrades enforce origin checks.
- Tenant-private mode is the fail-closed default; global roles do not reveal foreign cards or sessions.
- Shared links are read-only by default.
- Terminal input requires current control on every path.
- Sandbox credential cleanup is generation-fenced and retried until ownership is safely removed.
- Repository access is allowlisted independently from user authentication.

## Maintained References

- [Architecture](/architecture/)
- [API Reference](/api/)
- [Quickstart](/quickstart/)
- [Cards](/cards/)
- [Runs and Interactive Sessions](/runs/)
- [Administration](/admin/)
- [GitHub Actions Sessions](/github-actions-sessions/)
- [Native macOS Client](/macos-native-client/)
- [Fleet v2 Implementation Record](/spec-v2/)

## Recurring cards

Recurring work is modeled as a card schedule, not as an infinite process loop.

MVP schedule shape:

    { "kind": "interval", "everyMs": 86400000 }

When `nextRunAt` is due, the scheduler claims that exact occurrence with a five-minute recovery lease, queues a normal run attempt when capacity allows, and advances to the first cadence-aligned timestamp after the tick. Catch-up is constant-time. Concurrent ticks cannot claim the same occurrence, and an interrupted claim becomes retryable after its lease expires. Active runs and capacity blocks coalesce the current occurrence instead of causing per-minute retries.

This allows daily operational sweeps, maintenance checks, and recurring repair jobs to remain visible in the normal card/run history.
