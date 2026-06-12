---
layout: default
title: Spec
permalink: /spec/
---

# Crabfleet Spec

Status: draft. Deployed subset: Cloudflare Worker, D1/Kysely persistence, GitHub OAuth, admin allowlists, card/run state, repo workflow evaluation, issue/PR previews, diffs, Cloudflare container sandbox provisioning, Ghostty WASM grid, read-only session share links, and authenticated PTY WebSocket proxying for interactive sessions.

Crabfleet is a Cloudflare-native control plane for running Codex crabboxes in cloud workspaces. It gives OpenClaw maintainers a fleet dashboard where org Codex instances are grouped by person, ready to attach through terminal or WebVNC, and supervised by OpenClaw.

## Decisions

- Product name: Crabfleet.
- Domains: `crabfleet.openclaw.ai` for the OpenClaw app/API/OAuth, `crabfleet.ai` for the public product page, and `crabd.sh` for SSH/install/bootstrap.
- Primary object: card.
- UI direction: Linear-like, minimal, dense, subtle crustacean branding.
- Access: OpenClaw GitHub org plus admin-managed allowlists for users/teams and repos.
- Runtime default: Crabbox for repo-ready Codex, WebVNC, testing, heavier jobs, and performance; Cloudflare Containers remain an explicit lightweight runtime.
- Interactive mode: full Codex CLI in browser through Ghostty WebAssembly.
- Autonomous mode: Codex app-server where structured turns/events are better than terminal scraping.
- Logs: 30-day retention by default.
- Secrets: per OpenClaw org, never stored in D1/R2/log bodies.
- Merge: Crabfleet may merge directly; ClawSweeper remains available and preferred for review/fix/automerge loops.
- OpenClaw fleet/orchestrator backend: run on Hetzner `openclaw-clawsweeper` with ClawSweeper; keep the Worker as the app/API front door.
- Runtime cap: configurable, default 20 concurrent Codex runs per org.
- GitHub comments: Crabfleet does not post progress comments by default.
- VNC: available only for Crabbox-backed leases.
- Repo-owned workflow file: optional `CRABBOX.md`.

## Goals

- Start a Codex from a prompt, GitHub issue, GitHub PR, or issue/PR picker.
- Watch active Codex sessions live.
- Attach to a full Codex CLI through a browser terminal.
- Take over an active session when needed.
- Create PRs, fix PRs, merge PRs, or hand off to ClawSweeper depending on policy.
- Persist logs, terminal replay, session events, diffs, and run metadata.
- Keep access restricted to allowlisted OpenClaw org members and allowlisted repos.
- Run fully on Cloudflare for the product/control plane.

## Current Implementation Status

Implemented now:

- Empty-by-default D1-backed board with Todo, Running, Human Review, Done.
- GitHub OAuth, bootstrap login, org membership check, team/user allowlists, repo allowlists.
- Prompt cards and GitHub `#number` previews across enabled repos.
- Optional titles derived from prompt.
- D1 `run_attempts` with heartbeat, stall reconciliation, runtime selection reason, lease fields, operator intent, and runtime capabilities.
- Runtime adapter descriptor for Container and Crabbox policy.
- Ghostty WASM fullscreen session grid with D1 event replay, live multiplex PTY attach, and text fallback.
- Focused Codex session URLs with public read-only share links and owner-approved control requests.
- `CRABBOX.md` fetch/parse/evaluate admin surface.
- Card diff metadata and compact patch preview.
- Worker docs route at `/docs/` plus GitHub Pages docs.
- Cloudflare container sandbox provisioning through the Crabbox runner.

Not wired yet:

- Crabbox/ClawFleet lease creation.
- External Crabbox/runner-side app-server transport.
- Raw terminal replay/artifact archival.
- Durable Object WebSocket fanout.
- Direct merge execution or ClawSweeper handoff.

## Non-Goals

- Rebuild Crabbox machine leasing.
- Rebuild ClawSweeper's review/automerge safety loop.
- Post progress comments to GitHub by default.
- Replace GitHub Issues or PRs as source systems.
- Build a generic CI provider.

