# Crabfleet

![Crabfleet banner](docs/assets/readme-banner.jpg)

**Mission control for Agent runs.**

Crabfleet gives OpenClaw maintainers a fleet dashboard where every Codex crabbox is visible by operator, repo, terminal, and WebVNC state. The OpenClaw app/API canonical URL is `https://crabfleet.openclaw.ai`; `https://crabfleet.ai` is the public product/docs entrypoint.

## What It Does

- **Fleet-first workflow.** Create repo-ready Crabboxes from the app, SSH, or the Go CLI and see org Codex instances grouped by person.
- **Board-based workflow.** Create cards from prompts, GitHub issues, or PRs. Track them through Todo, Running, Human Review, and Done lanes.
- **Recurring cards.** Give API-created cards a bounded interval schedule; due occurrences use the normal run-attempt path and coalesce while a run or capacity limit blocks dispatch.
- **Issue/PR lookup.** Type `#123` in search to preview matching GitHub issues or PRs across enabled OpenClaw repos and create a card from the match.
- **Codex run control.** Start durable run attempts, track heartbeats, watch the Ghostty WASM session grid, and take over only when the selected runtime advertises that capability.
- **Interactive Crabboxes.** Start a standalone Codex CLI workspace for manual cloud work and attach it in the same fullscreen Ghostty grid or WebVNC.
- **Share This Mac.** Stream up to four Mac displays privately over SPKI-pinned QUIC-first, TCP-fallback Tailscale endpoints and owner-authenticated per-display browser relays, with four concurrent viewers per display, low-latency negotiated client-side cursors, feature-probed browser and native full-chroma HEVC plus H.264 and Tight/JPEG fallback, browser and native primary-display AAC-LC audio, multicast clipboard, dirty-rect idle suppression, per-viewer Auto/Sharp/Smooth quality controls, throughput-aware rate control, resize, transport and quality diagnostics, and live view-only and audio controls.
- **Steerable GitHub Actions.** Register an Actions job as a durable `github_actions` session, stream its PTY outbound into Ghostty, steer it from the browser, and report work state and Codex thread/turn IDs.
- **Worker-owned sandbox credentials.** Built-in Cloudflare Sandbox sessions get placeholder env credentials; Worker-controlled outbound routing injects model and GitHub credentials only for approved upstream requests.
- **Diff previews.** Card tiles show changed files and totals; the run drawer shows a compact Codiff-style patch view.
- **Multi-runtime policy.** Auto-select between the Container and Crabbox adapter surfaces based on card overrides, repo workflow defaults, and task requirements.
- **Allowlist controls.** Restrict access to OpenClaw org members and specific repos through admin-managed allowlists.
- **Private tenant isolation.** New deployments show each user only their own cards and sessions unless the owner creates a named grant, a delegated-control lease, or a public read-only link.
- **Session history.** D1-backed card/run events plus periodically refreshed R2 event, transcript, and summary snapshots with terminal finalization guarantees.
- **Repo workflow config.** Owners can evaluate `CRABBOX.md` per repo and use it for runtime and merge defaults.

## Architecture

- **Cloudflare Workers** for the app, API, auth, GitHub lookup, and docs routes.
- **D1 + Kysely** for typed persistence: users, sessions, allowlists, repos, cards, events, run attempts, interactive sessions, diffs, and repo workflow evaluations.
- **Ghostty WebAssembly** for the fullscreen attach grid and run log replay.
- **Cloudflare Sandbox containers** for standalone interactive Codex CLI workspaces with live PTY attach.
- **Runtime descriptors** for card scheduling evidence and capability display.
- **Versioned lifecycle adapter** for idempotent external workspace creation, bounded status reconciliation, provider-backed deletion, terminal attachment, and authenticated transient desktop connections.
- **Provision endpoint** at `/api/provision/interactive` for durable built-in Sandbox ownership and a bearer-authenticated standalone PTY route.
- **SessionControlDO relay** for one outbound GitHub Actions runner and multiple authenticated Ghostty viewers per action session.
- **DesktopRelayDO** for one ownership-token Mac publisher and one registration-owner browser RFB viewer per desktop, relaying a bounded opaque byte stream without storing secrets or frames.
- **R2 session archives** for periodically refreshed interactive-session event NDJSON, transcripts, and summaries, finalized at terminal completion.
- **GitHub API** for OAuth, org/team membership, and issue/PR previews across enabled repos.

