# Crabfleet

![Crabfleet banner](docs/assets/readme-banner.jpg)

**Mission control for Agent runs.**

Crabfleet gives OpenClaw maintainers a fleet dashboard where every Codex crabbox is visible by operator, repo, terminal, and WebVNC state. The OpenClaw app/API canonical URL is `https://crabfleet.openclaw.ai`; `https://crabfleet.ai` is the public product site.

## What It Does

- **Fleet-first workflow.** Create repo-ready Crabboxes from the app, SSH, or the Go CLI and see org Codex instances grouped by person.
- **Board-based workflow.** Create cards from prompts, GitHub issues, or PRs. Track them through Todo, Running, Human Review, and Done lanes.
- **Issue/PR lookup.** Type `#123` in search to preview matching GitHub issues or PRs across enabled OpenClaw repos and create a card from the match.
- **Codex run control.** Start durable run attempts, track heartbeats, watch the Ghostty WASM session grid, and take over only when the selected runtime advertises that capability.
- **Interactive Crabboxes.** Start a standalone Codex CLI workspace for manual cloud work and attach it in the same fullscreen Ghostty grid or WebVNC.
- **Worker-owned sandbox credentials.** Built-in Cloudflare Sandbox sessions get placeholder env credentials; Worker-controlled outbound routing injects model and GitHub credentials only for approved upstream requests.
- **Diff previews.** Card tiles show changed files and totals; the run drawer shows a compact Codiff-style patch view.
- **Multi-runtime policy.** Auto-select between the Container and Crabbox adapter surfaces based on card overrides, repo workflow defaults, and task requirements.
- **Allowlist controls.** Restrict access to OpenClaw org members and specific repos through admin-managed allowlists.
- **Session logs.** D1-backed card/run event history with a 30-day product retention setting.
- **Repo workflow config.** Owners can evaluate `CRABBOX.md` per repo and use it for runtime and merge defaults.

## Architecture

- **Cloudflare Workers** for the app, API, auth, GitHub lookup, and docs routes.
- **D1 + Kysely** for typed persistence: users, sessions, allowlists, repos, cards, events, run attempts, interactive sessions, diffs, and repo workflow evaluations.
- **Ghostty WebAssembly** for the fullscreen attach grid and run log replay.
- **Cloudflare Sandbox containers** for standalone interactive Codex CLI workspaces with live PTY attach.
- **Runtime adapter descriptors** for Container and Crabbox selection, capability display, interactive provision handoff, and guarded takeover.
- **Provision endpoint** at `/api/provision/interactive` that can use the built-in Sandbox backend or delegate to a generic runtime adapter or ClawFleet.
- **R2 session archives** for crabbox event NDJSON, transcripts, and summaries.
- **GitHub API** for OAuth, org/team membership, and issue/PR previews across enabled repos.

Autonomous card execution, Crabbox VNC transport, Durable Object fanout, and merge automation are adapter targets, not faked in the current Worker.
The OpenClaw fleet/orchestrator backend should run on the Hetzner `openclaw-clawsweeper` host alongside ClawSweeper; the Worker stays the app/API front door.

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
- Without `CRABBOX_INTERACTIVE_PROVISION_URL`, sessions are stored as `pending_adapter` and still visible in the grid
- Install or build the Go CLI, then run `crabfleet new --repo openclaw/crabfleet "fix the failing check"`
- Inside a Crabfleet sandbox, the CLI uses `CRABFLEET_SESSION_ID` and `CRABFLEET_AGENT_TOKEN` automatically so Codex can run `crabfleet list`, spawn child sessions with `crabfleet new --purpose ...`, send `crabfleet message <id> "..."`, read `crabfleet transcript <id>`, and update `crabfleet summary <id> "..."`

## Features

### Board Management

- Kanban-style lanes: Todo, Running, Human Review, Done
- Card filtering: all, mine, live
- Search cards by title, repo, or ID
- Real-time updates via WebSockets

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
- Concurrent run caps (default: 20)
- Log retention (14, 30, 60 days)
- Direct merge permissions (guarded, maintainers, disabled)

### Auth

- GitHub OAuth for org members
- Bootstrap token for admin setup and recovery
- Short-lived sessions with automatic refresh
- Role-based access control (owner, maintainer, viewer)

