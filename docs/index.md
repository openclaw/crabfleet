---
title: Overview
layout: default
permalink: /
description: "Crabfleet is a Cloudflare Worker control plane for OpenClaw Codex crabboxes, cards, and run attempts."
---

## Try it

Link your SSH key once, then use Crabfleet from the terminal, app, or Go CLI.

```bash
# Link your current SSH key to GitHub-backed Crabfleet access.
ssh link@crabd.sh

# Inspect your identity and active Codex sessions.
ssh crabd.sh whoami
ssh crabd.sh list

# Create or attach to a repo-ready Crabbox.
ssh crabd.sh new --repo openclaw/crabfleet "fix the failing check"
ssh crabd.sh attach <session-id>

# Or use the Go CLI.
crabfleet new --repo openclaw/crabfleet "fix the failing check"
crabfleet delete <session-id>
crabfleet vnc <session-id>
```

The web app at [crabfleet.openclaw.ai/app](https://crabfleet.openclaw.ai/app/) exposes the same control plane: GitHub OAuth, repo-gated cards, runtime policy, live session tiles, WebVNC links, and admin allowlists.

## What Crabfleet Does

- **SSH-first onboarding.** Connect through `ssh link@crabd.sh`, complete GitHub sign-in, then use linked-key auth.
- **Crabbox control.** Create, attach, share, open WebVNC, delete provider-backed runtime workspaces, stop legacy sessions locally, and clean up retained Codex session history.
- **Fleet visibility.** The app groups all org Codex instances by person so OpenClaw can supervise live work.
- **Repo-gated cards.** Prompt cards and GitHub issue/PR previews stay scoped to enabled OpenClaw repos.
- **Runtime policy.** Crabfleet records runtime selection, capabilities, heartbeat, stall state, and operator intent.
- **Admin guardrails.** User/team allowlists, repo allowlists, roles, caps, and `CRABBOX.md` workflow evaluation live in the dashboard.
- **Generated docs.** The spec, API pages, and architecture notes are built into a searchable documentation shell.

## What Works Today

- GitHub OAuth plus bootstrap login.
- Deployment-neutral trusted reverse-proxy identity with existing allowlist roles.
- User/team allowlists and repo allowlists.
- Empty-by-default board backed by D1.
- Cards from prompts or `#number` issue/PR previews across enabled repos.
- Optional title generation from prompt.
- Durable run attempts with heartbeat, stall handling, operator, runtime reason, and capabilities.
- Built-in Cloudflare Sandbox Codex workspaces and versioned provider-backed Crabbox workspaces.
- Deployment-configured Crabbox runtime profiles with generic labels, server-side allowlisting, and capability previews.
- Ghostty WASM fullscreen session grid with live multiplex PTY attach, D1 replay, sharing, delegated control, multiplayer attribution, and clipboard upload for Sandbox sessions.
- Provider-backed workspace inspection, reconciliation, transient desktop connection minting, and confirmed deletion.
- Session supervision trees, summaries, transcripts, framed PTY messaging, checkpoints, and restore.
- Durable GitHub Actions sessions with outbound runner PTYs, work-state heartbeats, and browser steering.
- R2 event, transcript, and summary archives with retryable finalization and cleanup.
- Card diff metadata and compact patch view.
- Owner workflow evaluation for repo `CRABBOX.md`.
- Fleet registry with runtime, readiness, archive, VNC, and redacted credential-policy state.
- Worker-served docs at `/docs/` and generated docs at `docs.crabfleet.ai`.

## Current Boundaries

- Cards store scheduling intent, run evidence, and policy; they do not launch an autonomous executor.
- Merge policy is stored and displayed, but Crabfleet does not merge PRs or hand work to ClawSweeper.
- Interactive-session archives contain normalized events, Markdown transcripts, and summaries. Raw terminal byte replay and arbitrary artifact retention are not implemented.
- Board and Fleet state refresh through REST polling. WebSockets are used for terminal traffic and the GitHub Actions runner relay, not general board fanout.
- OpenClaw service endpoints can create Crabboxes and register Actions work, but higher-level Discord meeting orchestration remains outside Crabfleet.

## Pick Your Path

- **Trying it.** [Quickstart](/quickstart/) covers login, access, repo setup, cards, and attach.
- **Understanding the system.** [Architecture](/architecture/) explains the Worker, D1/Kysely, runtime descriptors, and workflow config.
- **Operating cards.** [Cards](/cards/) and [Runs](/runs/) cover task state, attempts, terminal attach, and replay.
- **Steerable Actions.** [GitHub Actions Sessions](/github-actions-sessions/) covers durable work keys, outbound runner PTYs, browser steering, work-state heartbeats, resumption, completion, and cancellation.
- **Managing access.** [Admin](/admin/) covers users, teams, repos, roles, caps, and policy defaults.
- **Building against it.** [API Reference](/api/) lists REST and internal SSH gateway endpoints.
- **Reading the contract.** [Complete Spec](/spec/) separates shipped behavior from explicit product boundaries.

## Core Concepts

### Cards

Cards represent task intent and policy:

- Prompt, issue, or PR source.
- Enabled repo target.
- Runtime preference: `auto`, `container`, `crabbox`.
- Merge policy: repo default, `open_pr`, `merge_when_green`, `fix_until_green_and_merge`.
- Lane: Todo, Running, Human Review, Done.
- Logs, changes, and active run attempt.

### Runs

When a card enters Running, Crabfleet creates a `run_attempts` row, selects a runtime descriptor, records the selection reason and capabilities, and starts heartbeat/stall tracking. This is durable scheduling/control evidence, not an autonomous process launch. Live work is represented by interactive sessions, including built-in Sandbox, versioned Crabbox, legacy adapter, ClawFleet, and GitHub Actions-backed sessions.

### Repo Workflows

Owners can evaluate `CRABBOX.md` for enabled repos. Valid workflow config sets runtime and merge defaults for new cards. Other parsed fields remain informational.

### Roles

- **Owner**: manage allowlists, repos, caps, retention, workflow evaluations.
- **Maintainer**: create cards, start runs, attach, watch, take over capable active runs.
- **Viewer**: view Board/Fleet state and logs, use public share links, and request delegated terminal control. Session ownership grants management access independently of role.

## Tech Stack

- TypeScript + pnpm
- Cloudflare Workers
- Cloudflare D1
- Kysely
- GitHub OAuth/API
- Ghostty WebAssembly
- `tsgo`, `oxlint`, `oxfmt`

## Status

Deployed and actively used by OpenClaw. See [Current Boundaries](#current-boundaries) for the remaining deliberately unimplemented product behaviors.

## Recurring cards

Crabfleet supports recurring cards for operational jobs that should run on a cadence without a human repeatedly pressing Start. A card can include a schedule object such as:

    { "kind": "interval", "everyMs": 86400000 }

The Worker scheduled handler and the owner-only `/api/admin/scheduler/tick` endpoint both scan due cards, call the existing run scheduler, create a run attempt, and advance `nextRunAt`. This keeps recurrence at the card/run layer instead of using long-running loops.
