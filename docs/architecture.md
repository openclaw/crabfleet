---
title: Architecture
layout: default
permalink: /architecture/
description: "System design, persistence, runtime lifecycle, and security boundaries for Crabfleet."
---

# Architecture

Crabfleet is one Cloudflare Worker control plane with two user-facing views:

- **Fleet** shows live and retained interactive Codex sessions grouped by owner.
- **Board** stores prompt/issue/PR cards, scheduling intent, run attempts, and policy.

The OpenClaw deployment uses the built-in Cloudflare Sandbox for Container sessions and the versioned Crabbox workspace adapter for Crabbox sessions. The same public Worker and UI can front other backends through deployment configuration.

## System Overview

```text
Browser / Go CLI / SSH gateway / OpenClaw automation
                         |
                         v
                Cloudflare Worker
        app, auth, REST, terminal hub, docs
          |          |          |        |
          v          v          v        v
          D1     Sandbox DO   R2 logs   GitHub API
          |
          +--> SessionControlDO
          |      credential policies, checkpoints,
          |      GitHub Actions runner/viewer relay
          |
          +--> versioned Crabbox lifecycle adapter
                 create, inspect, delete, PTY, desktop
```

Board and Fleet state use D1-backed REST responses and poll every 15 seconds while signed in. Live terminal bytes use the multiplex WebSocket hub at `/api/terminal/ws`.

## Worker

`src/index.ts` owns:

- GitHub OAuth, bootstrap login, trusted-proxy auth, and SSH key linking.
- Allowlist, repo, card, workflow, session, Fleet, and admin APIs.
- Card runtime selection and heartbeat/stall state.
- Built-in Cloudflare Sandbox provisioning and credential routing.
- External workspace lifecycle reconciliation.
- Terminal and desktop authorization.
- R2 archive finalization and cleanup.
- GitHub Actions session registration and runner relay.
- Generated app/docs/static assets.

`src/app/` contains the Preact UI. `cmd/crabfleet` is the Go CLI. `cmd/crabbox-ssh-gateway` terminates SSH and calls the Worker's scoped internal API.

`src/worker/runtime-application.ts` is the request/scheduled-event composition
owner for runtime reconciliation, adapter workspace release, and managed or
standalone provisioning. It lazily shares one lifecycle graph per Worker
request or scheduled event.

`src/worker/interactive-session-application.ts` owns interactive-session
creation, reads, presentation, metadata, attach, stop, cleanup, transcripts,
and runtime release coordination. Route adapters and OpenClaw services use the
same request-scoped application instead of rebuilding session service graphs.

`src/worker/openclaw-application.ts` owns room supervision, create, mutation,
root-stop, transcript, embed-ticket, and controller composition.
`src/worker/github-actions-application.ts` owns agent authentication, action
session registration, work-state updates, runner relay, and disconnects.

`src/worker/worker-application.ts` is the request-scoped composition root. It
constructs the four applications once, memoizes shared repositories and
services, assembles route dependencies, and owns Fleet/state projection.
`src/index.ts` retains platform exports, static assets, ingress/auth routing,
API dispatch order, and response error translation.

## Persistence

### D1

D1 is canonical for product metadata:

- `settings`: org name, concurrency cap, retention selection, merge intent.
- `allow_entries`: direct user, email, and team allowlist roles.
- `repos`: enabled repositories.
- `users`, `sessions`, `ssh_keys`, `ssh_link_codes`: browser and SSH identity.
- `cards`, `run_attempts`, `events`: tenant-owned Board state and durable attempt evidence.
- `repo_workflows`: evaluated `CRABBOX.md` source, parsed defaults, and errors.
- `interactive_sessions`, `interactive_session_events`: live/retained session state with stable owner subjects.
- `interactive_session_grants`: expiring per-subject viewer/controller access created by the stable session owner.
- `interactive_session_log_archives`: current archive snapshot metadata and object keys.
- `id_sequences`: monotonic managed session IDs.
- `interactive_session_credential_policies`, `standalone_sandbox_provisions`, and reconcile state: durable credential ownership and teardown.
- `audit_events`: admin and interactive-session lifecycle/control mutations.

### Durable Objects