## Product Model

Card is the primary object.

Card source types:

- Freeform prompt
- GitHub issue
- GitHub PR
- Picker result from issue/PR hot search

Each card owns:

- Prompt or source reference
- Repo target
- Lane/state
- Merge policy
- Runtime preference
- Run attempts
- Logs and artifacts
- Current operator/takeover state

Cards may produce:

- Branch
- PR
- Review result
- Merge
- Human handoff
- Failure/stall record

Card policy fields:

- Runtime mode: `auto`, `container`, `crabbox`
- Interaction mode: `cli`, `app_server`, `auto`
- Merge policy: `open_pr`, `merge_when_green`, `fix_until_green_and_merge`
- Automerge enabled: boolean
- Max runtime override
- Retry limit override
- Required validation override

Card source rules:

- Freeform prompt cards require repo selection before running.
- Issue cards inherit repo and issue metadata from GitHub.
- PR cards inherit repo, PR number, head SHA, base branch, and mergeability metadata.
- Picker-created cards should store the original GitHub URL and normalized IDs.
- Batch cards are deferred; MVP cards target one repo and one source item.

## Board

Design: Linear-like, minimal, dense, subtle crustacean branding.

Default visible lanes:

- Backlog
- Todo
- Running
- Human Review

Default hidden lanes:

- Rework
- Merging
- Done
- Canceled
- Duplicate

Lane means workflow state. Automerge is not a lane.

Automerge is a card policy:

- `open_pr`
- `merge_when_green`
- `fix_until_green_and_merge`

The UI shows merge policy as a chip on the card. Subtle claw/check icon when armed.

Card rendering:

- Title
- Source badge: prompt, issue, PR
- Repo badge
- Status chip
- Merge policy chip when non-default
- Runtime chip when not `auto`
- Active timer while running
- Last event summary
- Attach button when live
- PR link when available

Primary views:

- Board
- Card detail drawer
- Run detail drawer
- Terminal view
- Logs/replay view
- Admin view

Top bar:

- Hot search for issues/PRs/cards
- New prompt
- Active Codex count
- Queue count
- Filter
- Display options

Branding:

- Small shell/claw mark.
- Accent colors only for active status/merge intent.
- No cartoon shellfish UI.
- Product language remains professional.

## Runtime Modes

Default runtime:

- Cloudflare Containers when the job fits.
- Crabbox for testing, manual Codex, VNC, heavier jobs, or higher performance.

Runtime mode choices:

- `container`: Cloudflare Container
- `crabbox`: Crabbox lease
- `auto`: scheduler chooses

Manual Codex preference:

- Full Codex CLI in a browser terminal.
- Ghostty WebAssembly terminal receives PTY bytes.
- App-server PTY APIs or a Crabbox-side PTY bridge provide stdin/output/resize.

Autonomous Codex preference:

- Codex app-server `thread/start` and `turn/start`.
- Structured app-server events feed the run log.
- `turn/steer` and `turn/interrupt` support live steering/takeover.

Runtime selection:

1. If card requires VNC, choose Crabbox.
2. If card is manual CLI takeover first, prefer Crabbox unless container PTY is explicitly allowed.
3. If repo/job fits configured container limits, choose Cloudflare Container.
4. If validation requires unsupported system dependencies, choose Crabbox.
5. If org cap is reached, leave card queued.

Cloudflare Container expectations:

- Image includes Codex CLI, Git, GitHub CLI, Node/pnpm, common build tools.
- Container starts app-server or PTY bridge on a local authenticated port.
- Worker/RunDO talks to the container only through controlled bindings/routes.
- Runtime filesystem may be disposable; durable history is in R2/D1.
- Current Cloudflare runner adapter provisions the sandbox; live PTY stdin/stdout still needs a PTY bridge endpoint.

Crabbox expectations:

