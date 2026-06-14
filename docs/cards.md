---
title: Cards
layout: default
permalink: /cards/
description: "Card lifecycle, policies, and source types in Crabfleet."
---

# Cards

Cards are the durable task-intent and scheduling unit in Crabfleet. Interactive sessions are the live execution unit. Cards keep prompt, repo, source, policy, lane, event log, optional diff metadata, and optional active run state.

## Card Shape

```typescript
{
  id: "CY-101",
  title: "Add health check endpoint",
  prompt: "Add a new /healthz endpoint...",
  repo: "openclaw/crabbox",
  source: "Prompt",
  runtime: "auto",
  policy: "open_pr",
  lane: "Running",
  owner: "steipete",
  startedAt: 1736700000000,
  createdAt: 1736699900000,
  changes: {
    files: [
      { path: "src/index.ts", status: "modified", additions: 18, deletions: 5 }
    ],
    patch: "diff --git ...",
    totals: { files: 1, additions: 18, deletions: 5 }
  },
  run: {
    id: "CY-101-R1",
    runtime: "container",
    status: "running",
    selectionReason: "default container runtime",
    capabilities: { terminal: true, takeover: false, vnc: false, desktop: false, logs: true, artifacts: true }
  },
  logs: ["14:32:01 card created", "14:32:02 runtime=container ..."]
}
```

Cards are empty by default in production. The board gets data when users create cards from a prompt or a GitHub issue/PR preview.

## Creating Cards

Prompt is the only mandatory human text. Title is optional and derived from the first non-empty prompt line when blank.

Required:

- `prompt`
- `repo`

Optional:

- `title`
- `source`: `Prompt`, `Issue`, or `PR`
- `runtime`: `auto`, `container`, or `crabbox`
- `policy`: repo default, `open_pr`, `merge_when_green`, or `fix_until_green_and_merge`

The repo must be enabled in Admin. `openclaw/crabfleet` is sorted first as the default Crabfleet repo.

## GitHub Issue/PR Preview

Type an issue or PR number such as `#76552` in board search. With `GITHUB_TOKEN`, Crabfleet looks across enabled repos and previews every matching issue/PR. Without it, preview falls back to `openclaw/crabfleet` or the first enabled repo. If the same number exists in multiple repos, each match appears separately when token-backed lookup is available.

Creating a card from a match uses:

- title: `owner/repo#number: title`
- prompt: source URL, title, and body
- repo: matched repo
- runtime: `auto`
- policy: repo default

## Lanes

Current lanes:

- Todo
- Running
- Human Review
- Done

Manual Advance cycles through the lanes. Starting a Todo card claims capacity and creates a run attempt. Moving a Running card to Human Review or Done closes the active run as `review` or `completed`.

A run attempt records scheduling evidence and heartbeat state. It does not itself start a Codex process. Use a Fleet interactive session for live execution and terminal access.

## Actions

- Start: claim a card or pulse heartbeat if already active.
- Advance: move to the next lane.
- Attach: open the Ghostty WASM session grid/details.
- Watch: record a watch attachment event.
- Take over: maintainer-only, active-run-only, and runtime-capability-gated.
- Move/Mark stalled: preserve state for human review.

## Runtime Policy

Use `auto` unless you need a hard override.

- `container`: default card descriptor and lightweight runtime intent.
- `crabbox`: desktop/VNC/manual/heavy adapter surface.
- `auto`: card prompt cues, repo workflow defaults, then Container fallback.

Hard prompt cues that force Crabbox under `auto`: `vnc`, `manual`, `takeover`, `gpu`, `perf`, `performance`.

## Merge Policy

- `open_pr`: create or hand off a PR for human review.
- `merge_when_green`: records intent to merge once checks are green.
- `fix_until_green_and_merge`: records intent for a repair-and-merge loop.

The Worker stores and displays merge policy. It does not currently inspect PR checks, merge, or hand work to ClawSweeper.

## Repo Defaults

Owners can evaluate `CRABBOX.md` from Admin. Valid workflow config can supply runtime and merge defaults for new cards:

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

Only runtime and merge defaults are enforced. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed and stored for visibility but do not change scheduling. Invalid workflow values are visible in Admin and ignored when creating cards or selecting runtimes.