Cards currently record scheduling intent, runtime selection, heartbeats, operator actions, and result metadata; they do not launch an autonomous executor. Merge policy is stored but not executed. Interactive sessions are the live execution plane, backed by the built-in Cloudflare Sandbox or a configured lifecycle adapter. Terminal transport uses the Worker multiplex hub; board and fleet state refresh through REST polling.

## Quick Start

### 1. Sign In

Use GitHub OAuth for normal browser access, or link an SSH key from the terminal:

```bash
ssh link@crabd.sh
```

`CRABBOX_BOOTSTRAP_TOKEN` is only a break-glass recovery path for owners.

### 2. Configure Access

Add users/teams to the allowlist and enable repos:

- Navigate to Admin panel
- Add GitHub users (`@login`) or teams (`@org/team`)
- Assign roles: owner, maintainer, or viewer
- Add allowed repos (`owner/repo`)

### 3. Create Cards

- **From prompt:** New card → enter prompt, select repo; title is optional
- **From issue:** Search GitHub issues → create card
- **From PR:** Search GitHub PRs → create card for review/fix

### 4. Watch Runs

- Running cards show D1 event logs and heartbeat state
- Click "Attach" to open the fullscreen Ghostty WASM session grid
- Click "Take over" only when the active run advertises takeover support
- Click "Watch" for read-only stream

### 5. Start Crabboxes

- Click "New crabbox" to request a standalone Codex CLI workspace
- Default runtime is Cloudflare Sandbox; choose Crabbox only when a VNC/desktop adapter is configured
- The OpenClaw deployment routes Container sessions to the built-in Cloudflare Sandbox and Crabbox sessions to the versioned lifecycle adapter
- Deployments without a usable backend retain the session as `pending_adapter` with a visible setup message
- Install or build the Go CLI, then run `crabfleet new --repo openclaw/crabfleet "fix the failing check"`
- Inside a Crabfleet sandbox, the CLI uses `CRABFLEET_SESSION_ID` and `CRABFLEET_AGENT_TOKEN` automatically so Codex can run `crabfleet list`, spawn child sessions with `crabfleet new --purpose ...`, send `crabfleet message <id> "..."`, read `crabfleet transcript <id>`, and update `crabfleet summary <id> "..."`

### 6. Attach GitHub Actions

Internal OpenClaw automation registers or resumes a logical action session with:

```http
POST /api/openclaw/action-sessions
Authorization: Bearer CRABBOX_OPENCLAW_TOKEN
Content-Type: application/json

{"workKey":"openclaw/crabfleet:pr:42","workKind":"pr_repair","repo":"openclaw/crabfleet","branch":"fix/pr-42","owner":"operator@example.test","sourceUrl":"https://github.com/openclaw/crabfleet/pull/42","runUrl":"https://github.com/openclaw/crabfleet/actions/runs/123","purpose":"repair PR 42","summary":"starting repair"}
```

The response contains `{session, agentToken, runnerPtyUrl, browserUrl}`. New registrations and resumes require `owner` to resolve to one active Crabfleet user; resumes must prove the same stable owner subject already recorded on the `workKey`. The stable subject owns browser visibility while the OpenClaw service retains lifecycle authority for its session. `runnerPtyUrl` includes the rotated session-scoped query credential and can be opened unchanged as the legacy raw duplex byte stream. New runners offer the framed protocol as a WebSocket subprotocol:

```js
const terminal = new WebSocket(runnerPtyUrl, "cfr1-framed-io-v2");
terminal.binaryType = "arraybuffer";
terminal.addEventListener("open", () => {
  const framed = terminal.protocol === "cfr1-framed-io-v2";
  // Use CFR1 only when framed is true; otherwise retain raw compatibility.
});
```