- Crabfleet requests a lease from Crabbox.
- Crabbox owns provider credentials, SSH, VNC/noVNC, lease lifecycle, and cleanup.
- Crabfleet records the Crabbox lease ID and uses Crabbox attach/VNC affordances.
- Crabfleet does not duplicate Crabbox provider logic.

## Attach Semantics

Attach modes:

- Watch: user sees live terminal/events, no input.
- Take over: user can type into the Codex CLI PTY session or steer app-server turn.
- Share: link recipients can read persisted session scrollback without signing in.
- Request control: signed-in viewers can ask the session owner/maintainer for writable terminal access.

When a user takes over:

- Record operator, time, and mode.
- Continue log persistence.
- Autonomous loop may pause or continue depending on card policy.
- Default: pause autonomous auto-advance while operator has control.

## VNC

VNC is available only for Crabbox-backed leases.

VNC is post-MVP unless Crabbox already exposes it for a lease.

Expected flow:

- Card/run detail shows VNC button when lease supports desktop.
- Browser uses Crabbox noVNC/bridge path.
- Crabfleet records VNC attach events but does not proxy pixels unless needed.

## Auth

Login:

- GitHub OAuth.
- Bootstrap token login for first admin setup and break-glass recovery.
- GitHub OAuth sessions are short-lived verified sessions; encrypted OAuth tokens are stored only on session rows and injected only into server-created runtime environments.
- Bootstrap sessions are short-lived and bound to the current bootstrap token hash.

Access gate:

- User must be in OpenClaw GitHub org.
- User must be allowlisted directly or through an allowlisted GitHub team.

Admin UI:

- Manage allowed GitHub users/teams.
- Manage allowed repos.
- Manage org runtime caps.
- Manage merge permissions.
- Writes persist through the Worker API to D1; browser storage is not authoritative.

Repo gate:

- Only allowlisted repos appear in search/picker.
- Only allowlisted repos can start cards/runs.
- GitHub webhooks ignored unless repo is allowlisted.

Admin roles:

- Owner: manage org settings, users/teams, repos, caps, secrets, merge policy.
- Maintainer: create cards, start/stop/take over runs, approve direct merge if allowed.
- Viewer: watch board, open logs, attach read-only.

Admin UI sections:

- Users and teams
- Repos
- Runtime caps
- Merge policy
- Secrets status
- Audit log

## Secrets

Secrets are per org.

Secret types:

- Codex auth / agent identity
- GitHub app/private key/token material
- Crabbox broker credentials
- Provider/runtime credentials when needed

Storage:

- Cloudflare Secrets for Worker-level secrets.
- Org secret references in D1.
- No secret values in D1, logs, R2, or card metadata.

Policy:

- Runs receive only scoped secrets required for selected repo/runtime.
- Secret usage is logged as redacted metadata.

Secret delivery:

- Worker reads secret by binding/reference.
- Dispatcher passes a scoped session token or ephemeral lease credential to runtime.
- Runtime never receives broad Cloudflare credentials.
- Logs redact common token shapes and known secret labels before R2 writes.

## Merge Authority

Crabfleet can merge directly when policy allows.

Merge paths:

- Direct Crabfleet merge
- ClawSweeper handoff
- Manual human merge

Direct merge guardrails:

- Repo allowlisted.
- User/org policy allows direct merge.
- Exact head SHA known.
- Required checks green.
- Branch up to date or merge queue accepted.
- No active takeover.
- No unresolved required review state.
- Merge action logged.

Direct merge sequence:

1. Refresh PR state from GitHub.
2. Verify repo/user/policy allow direct merge.
3. Verify exact head SHA matches reviewed/validated SHA.
4. Verify required checks and required review state.
5. Verify branch update/merge queue requirements.
6. Perform merge through GitHub App credentials.
7. Record audit event with actor, PR, SHA, checks snapshot, and merge commit.
8. Move card to `Done`.

ClawSweeper handoff:

- Preferred for `fix_until_green_and_merge`.
- Preferred when PR needs review/fix loop.
- Crabfleet sends intent; ClawSweeper owns deterministic GitHub mutation sequence.