## Deployment

### Prerequisites

- Cloudflare account
- `crabfleet.openclaw.ai` route in Cloudflare; legacy OpenClaw app hosts redirect here
- GitHub OAuth app (optional but recommended)
- Bootstrap token secret

### Deploy

Pushes to `main` run `.github/workflows/deploy-worker.yml`, which checks, tests, builds,
deploys the generic product router, applies remote D1 migrations, and deploys the app
Worker. Configure the repository secret `CLOUDFLARE_API_TOKEN` with permissions for
Workers deploys and D1 migrations.
`crabfleet.ai` product routing, `crabfleet.openclaw.ai`, and `crabd.sh` DNS/route
convergence is handled by `scripts/ensure-cloudflare-domains.mjs`; set
`CLOUDFLARE_DNS_API_TOKEN` when CI should manage those records. Without that
DNS-scoped token, CI skips domain convergence. The app Worker still proxies the generic
product site for `crabfleet.ai` as a defensive fallback, never the authenticated app.
The product router source and deploy configuration live in `src/product-router.ts` and
`wrangler.product.jsonc`.

Manual deploy is still available:

```bash
# Build assets
pnpm build

# Deploy the generic product router
pnpm deploy:product

# Apply migrations
wrangler d1 migrations apply DB --remote

# Deploy to Cloudflare
wrangler deploy
```

### Environment Variables

Configure these in Cloudflare Workers dashboard. `CRABBOX_*` names are the runtime/crabbox adapter contract; `CRABFLEET_*` names are for the public CLI and SSH gateway. The `SESSION_LOGS` R2 binding points at the `crabfleet-session-logs` bucket and stores crabbox event archives.

The Crabbox namespace cutover intentionally has no old-name compatibility. Existing browser sessions expire, linked SSH keys must be relinked with `ssh link@crabd.sh`, and in-flight interactive workspaces should be recreated.

- `CRABBOX_BOOTSTRAP_TOKEN` – Optional owner break-glass token for setup/recovery
- `GITHUB_CLIENT_ID` – GitHub OAuth app client ID (optional)
- `GITHUB_CLIENT_SECRET` – GitHub OAuth app secret (optional)
- `GITHUB_REDIRECT_URI` – GitHub OAuth callback URL registered on the app (defaults to the request origin callback)
- `GITHUB_ORG` – GitHub org for membership check (default: `openclaw`)
- `GITHUB_TOKEN` – GitHub token for all enabled repo issue/PR previews and private repo `CRABBOX.md` refreshes (optional; public/default repo paths work without it)
- `CRABBOX_TOKEN_ENCRYPTION_KEY` – Optional encryption key for per-session GitHub OAuth tokens; defaults to `GITHUB_CLIENT_SECRET`
- `CRABBOX_INTERACTIVE_PROVISION_URL` – Optional adapter endpoint for standalone Codex CLI workspaces
- `CRABBOX_INTERACTIVE_PROVISION_TOKEN` – Optional bearer token sent to the interactive provision endpoint; required when backend URLs below are configured
- `CRABBOX_RUNTIME_PROVISION_URL` – Optional generic backend URL used by `/api/provision/interactive`
- `CRABBOX_RUNTIME_PROVISION_TOKEN` – Optional bearer token sent to the generic runtime backend
- `CRABBOX_CLOUDFLARE_RUNNER_URL` – Optional Crabbox Cloudflare container runner URL used by `/api/provision/interactive`
- `CRABBOX_CLOUDFLARE_RUNNER_TOKEN` – Optional bearer token sent to the Cloudflare runner
- `CRABBOX_CLOUDFLARE_RUNNER_INSTANCE_TYPE` – Optional runner instance type, default `standard-4`
- `CRABBOX_CLOUDFLARE_RUNNER_WORKDIR` – Optional base workdir for provisioned sandboxes, default `/workspace/crabbox`
- `CRABBOX_CLOUDFLARE_RUNNER_TTL_SECONDS` – Optional sandbox TTL, default `14400`
- `CRABBOX_CLOUDFLARE_RUNNER_IDLE_SECONDS` – Optional idle timeout, default `1800`
- `CRABBOX_PTY_BRIDGE_URL` – Optional WebSocket PTY bridge URL/template for live Ghostty attach; supports `{id}`, `{leaseId}`, `{repo}`, `{branch}`, and `{runtime}`
- `CRABBOX_PTY_BRIDGE_TOKEN` – Optional bearer token sent from Crabfleet to the PTY bridge
- `CRABBOX_CLAWFLEET_URL` – Optional ClawFleet dashboard/API URL used by `/api/provision/interactive` for `crabbox` sessions
- `CRABBOX_CLAWFLEET_TOKEN` – Optional bearer token sent to ClawFleet
- `CRABBOX_CLAWFLEET_PUBLIC_URL` – Optional public ClawFleet URL used when building attach/VNC links
- `CRABBOX_OPENCLAW_TOKEN` – Internal bearer token for OpenClaw/Discord service crabbox creation
- `CRABFLEET_SSH_GATEWAY_TOKEN` / `CRABBOX_SSH_GATEWAY_TOKEN` – Shared bearer token for the Go SSH gateway internal API
- `CRABFLEET_LOCAL_SANDBOX_BACKUPS` – Optional Cloudflare Sandbox checkpoint mode override; defaults to R2 binding uploads, set `0` for SDK presigned R2 uploads
- `OPENAI_API_KEY` – Required for built-in Cloudflare Sandbox Codex CLI sessions; injected by the Worker outbound path for Cloudflare Sandbox requests