- `Sandbox` runs first-party Cloudflare Sandbox workspaces.
- `SessionControlDO` stores generation-fenced Sandbox credential/checkpoint state and relays one current GitHub Actions runner to multiple viewers. Existing runners retain raw input/output at the runner boundary; exact connection-query opt-in selects correlated binary `CFR1` input, output, and acknowledgement frames before socket acceptance. Viewer-bound output is always framed so terminal bytes cannot collide with control traffic.

There is no `BoardDO` or `RunDO`. General Board/Fleet state is D1 plus REST polling.

### R2

`SESSION_LOGS` stores periodically refreshed interactive-session snapshots:

```text
orgs/openclaw/interactive-sessions/{id}/events-*.ndjson
orgs/openclaw/interactive-sessions/{id}/transcript-*.md
orgs/openclaw/interactive-sessions/{id}/summary-*.json
```

D1 retains compact events and committed archive pointers. Terminal completion forces a matching final snapshot before cleanup can proceed. Raw PTY-byte replay and arbitrary run artifacts are not part of the current archive contract.

## Cards And Runs

Cards are durable control-plane records, not autonomous workers. Starting a card:

1. Reconciles stale attempts.
2. verifies the repo allowlist and concurrency cap.
3. refreshes cached `CRABBOX.md` state when needed.
4. selects a runtime descriptor.
5. creates a `run_attempts` row.
6. records scheduler/runtime evidence and heartbeat state.

Runtime selection order:

1. Explicit card `container` or `crabbox`.
2. Prompt cues requiring VNC/manual/takeover/GPU/performance capability.
3. Valid repo `CRABBOX.md` runtime default.
4. Container fallback.

Runtime and merge defaults from `CRABBOX.md` affect new cards. Other parsed fields are retained for visibility but are not enforced.

## Interactive Sessions

Interactive sessions are the live execution plane. Supported paths:

- **Built-in Sandbox:** Worker provisions a Cloudflare Sandbox, prepares the repo, starts a Codex-capable shell, and proxies PTY traffic.
- **Versioned runtime adapter:** Worker durably registers a tenant-namespaced workspace ID, creates and reconciles the provider workspace, proxies PTY access, mints transient desktop links, and confirms provider release before terminal state.
- **GitHub Actions:** OpenClaw automation registers a logical work key; an Actions runner connects outbound to `SessionControlDO`, reports work state, and either retains legacy raw terminal traffic or opts into correlated `CFR1` browser input/output through the connection URL. Framed runners acknowledge each PTY write before Crabfleet reports input acceptance.

Sessions can carry a stable tenant owner, parent/root lineage, purpose, summary, named grants, public share state, delegated control, multiplayer mode, archive metadata, and runtime-specific capability state.

`CRABFLEET_TENANCY_MODE` defaults to `private`. Private D1 reads scope cards to the stable owner and sessions to ownership, an unexpired named grant, or a current delegated-control lease before events or archive metadata are loaded. Bootstrap access normalizes every token-derived identity to one stable tenant subject. OpenClaw-created sessions bind their human-facing owner to an active stable subject; the exact internal service creator separately retains lifecycle and terminal authority only after the requested session is validated inside its service-owned lineage. Every direct session, terminal, diagnostics, checkpoint, desktop, cleanup, and metadata path repeats current authorization at its mutation boundary. Global roles do not bypass another tenant. Exact `shared` mode retains the legacy team-wide projection.

Fleet aggregation filters Sandbox policy summaries to the already-visible session IDs before attaching policy details or computing totals. Tenant responses therefore cannot infer another tenant's policy activity from global Durable Object state.

Terminal subscriptions authorize the loaded session before returning lifecycle or capability errors, so missing and tenant-hidden IDs have the same observable result. Generic shared-mode visibility does not imply live terminal access: terminal output requires control authority, a current named grant, or a separately validated share/embed token. Sandbox GitHub-token attachment and stale-lease refresh use the deployment tenancy mode and require stable owner subjects. Client destructive controls use the Worker's per-session `canManage` projection rather than global role inference.

An optional `CRABFLEET_RUNTIME_PROFILES_JSON` allowlist exposes generic Crabbox profile labels and capability previews without teaching the Worker provider-specific semantics. The Worker validates the opaque profile ID. A fixed adapter maps it internally, or `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` selects a distinct outbound adapter by lowercase DNS-label profile; each adapter enforces its real provider capabilities.