Crabfleet direct merge should stay conservative. If any guardrail is unknown, block direct merge and offer ClawSweeper handoff or human review.

## Logs And Retention

Retention: 30 days by default.

Persist:

- Run events
- App-server JSON-RPC events
- Terminal stdout/stderr/PTY stream
- Operator attach/takeover events
- GitHub actions
- Lease lifecycle events
- Final summaries
- Artifact references

Storage:

- D1: searchable event index and metadata.
- R2: full logs, terminal replay, transcripts, diffs, screenshots, artifacts.

After 30 days:

- Delete R2 log bodies/artifacts by lifecycle job.
- Keep minimal D1 run summary unless admin policy deletes all history.

Log streams:

- `events.ndjson`: normalized lifecycle/app events.
- `terminal.raw`: PTY byte stream for replay.
- `terminal.ndjson`: timestamped decoded chunks.
- `app-server.ndjson`: JSON-RPC messages and notifications with secrets redacted.
- `summary.json`: final status, timings, artifacts, PR links.

Replay requirements:

- Completed sessions remain readable until retention expiry.
- Terminal replay preserves timing enough to scrub through a run.
- Search index stores compact event text, not full raw logs.

## Resilience

Default org cap:

- 20 concurrent Codex runs.

Caps are configurable:

- Max concurrent runs
- Max runtime per run
- Max retries
- Max terminal idle time
- Max log bytes per run
- Runtime class allowlist

Stall handling:

- Detect no output/event heartbeat.
- Mark run `stalled`.
- Attempt graceful interrupt/terminate.
- Retry according to card policy.
- Preserve workspace when useful.
- Show stall reason and last activity in UI.

Run lifecycle:

- Queued
- Leasing
- Bootstrapping
- Running
- Waiting
- TakingOver
- Stalled
- Retrying
- Succeeded
- Failed
- Canceled
- Merging
- Done

Retry policy:

- Clean exit with active card state may enqueue continuation.
- Transient runtime failure retries with exponential backoff.
- Validation failure does not retry blindly unless policy says repair.
- Stalls retry only after workspace/log preservation.
- Manual cancel does not retry.

Heartbeat sources:

- App-server notification
- PTY output
- Runtime heartbeat
- Crabbox lease heartbeat
- Container health probe

## Workflow File

Crabfleet may support repo-owned workflow config.

Recommended name: `CRABBOX.md`.

Purpose:

- Version the repo's Codex operating policy with the code.
- Provide prompt template.
- Define validation commands.
- Define branch/PR conventions.
- Define merge/review policy hints.
- Define runtime preference and caps.

It is optional for MVP. Dashboard/org settings provide defaults.

Example:

```md
---
runtime:
  default: auto
  allow:
    - container
    - crabbox
validation:
  required:
    - pnpm check
    - pnpm test
merge:
  default_policy: open_pr
  allow_direct_merge: false
codex:
  mode: cli
  model: gpt-5.5
  reasoning_effort: high
---

You are working in this repository for Crabfleet.
Read AGENTS.md first.
Keep changes scoped.
Open a PR unless the card explicitly allows direct merge.
```

Resolution order:

1. Card explicit settings
2. Repo `CRABBOX.md`
3. Org defaults
4. Product defaults

Invalid `CRABBOX.md`:

- Do not block dashboard access.
- Show validation error in repo settings.
- Ignore invalid file for new runs and use org defaults.

## Tech Stack

Language/tooling:

- TypeScript strict
- pnpm
- oxlint
- oxfmt
- Valibot
- Vitest
- Playwright

Frontend/app:

- TanStack Start
- React
- TanStack Router
- TanStack Query
- Tailwind
- Radix primitives where useful

Cloudflare:

- Workers
- Durable Objects
- D1
- R2
- Queues
- Workflows
- Containers
- Service bindings

Runtime integrations:

- Codex app-server JSON-RPC
- Codex CLI in PTY
- Ghostty WebAssembly terminal
- Crabbox
- ClawSweeper
- GitHub App/OAuth

