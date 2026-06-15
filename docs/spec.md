---
layout: default
title: Spec
permalink: /spec/
description: "Living specification for the shipped Crabfleet control plane."
---

# Crabfleet Spec

Status: living specification of the deployed product.

Canonical OpenClaw app/API: <https://crabfleet.openclaw.ai>

Public product/docs hosts: <https://crabfleet.ai> and <https://www.crabfleet.ai>

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
- provide a native raw-RFB connection contract to the macOS prototype.

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

Fleet state is available through `/api/fleet` and inside `/api/state`.

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
- `maintainer`: session creation/control and card mutation;
- `viewer`: visible state, logs, public share links, and delegated control requests. A terminal subscription requires session ownership, maintainer/owner role, a valid share token, or a current control grant. Session ownership separately grants management operations such as transcripts and checkpoints.

Authorization layers:

1. authenticate by GitHub OAuth, bootstrap token, trusted reverse proxy, linked SSH key, or scoped service token;
2. verify active OpenClaw org membership for GitHub users;
3. resolve direct user/email or team allowlist role;
4. enforce enabled repository access;
5. apply action-specific ownership/control checks.

GitHub sessions last 15 minutes. Bootstrap sessions last 1 hour. Browser sessions are not silently refreshed; expiry requires authentication again.

Trusted-proxy identity is accepted only on the exact configured backend origin with the shared secret and configured identity header. The asserted identity still needs a direct allowlist entry. Mutation and WebSocket requests also prove the public origin. Proxy assertions and upstream credentials are stripped before downstream routing.

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

### Legacy Backends

Compatibility paths remain for:

- create-only `CRABBOX_INTERACTIVE_PROVISION_URL`;
- `CRABBOX_RUNTIME_PROVISION_URL`;
- `CRABBOX_CLOUDFLARE_RUNNER_URL`;
- `CRABBOX_CLAWFLEET_URL`;
- explicit `CRABBOX_PTY_BRIDGE_URL`.

These paths do not gain lifecycle guarantees they do not implement. Legacy sessions may stop only inside Crabfleet when the backend has no delete/release contract.

### GitHub Actions

OpenClaw services register one durable `github_actions` session per stable `workKey`.

Crabfleet owns:

- session identity and metadata;
- rotating scoped agent token;
- outbound runner relay through `SessionControlDO`;
- browser terminal steering;
- work-state heartbeats;
- event and transcript finalization.

The Action remains the execution host and mutation authority. Ending the Crabfleet session does not cancel the workflow run.

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
- a resolvable built-in Sandbox, bridge, runner, or provider terminal;
- current viewer authorization and control state.

`ptyAvailable` is the Worker-authoritative result. Raw provider terminal credentials are never returned to clients.

Provider-backed failure is not terminal until release is confirmed. Stop/failure races remain `stopping` while create ambiguity, credential cleanup, or provider deletion is unresolved.

Scheduled reconciliation and foreground reads advance bounded lifecycle batches. Cleanup deletes dead sessions only after terminal finalization, policy cleanup, and complete archive finalization.

## Terminal And Control

The browser, CLI, session agents, and SSH gateway use one multiplex WebSocket protocol at `/api/terminal/ws`. Frames support subscribe, unsubscribe, input, resize, stop, ping, output, events, errors, control revocation, acknowledgements, and pong.

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

The signed provider URL is not stored in D1 or returned through Fleet. Legacy backends may retain validated persisted VNC URLs.

## Sharing And Supervision

Session sharing:

- owner/maintainer enables or rotates a public read-only URL;
- disabling sharing invalidates the token and clears delegated control;
- shared state includes D1 event scrollback but no write permission.

Supervision:

- sessions may store `parentSessionId`, `rootSessionId`, `purpose`, and `summary`;
- built-in Sandboxes receive a scoped agent token;
- agent APIs allow same-owner state reads, child creation, transcript reads, summary updates, and PTY messaging;
- CLI tree, transcript, message, and summary commands use those APIs.

## Persistence

### D1

Primary tables cover:

- users, sessions, allowlist, repositories, workflow configs;
- cards, run attempts, card events, changes;
- interactive sessions and events;
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

The Worker owns the general multiplex terminal hub and connects each subscription to its Sandbox, bridge, runner, or adapter backend. There is no `BoardDO` or `RunDO`. Board and Fleet state use D1 plus REST polling. The browser refreshes general state every 15 seconds; terminal bytes use WebSockets.

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
- session listing/status/attach/stop/delete;
- logs and transcripts;
- supervision tree, message, and summary operations;
- diagnostics;
- checkpoint creation/list/restore.

### SSH Gateway

The Go gateway maps linked SSH keys to Worker API identities and provides interactive session creation, listing, logs, transcripts, actions, checkpoints, and PTY attach.

### Native macOS Prototype

`macos/CrabfleetMac` is an experimental SwiftUI/AppKit/Metal VNC client. It can read `/api/fleet` and connect to a manually supplied local VNC endpoint. Automatic raw-RFB connection setup is not yet a shipped Worker/Crabbox contract.

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
- public docs/product redirects on `crabfleet.ai` and aliases;
- built-in Sandbox for container sessions;
- the versioned Crabbox adapter with namespace `openclaw`;
- D1, R2, and `SessionControlDO`;
- scheduled lifecycle reconciliation.

Every push to `main` runs checks, tests, builds, migrations, deploys, and endpoint verification through the deployment workflow. The documentation workflow publishes the generated site when documentation inputs change.

## Security Invariants

- No raw application secrets in D1, R2 event bodies, Fleet state, adapter messages, or client URLs.
- Service credentials are scoped to their routes and never accepted as browser identity.
- Adapter requests reject redirects and cross-origin credential movement.
- Provider URLs and messages are bounded, validated, and redacted before persistence.
- Workspace IDs and immutable create requests are fenced against replay and adoption.
- Browser mutations and WebSocket upgrades enforce origin checks.
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

When `nextRunAt` is due, the scheduler queues a normal run attempt for the card and computes the next due timestamp. Active runs are not duplicated; a due card with an active run is skipped until the next tick.

This allows daily operational sweeps, maintenance checks, and recurring repair jobs to remain visible in the normal card/run history.