`CRABFLEET_INTERACTIVE_RUNTIMES` is the single manual-session runtime allowlist consumed by the API and browser create drawer. Deployments may expose built-in `container`, versioned-adapter `crabbox`, or both; a single enabled runtime becomes implicit in the UI.

## Versioned Adapter

`CRABBOX_RUNTIME_ADAPTER_URL`, or the mutually exclusive profile-routed `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE`, enables the provider-neutral lifecycle contract:

- `POST /v1/workspaces`: idempotent create using an immutable namespaced ID and request snapshot.
- `GET /v1/workspaces/:id`: inspect status, capabilities, expiry, provider identity, and terminal connection. Native-only VNC uses a separate `nativeVnc` capability and does not imply the browser desktop endpoint.
- `DELETE /v1/workspaces/:id`: release the provider workspace.
- `POST /v1/workspaces/:id/connections/desktop`: mint a short-lived desktop URL.

Important invariants:

- The fixed or profile-resolved adapter base URL and namespace become immutable lifecycle identity.
- Authenticated adapter requests require HTTPS, except literal loopback HTTP.
- Redirects are rejected so bearer credentials cannot cross origins.
- Request/response bodies are bounded before parsing.
- Create ambiguity replays the exact original idempotent request before inspection.
- An explicit workspace-ID conflict never adopts or deletes the existing provider workspace.
- Provider failure is not terminal until DELETE confirms release.
- Status, capabilities, expiry, terminal state, and cleanup use compare-and-swap ownership fences.
- Provider terminal URLs stay server-side; browsers receive Worker-owned PTY routes.
- Desktop URLs are transient, reauthorized after minting, never persisted, and redirected without rewriting signed bytes.

Cron runs every minute. Foreground state, terminal subscription, and desktop access also schedule bounded targeted reconciliation.

## Terminal And Desktop

Browser, CLI, agent, and SSH gateway clients use the multiplex `/api/terminal/ws` protocol and subscribe to visible sessions. The Worker:

- rechecks D1 authorization without waiting on provider I/O;
- forwards input only for the current controller;
- closes subscriptions after control or terminal capability is revoked;
- forwards initial dimensions directly to Sandbox terminals and leaves opaque signed adapter URLs unchanged;
- keeps runtime bearer credentials out of browser responses.

Versioned adapter VNC uses the authenticated Worker route `/api/interactive-sessions/:id/vnc`, which mints a fresh provider desktop connection after authorization.

## Sandbox Credentials

Built-in Sandbox environments receive placeholders, not broad model/GitHub secrets. Worker-controlled egress injects credentials only for approved hosts, methods, repositories, and GraphQL shapes.

Credential policy state is generation-fenced across D1 and `SessionControlDO`. Registration, refresh, failure, stop, expiry, and cleanup all prove the exact durable owner. Tombstones prevent late Durable Object writes from resurrecting revoked credentials.

## Archives And Cleanup

Terminal completion records a retryable finalization marker. Archive writes use unique object keys and commit pointers only when the event count, terminal state, failure reason, summary, and mutable session version still match.

Dead-session cleanup:

1. claims and revalidates the exact terminal session;
2. transactionally removes session rows, events, and archive pointers from D1;
3. best-effort deletes the now-unreferenced R2 objects.

If R2 is enabled after D1-only finalization, reconciliation requeues missing objects for backfill.

## Authentication

- **GitHub OAuth:** org membership plus direct/team allowlist; encrypted per-session OAuth token supports scoped runtime GitHub access.
- **Trusted reverse proxy:** exact backend origin plus shared-secret assertion; identity passes the direct allowlist unless a fail-closed `viewer` or `maintainer` automatic role is configured.
- **Bootstrap token:** owner break-glass access.
- **SSH gateway:** linked public-key fingerprint plus gateway bearer.
- **Agent session:** session ID plus session-scoped agent token.
- **OpenClaw service:** dedicated bearer for Crabbox and GitHub Actions registration.
- **Standalone provision hook:** dedicated bearer, including stop after backend configuration changes.

## Current Boundaries

- Cards do not launch autonomous Codex execution.
- Merge policy is stored but Crabfleet does not merge PRs or call ClawSweeper.
- Board/Fleet updates are polling-based rather than general Durable Object fanout.
- R2 archives normalized events, transcripts, and summaries, not raw terminal byte streams or arbitrary artifacts.
- The native macOS VNC app remains a separately built prototype; production distribution/authentication is not part of the Worker deployment.