## Package Layout

```txt
apps/
  web/              TanStack Start app
  control/          Worker API, Durable Objects, Queues
packages/
  schema/           Valibot schemas and inferred types
  ui/               Crabfleet UI components
  github/           GitHub adapters, issue/PR search
  crabbox/          Crabbox client
  codex-app-server/ JSON-RPC client and generated protocol types
  workflow/         CRABBOX.md parser/evaluator
```

Rule:

- TanStack Start handles app shell and UI-adjacent server functions.
- Control Worker owns orchestration.
- Durable Objects own live session state.
- D1 owns canonical metadata.
- R2 owns bulky history.

## Data Model

Core D1 tables:

- `orgs`: GitHub org, display name, caps, defaults.
- `users`: GitHub user ID/login, display name.
- `org_users`: org membership, role, allowlist source.
- `teams`: GitHub team ID/slug allowlist entries.
- `repos`: GitHub repo ID/name, allowlist status, defaults.
- `cards`: source, title, prompt, repo, lane, policy, position.
- `runs`: card ID, attempt, runtime, status, timestamps, lease/container refs.
- `run_events`: compact searchable event index.
- `artifacts`: R2 keys and retention metadata.
- `github_refs`: issue/PR normalized metadata and cache timestamps.
- `audit_events`: admin, merge, secret-use, takeover, and policy changes.

Durable Object state:

- BoardDO keeps hot board ordering and connected viewers.
- RunDO keeps live run status, attached clients, stream cursors, heartbeat, and current process/thread refs.

R2 layout:

```txt
orgs/{org}/runs/{run_id}/events.ndjson
orgs/{org}/runs/{run_id}/terminal.raw
orgs/{org}/runs/{run_id}/terminal.ndjson
orgs/{org}/runs/{run_id}/app-server.ndjson
orgs/{org}/runs/{run_id}/summary.json
orgs/{org}/runs/{run_id}/artifacts/{name}
```

## API Surface

Representative endpoints:

- `GET /api/boards/:repo`
- `POST /api/cards`
- `PATCH /api/cards/:id`
- `POST /api/cards/:id/start`
- `POST /api/cards/:id/cancel`
- `POST /api/cards/:id/merge`
- `POST /api/cards/:id/clawsweeper`
- `GET /api/runs/:id`
- `GET /api/runs/:id/events`
- `GET /api/runs/:id/logs`
- `GET /api/search/github?q=...`
- `GET /api/admin/users`
- `PUT /api/admin/users/:login`
- `GET /api/admin/repos`
- `PUT /api/admin/repos/:owner/:repo`

WebSockets:

- `/ws/board/:board_id`
- `/ws/run/:run_id`
- `/api/terminal/ws`

Service bindings:

- Web app calls Control Worker.
- Control Worker calls BoardDO/RunDO.
- Dispatcher calls runtime adapters.
- MergeController calls GitHub and ClawSweeper bridge.

## Run Flow

Freeform prompt:

1. User creates card with prompt and repo.
2. Card enters `Todo`.
3. Scheduler claims card when capacity exists.
4. Dispatcher chooses runtime.
5. Runtime checks out repo.
6. Codex starts in CLI PTY or app-server mode.
7. RunDO streams events/logs to browser and R2.
8. Codex creates branch/PR or returns result.
9. Card moves to `Human Review`, `Merging`, `Done`, or `Rework`.

Issue:

1. User picks issue.
2. Prompt is built from issue title/body/comments plus repo policy.
3. Codex works from new branch.
4. Result is PR or blocker.

PR:

1. User picks PR.
2. Runtime checks out PR head.
3. Codex reviews/fixes/rebases according to card policy.
4. Crabfleet direct merge or ClawSweeper handoff handles merge.

Manual takeover:

1. User attaches to live run.
2. Watch mode streams only.
3. Takeover mode grants input.
4. Run records takeover.
5. Auto-advance pauses by default.

## GitHub Integration