### Verify Deployment

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

- `tsgo --noEmit` through `pnpm build`
- `oxlint` for linting
- `oxfmt --check` for formatting
- SQLite migration smoke checks for D1 schema compatibility
- `codex-review` before feature commits
- Browser/live smoke checks after deploy

### Local Development

```bash
# Start local dev server with D1
wrangler dev

# Apply migrations locally
wrangler d1 migrations apply DB --local
```

### SSH Gateway

The Worker exposes an internal SSH onboarding API guarded by `CRABFLEET_SSH_GATEWAY_TOKEN` or `CRABBOX_SSH_GATEWAY_TOKEN`.
Run the Go gateway next to a host that can accept raw SSH:

```bash
CRABFLEET_API_URL=https://crabfleet.openclaw.ai \
CRABFLEET_SSH_GATEWAY_TOKEN=... \
CRABFLEET_SSH_HOST_KEY=/var/lib/crabfleet/ssh_host_ed25519_key \
CRABFLEET_SSH_ADDR=:2222 \
go run ./cmd/crabbox-ssh-gateway
```

Unknown public keys get a short GitHub OAuth link through `ssh link@host`. Linked keys can
run `whoami`, `list`, `new`, and `attach SESSION_ID`; `new` creates an interactive Codex
session and attaches.

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
go run ./cmd/crabfleet attach <session-id>
go run ./cmd/crabfleet vnc --open <session-id>
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

The created crabbox appears in the fleet grid under the requested owner. Provisioning still flows through the configured Crabbox/ClawFleet adapter, so VNC and terminal URLs come from the runtime backend.

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
- [Admin](https://docs.crabfleet.ai/admin) – Access control and policies
- [API](https://docs.crabfleet.ai/api) – REST and WebSocket APIs
- [Spec](https://docs.crabfleet.ai/spec) – Complete product specification

## Security

- All state-changing operations require authentication
- Repo operations require allowlist membership
- Direct merge requires maintainer role and policy approval
- Runtime tokens are scoped and short-lived
- Secrets never logged or stored in D1/R2
- Audit events for all admin and merge operations

## Status

Active development. See [CHANGELOG.md](CHANGELOG.md) for recent updates.

Current phase: MVP deployed with auth, board UI, admin controls, card management, Kysely-backed D1 persistence, durable run attempts, repo workflow evaluation, card diffs, Ghostty WASM terminal grid, R2 session log archives, authenticated PTY WebSocket proxying, and first-party Cloudflare Sandbox Codex CLI sessions.

Next: bind autonomous card execution and merge automation to the same runtime layer.

## License

MIT License. See [LICENSE](LICENSE) for details.

## Not Affiliated

Crabfleet is an OpenClaw project, not affiliated with Cloudflare, GitHub, or Anthropic.

## Contributing

This is currently an internal OpenClaw tool. External contributions are not accepted at this time.

## Support

For OpenClaw org members: use #crabfleet in Discord or open an issue in the private repo.