Existing runners retain raw input and output by opening the returned URL
unchanged. A new runner opts into correlated binary `CFR1` input, output, and
acknowledgement frames only when the relay selects the
`cfr1-framed-io-v2` WebSocket subprotocol in the upgrade response. Relays that
ignore the offer leave `WebSocket.protocol` empty, so new runners retain raw
compatibility. The relay fences negotiated runner input with its connection
generation. Framed runners acknowledge only after their PTY accepts the input.
The complete byte-safe encoder, decoder, and Node PTY runner are in
[`docs/github-actions-sessions.md`](docs/github-actions-sessions.md#runner-pty).

The runner reports heartbeat and durable progress with bearer `agentToken` to `POST /api/agent/interactive-sessions/:id/work-state`. Terminal states are `completed`, `blocked`, `failed`, and `canceled`; active work uses `registered` or `running` plus a specific `phase`.

The full registration, relay, resumption, steering, heartbeat, completion,
cancellation, authentication, archive, and troubleshooting contract is in
[`docs/github-actions-sessions.md`](docs/github-actions-sessions.md).

## Features

### Board Management

- Kanban-style lanes: Todo, Running, Human Review, Done
- Card filtering: all, mine, live
- Search cards by title, repo, or ID
- REST state refresh every 15 seconds, plus immediate refresh after mutations

### Card Policies

- **Runtime:** `auto`, `container`, `crabbox`
- **Merge policy:** repo default, `open_pr`, `merge_when_green`, `fix_until_green_and_merge`
- **Source types:** Prompt, Issue, PR

Repo defaults can come from a `CRABBOX.md` file:

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

`stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed/stored for future policy work, but only runtime and merge defaults are effective today.

### Admin Controls

- User and team allowlists with role-based access
- Repo allowlists
- Manual `CRABBOX.md` evaluation with status/error visibility
- Concurrent Running-card cap (default: 20)
- Stored retention selection (14, 30, 60 days); cleanup is explicit and state-driven
- Stored merge intent (guarded, maintainers, disabled); Crabfleet does not execute merges

### Auth

- GitHub OAuth for org members
- Bootstrap token for admin setup and recovery
- Short-lived D1-backed sessions; users reauthenticate after expiry
- Role-based access control (owner, maintainer, viewer)
- Private-by-default tenant isolation with time-limited named viewer/controller grants

## Deployment

### Prerequisites

- Cloudflare account
- `crabfleet.openclaw.ai` Worker Custom Domain in Cloudflare
- GitHub OAuth app (optional but recommended)
- Bootstrap token secret

### Deploy

Pushes to `main` run `.github/workflows/deploy-worker.yml`, which checks, tests, builds,
deploys the generic product router, applies remote D1 migrations, and deploys the app
Worker. Configure the repository secret `CLOUDFLARE_API_TOKEN` with permissions for
Workers deploys and D1 migrations; it does not need zone-route access.
The `crabfleet.openclaw.ai` app Custom Domain, `crabfleet.ai` product Custom
Domain, and `crabd.sh` DNS convergence are handled by
`scripts/ensure-cloudflare-domains.mjs`; set `CLOUDFLARE_DNS_API_TOKEN` for
manual deploys and when CI should manage those records. The DNS-scoped token is
required for first deployment and domain repair. Without it, CI skips domain
convergence but still fails unless the existing app and product endpoints are
healthy.
The product router source and deploy configuration live in `src/product-router.ts` and
`wrangler.product.jsonc`.

Manual deploy, including domain convergence, is still available:

```bash
CLOUDFLARE_API_TOKEN=... \
CLOUDFLARE_DNS_API_TOKEN=... \
pnpm run deploy
```

`pnpm deploy:product` deploys only the generic product Worker, then converges
the canonical product Custom Domain.

### Environment Variables

Configure these in Cloudflare Workers dashboard. `CRABBOX_*` names are the runtime/crabbox adapter contract; `CRABFLEET_*` names are for the public CLI and SSH gateway. The `SESSION_LOGS` R2 binding points at the `crabfleet-session-logs` bucket and stores crabbox event archives.

The Crabbox namespace cutover intentionally has no old-name compatibility. Existing browser sessions expire, linked SSH keys must be relinked with `ssh link@crabd.sh`, and in-flight interactive workspaces should be recreated.

- `CRABBOX_BOOTSTRAP_TOKEN` – Optional owner break-glass token for setup/recovery
- `CRABFLEET_TRUSTED_PROXY_ORIGIN` – Exact HTTPS backend origin on which trusted reverse-proxy assertions are authoritative
- `CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN` – Optional browser-visible HTTPS origin required on mutations and WebSocket upgrades; defaults to `CRABFLEET_TRUSTED_PROXY_ORIGIN`
- `CRABFLEET_TRUSTED_PROXY_SECRET` – Shared secret required on `X-Crabfleet-Proxy-Secret` for trusted reverse-proxy identity
- `CRABFLEET_TRUSTED_USER_HEADER` – Optional trusted identity header name, default `X-Authenticated-User`; the proxy must remove caller-supplied copies before injecting it
- `CRABFLEET_TRUSTED_PROXY_AUTO_ROLE` – Optional `viewer` or `maintainer` role for valid trusted-proxy identities without individual allowlist entries; other values fail closed. Use `maintainer` when every authenticated tenant should be able to create its own work.
- `CRABFLEET_TENANCY_MODE` – Optional `private` or `shared`; defaults to `private`. Private mode scopes cards and sessions to their stable owner subject plus explicit, unexpired session grants. Bootstrap token rotation preserves one stable bootstrap owner subject. `shared` restores the legacy team-wide visibility model and should be an intentional deployment choice.
- `GITHUB_CLIENT_ID` – GitHub OAuth app client ID (optional)
- `GITHUB_CLIENT_SECRET` – GitHub OAuth app secret (optional)
- `GITHUB_REDIRECT_URI` – Optional authoritative GitHub OAuth callback URL; when set it must be an absolute HTTPS URL with no credentials, query, or fragment and the exact `/auth/github/callback` path. Requests on another host restart login on this configured origin. When absent, the callback defaults to the HTTPS request origin (or literal-loopback HTTP for local development).
- `GITHUB_ORG` – GitHub org for membership check (default: `openclaw`)
- `GITHUB_TOKEN` – GitHub token for all enabled repo issue/PR previews and private repo `CRABBOX.md` refreshes (optional; public/default repo paths work without it)
- `CRABBOX_TOKEN_ENCRYPTION_KEY` – Encryption key for per-session GitHub OAuth tokens, one-time native device-token handoff, and native GitHub membership-revalidation credentials; defaults to `GITHUB_CLIENT_SECRET`, but must be set explicitly for native auth on trusted-proxy-only deployments
- `CRABBOX_INTERACTIVE_PROVISION_TOKEN` – Required bearer token for the built-in Sandbox provision, PTY, and stop endpoints
- `CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS` – Optional built-in standalone Sandbox lifetime, default `14400`, bounded to 300–86400 seconds
- `CRABBOX_RUNTIME_ADAPTER_URL` – Optional fixed base URL for the versioned workspace lifecycle adapter; mutually exclusive with `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` and becomes immutable registration identity for each created lifecycle. Nested base paths are preserved; raw query or fragment delimiters are rejected.
- `CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE` – Optional profile-routed alternative containing exactly one `{profile}` full path segment. Selected profile IDs must be lowercase DNS labels; the resolved URL is validated and persisted with the same immutable lifecycle fence as a fixed adapter URL.
- `CRABBOX_COORDINATOR_ORIGIN` – Optional public origin corresponding to the `CRABBOX_COORDINATOR` service binding. Matching fixed or profile-routed lifecycle and terminal requests use the binding; other adapter origins use normal outbound fetch.
- `CRABBOX_RUNTIME_ADAPTER_TOKEN` – Required bearer token for the versioned lifecycle adapter; sent only over HTTPS or literal loopback HTTP
- `CRABBOX_RUNTIME_ADAPTER_NAMESPACE` – Required stable tenant namespace when the versioned adapter is enabled; a DNS-safe label of at most 32 characters used in every workspace ID and idempotency key
- `CRABBOX_RUNTIME_ADAPTER_TTL_SECONDS` – Optional requested workspace TTL, default `14400`
- `CRABBOX_RUNTIME_ADAPTER_IDLE_SECONDS` – Optional requested workspace idle timeout, default `1800`
- `CRABBOX_OPENCLAW_TOKEN` – Internal bearer token for OpenClaw service crabbox and GitHub Actions session registration
- `CRABBOX_MULTICODEX_TOKEN` – Optional dedicated bearer token for MultiCodex room supervision
- `CRABBOX_EMBED_TICKET_SECRET` – Crabfleet-only signing key for short-lived, session-scoped terminal embed tickets
- `CRABFLEET_SSH_GATEWAY_TOKEN` – Shared bearer token for the Go SSH gateway internal API
- `CRABFLEET_LOCAL_SANDBOX_BACKUPS` – Optional Cloudflare Sandbox checkpoint mode override; defaults to R2 binding uploads, set `0` for SDK presigned R2 uploads
- `CRABFLEET_LABEL` – Optional tenant label shown in the app, default `Crabfleet`
- `CRABFLEET_CANONICAL_URL` – Optional tenant app/API origin, default `https://crabfleet.openclaw.ai`; requires HTTPS except literal loopback HTTP
- `CRABFLEET_PRODUCT_URL` – Optional tenant product/docs origin, default `https://crabfleet.ai`; requires HTTPS except literal loopback HTTP
- `CRABFLEET_SSH_HOST` – Optional SSH command host shown in the app, default `crabd.sh`
- `CRABFLEET_PREFERRED_REPO` – Optional first/default enabled repo, default `openclaw/crabfleet`
- `CRABFLEET_DEFAULT_RUNTIME` – Optional interactive runtime default, `container` or `crabbox`; defaults to `container` when enabled or otherwise the only enabled runtime
- `CRABFLEET_INTERACTIVE_RUNTIMES` – Optional comma-separated allowlist of manual interactive runtimes, `container`, `crabbox`, or both; defaults to `container,crabbox`
- `CRABFLEET_DEFAULT_PROFILE` – Optional opaque runtime-adapter profile, default `default`
- `CRABFLEET_RUNTIME_PROFILES_JSON` – Optional bounded JSON array of generic profile descriptors (`id`, `label`, optional `target`, optional boolean `capabilities`, and optional `codexSsh`) shown to authenticated users when creating Crabbox sessions; when configured, `CRABFLEET_DEFAULT_PROFILE` must name one entry. `codexSsh.aliasTemplate` may use `{providerResourceId}`, `{workspaceId}`, `{sessionId}`, and `{profile}`. Optional `codexSsh.setupCommand` is an argv-like JSON string array: its first item and static items are shell-safe tokens, while any later item may be one complete placeholder. Crabfleet shell-quotes every substituted argument.
- `CRABFLEET_DEV_LOGIN_ENABLED` – Explicit local-only development identity login gate; disabled unless exactly `true`, and still restricted to literal localhost requests
- `OPENAI_API_KEY` – Required for built-in Cloudflare Sandbox Codex CLI sessions; injected by the Worker outbound path for Cloudflare Sandbox requests

For example, a deployment can expose two generic desktop profiles without
teaching Crabfleet about either provider:

```dotenv
CRABFLEET_DEFAULT_RUNTIME="crabbox"
CRABFLEET_INTERACTIVE_RUNTIMES="crabbox"
CRABFLEET_DEFAULT_PROFILE="linux-desktop"
CRABFLEET_RUNTIME_PROFILES_JSON='[{"id":"linux-desktop","label":"Linux","target":"linux","capabilities":{"terminal":true,"desktop":true,"vnc":true},"codexSsh":{"aliasTemplate":"codex-{providerResourceId}","setupCommand":["fleet-connect","{providerResourceId}"]}},{"id":"macos-desktop","label":"macOS","target":"macos","capabilities":{"terminal":true,"desktop":true,"vnc":true}}]'
CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE="https://controller.example/v1/adapters/{profile}/proxy"
```

The route template can select one outbound lifecycle adapter per profile. Each
adapter remains responsible for its provider mapping and real capabilities. A
configured Codex SSH handoff appears only to a ready session's managers. The
browser copies the deployment-local setup command; it never executes it or
stores provider credentials. That helper must install a concrete OpenSSH alias
whose remote login shell can find an authenticated `codex` command.

### Verify Deployment

The app Worker includes a once-per-minute cron trigger for bounded runtime lifecycle and terminal-archive reconciliation. Keep the `triggers.crons` entry when deriving deployment configuration; direct session, PTY, and VNC access also performs CAS-guarded targeted refreshes.

```bash
curl -I https://crabfleet.openclaw.ai/healthz
# Should return: 200 OK

curl https://crabfleet.openclaw.ai/docs/spec
# Should return: HTML spec document
```

## Development

### Setup

```bash
# Install dependencies
pnpm install

# Build assets
pnpm build

# Run type checks
pnpm check

# Run linter
pnpm lint

# Format code
pnpm format
```

### Test Stack

- `tsc --noEmit` through `pnpm build`
- `oxlint` for linting
- `oxfmt --check` for formatting
- SQLite migration smoke checks for D1 schema compatibility
- Structured autoreview before non-trivial commits
- Browser/live smoke checks after deploy

### Local Development

```bash
# Start local dev server with D1
wrangler dev

# Apply migrations locally
wrangler d1 migrations apply DB --local
```

### SSH Gateway

The Worker exposes an internal SSH onboarding API guarded by `CRABFLEET_SSH_GATEWAY_TOKEN`.
Run the Go gateway next to a host that can accept raw SSH:

```bash
CRABFLEET_API_URL=https://crabfleet.openclaw.ai \
CRABFLEET_SSH_GATEWAY_TOKEN=... \
CRABFLEET_SSH_HOST_KEY=/var/lib/crabfleet/ssh_host_ed25519_key \
CRABFLEET_SSH_ADDR=:2222 \
go run ./cmd/crabbox-ssh-gateway
```

Unknown public keys get a short GitHub OAuth link through `ssh link@host`. Linked keys can
run `whoami`, `list`, `new`, `attach SESSION_ID`, and `delete SESSION_ID`; `new` creates an
interactive Codex session and attaches. Delete confirms runtime release for versioned lifecycle
adapters and cleans up built-in Sandbox sessions through their durable ownership records.

Production should expose the gateway at `crabd.sh` as a DNS-only `A` record.
Use `ssh link@crabd.sh` once to connect a GitHub-backed SSH key, then run
`ssh crabd.sh whoami` or `ssh crabd.sh list`.

### Go CLI

The `crabfleet` CLI is written in Go with Kong and delegates to SSH by default. API mode is available for service contexts with `CRABFLEET_SSH_GATEWAY_TOKEN` and `CRABFLEET_SSH_FINGERPRINT`.

```bash
brew tap openclaw/tap
brew install crabfleet

go run ./cmd/crabfleet login
go run ./cmd/crabfleet list
go run ./cmd/crabfleet new --repo openclaw/crabfleet "start on the release checklist"
go run ./cmd/crabfleet status <session-id>
go run ./cmd/crabfleet attach <session-id>
go run ./cmd/crabfleet delete <session-id>
go run ./cmd/crabfleet vnc --open <session-id>
go run ./cmd/crabfleet logs <session-id>
go run ./cmd/crabfleet transcript <session-id>
go run ./cmd/crabfleet message <session-id> "check CI"
go run ./cmd/crabfleet summary <session-id> "waiting on CI"
go run ./cmd/crabfleet checkpoints <session-id>
go run ./cmd/crabfleet checkpoint <session-id>
go run ./cmd/crabfleet restore <session-id> <checkpoint-id>
go run ./cmd/crabfleet doctor
```

### CLI Release

Tagged releases publish `crabfleet` with GoReleaser and dispatch the OpenClaw Homebrew tap updater:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The release workflow builds macOS, Linux, and Windows archives, then updates `openclaw/homebrew-tap` through `update-formula.yml`.

### OpenClaw / Discord Crabbox Hook

OpenClaw can create repo-ready crabboxes for Discord-triggered work through the internal service endpoint:

```bash
curl -fsS https://crabfleet.openclaw.ai/api/openclaw/crabboxes \
  -H "authorization: Bearer $CRABBOX_OPENCLAW_TOKEN" \
  -H "content-type: application/json" \
  -d '{"owner":"@steipete","repo":"openclaw/crabfleet","prompt":"prep the meeting follow-up"}'
```

The created crabbox appears in the fleet grid under the requested owner. `owner` must resolve to one active Crabfleet user by login, email, or stable subject. Provisioning follows normal interactive-session routing: built-in Sandbox for Container or the versioned adapter for Crabbox.

### Project Structure

```
crabfleet/
├── src/
│   ├── index.ts          # Worker entry point, API routes, auth handlers
│   ├── app.html          # Single-page app shell and styles
│   ├── app/              # Preact app modules
│   ├── generated.ts      # Build-time generated assets
├── migrations/           # D1 database migrations
├── scripts/              # Build scripts
│   └── generate-assets.mjs
├── cmd/                   # Go CLI and SSH gateway entry points
├── internal/
│   ├── fleetapi/          # Shared Go control-plane client and domain contracts
│   ├── fleettext/         # Shared terminal-safe session rendering
│   └── terminalws/        # Shared multiplex terminal protocol client
├── vite.config.mjs       # Preact/Vite app bundle config
├── docs/                 # Documentation (GitHub Pages)
│   ├── CNAME             # docs.crabfleet.ai custom domain
│   └── spec.md           # Product spec
└── wrangler.jsonc       # Cloudflare Worker config
```

## Documentation

Full documentation available at [docs.crabfleet.ai](https://docs.crabfleet.ai):

- [Quickstart](https://docs.crabfleet.ai/quickstart) – Get started in 5 minutes
- [Architecture](https://docs.crabfleet.ai/architecture) – System design and data model
- [Cards](https://docs.crabfleet.ai/cards) – Card lifecycle and policies
- [Runs](https://docs.crabfleet.ai/runs) – Runtime selection and execution
- [GitHub Actions Sessions](https://docs.crabfleet.ai/github-actions-sessions) – Durable runner relay and steering
- [Native macOS Client](https://docs.crabfleet.ai/macos-native-client) – Prototype scope and security boundary
- [Admin](https://docs.crabfleet.ai/admin) – Access control and policies
- [API](https://docs.crabfleet.ai/api) – REST and WebSocket APIs
- [Spec](https://docs.crabfleet.ai/spec) – Complete product specification

## Security

- All state-changing operations require authentication
- Repo operations require allowlist membership
- Cards and sessions are tenant-private by default; global roles do not bypass another tenant's session boundary
- Named session grants are owner-managed, time-limited, and independently scoped to read-only or terminal-control access
- Merge policy is stored as intent; Crabfleet does not currently perform merges
- Runtime tokens are scoped and short-lived
- Secrets never logged or stored in D1/R2
- Audit events cover admin changes and interactive-session lifecycle/control mutations

## Status

Active development. See [CHANGELOG.md](CHANGELOG.md) for recent updates.

Current phase: deployed OpenClaw control plane with auth, Fleet and Board views, admin controls, durable card attempts, repo workflow evaluation, live interactive sessions, session supervision, GitHub Actions relays, provider-backed Crabbox lifecycle management, R2 archives, and authenticated terminal/desktop access.

Current product boundary: Cards do not yet launch autonomous work or execute merge policy. Those fields remain explicit control-plane intent rather than simulated automation.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Not Affiliated

Crabfleet is an OpenClaw project, not affiliated with Cloudflare, GitHub, or Anthropic.

## Contributing

This is currently an internal OpenClaw tool. External contributions are not accepted at this time.

## Support

For OpenClaw org members: use #crabfleet in Discord or open an issue in the private repo.