Use GitHub OAuth for login and GitHub App for repo operations.

GitHub App permissions, draft:

- Metadata: read
- Contents: read/write
- Issues: read
- Pull requests: read/write
- Checks/statuses: read
- Actions: read
- Commit statuses: read

Optional/conditional:

- Administration: avoid unless required.
- Members: use OAuth/org APIs for membership where possible.

Picker behavior:

- Search allowlisted repos only.
- Support `repo#123`, `owner/repo#123`, issue URL, PR URL, title text.
- Multi-select can create multiple cards; batch card deferred.

## Deployment

Target domain:

- `https://crabfleet.openclaw.ai`

Current DNS expectation:

- Domain must be in Cloudflare or CNAME/A routed through Cloudflare before custom domain deploy is complete.
- If domain remains at another DNS provider, deploy can still publish a workers.dev URL but not final production domain.

Cloudflare account:

- Use `services@openclaw.org`.
- Deployment should use a scoped Cloudflare API token, not a personal browser session.

Worker names:

- `crabfleet-web`
- `crabfleet-control`

Initial deployable artifact:

- Static/spec site can ship first.
- Product app replaces it when TanStack Start scaffold lands.

Required deploy checks:

- `npx wrangler whoami` shows expected Cloudflare account.
- `crabfleet.openclaw.ai` is routed to deployed Worker.
- `curl -I https://crabfleet.openclaw.ai/healthz` returns 200.
- `/docs/spec` renders this spec.

## Security

- All state-changing API calls require authenticated user and org allowlist.
- Repo operations require repo allowlist.
- Direct merge requires maintainer role and repo policy.
- Runtime tokens are scoped and short-lived.
- WebSocket attach checks authorization at connect and on takeover.
- Takeover creates audit event.
- R2 object keys are unguessable and never public by default.
- Admin changes are audit logged.
- Secrets are never echoed to browser clients.

## Observability

Dashboard metrics:

- Active Codex count
- Queue count
- Runs by state
- Average runtime
- Stall count
- Runtime selection split
- Merge success/failure
- R2 retention backlog

Per-run timeline:

- Card created
- Runtime selected
- Lease/container started
- Repo checkout complete
- Codex started
- First output/event
- PR opened/updated
- Validation started/finished
- Takeover/attach events
- Merge/handoff
- Completion/failure

## Cloudflare Components

`BoardDO`:

- Per org/repo board.
- Owns card ordering and live board fanout.
- Tracks active counts and lane changes.

`RunDO`:

- Per active run.
- Owns live WebSocket fanout.
- Proxies app-server or PTY stream.
- Tracks heartbeat, elapsed timer, stall state.
- Writes compact event index to D1 and full stream to R2.

`Dispatcher`:

- Queue consumer.
- Enforces caps.
- Chooses runtime.
- Allocates Cloudflare Container or Crabbox lease.
- Starts Codex.

`GitHubSync`:

- Webhook receiver.
- Issue/PR search cache.
- Status/check refresh.

`MergeController`:

- Direct merge guardrails.
- ClawSweeper handoff.
- Merge audit log.

`RetentionJob`:

- Deletes expired R2 logs/artifacts.
- Compacts D1 summaries.

## MVP

1. Auth and admin allowlists.
2. Board with cards and lanes.
3. Freeform prompt card.
4. GitHub issue/PR picker.
5. Fake runner live logs.
6. Cloudflare Container runner.
7. Codex CLI PTY in Ghostty WASM.
8. R2 log persistence and replay.
9. Crabbox runner option.
10. Direct PR creation.
11. Direct merge with guardrails.
12. ClawSweeper handoff for review/automerge.

## Open Decisions

- Exact GitHub App permission set.
- Direct merge default per repo.
- Whether `CRABBOX.md` ships in MVP or phase 2.
- Whether app-server PTY is enough for Ghostty or a small sidecar PTY bridge is needed.
- Cloudflare Container image shape and Codex auth injection path.
- R2 lifecycle implementation details for 30-day retention.
