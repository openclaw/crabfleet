---
title: Quickstart
layout: default
permalink: /quickstart/
description: "Bootstrap Crabfleet, configure access, create a crabbox, and inspect a run attempt."
---

# Quickstart

This gets you from login to a real D1-backed crabbox, card, and run attempt.

## Prerequisites

- OpenClaw GitHub org membership.
- GitHub OAuth configured for browser access, or an SSH key to link through `crabd.sh`.
- Access to `https://crabfleet.openclaw.ai/app/`.

## 1. Log In

Open `https://crabfleet.openclaw.ai/app/`.

- Use GitHub OAuth if configured.
- Use `ssh link@crabd.sh` when you want terminal-first onboarding.
- Use the bootstrap token only for owner break-glass setup/recovery.

Bootstrap sessions last 1 hour. GitHub sessions last 15 minutes.

## 2. Add Access

Open Admin.

Add users or teams:

```text
@steipete
@openclaw/maintainer
```

Roles:

- `owner`: full admin.
- `maintainer`: create/start/control cards.
- `viewer`: read-only board and attach/watch.

## 3. Enable Repos

Add repos in `owner/repo` format. `openclaw/crabfleet` is sorted first and is the default repo in the card form.

Enabled repos drive:

- Card creation.
- Issue/PR preview search.
- `CRABBOX.md` workflow evaluation.
- Run allowlist checks.

## 4. Optional: Evaluate CRABBOX.md

In Admin → Workflows, enter a repo and refresh `CRABBOX.md`.

Supported shape:

```yaml
---
runtime:
  default: auto
merge:
  default_policy: open_pr
---
```

Invalid configs are visible and ignored. `stall_ms`, `cap`, `prompt_prefix`, and the Markdown body are parsed/stored for future policy work, but only runtime and merge defaults are effective today.

For private repos, the Worker needs deployment `GITHUB_TOKEN` access to fetch `CRABBOX.md`; it does not use the logged-in user's OAuth token for this refresh.

## 5. Create a Crabbox

Click New crabbox or use the CLI:

```bash
crabfleet new --repo openclaw/crabfleet "fix the failing check"
```

The CLI omits `runtime` unless `--runtime` is passed, so the deployment chooses via `CRABFLEET_DEFAULT_RUNTIME` (`container` when unset). Set a deployment to `crabbox` when its configured adapter provides terminal and WebVNC capabilities.

End a session with `crabfleet delete <session-id>`. Versioned lifecycle adapters confirm runtime release; legacy create-only and ClawFleet sessions stop only in Crabfleet and may require separate provider cleanup. Crabfleet retains the final status and logs until you clean up the dead session record.

## 6. Create a Card

Click New card.

Required:

- Repo
- Prompt

Optional:

- Title
- Runtime
- Merge policy

Blank title is generated from the prompt. Blank merge policy uses repo default, then `open_pr`.

## 7. Create from Issue/PR Number

Type `#76552` in board search. Crabfleet previews matches across enabled repos when `GITHUB_TOKEN` is configured; without it, preview falls back to the preferred repo or first enabled repo. Choose a match to create a card with the GitHub URL, title, body, repo, runtime `auto`, and repo-default policy.

## 8. Start and Attach

Click Start on a Todo card.

The Worker will:

- Check capacity, default cap `20`.
- Verify repo allowlist.
- Evaluate cached repo workflow defaults.
- Select `container` or `crabbox`.
- Store a run attempt with selection reason and capabilities.
- Move the card to Running and append events.

Click Attach to open the Ghostty WASM session grid. The grid immediately shows D1 event replay and switches to live PTY output through the terminal hub when the session has a sandbox or bridge.

## Troubleshooting

### Repo blocked by allowlist

Add the repo in Admin → Repos.

### GitHub user not allowlisted

Add a direct `@login` entry or the exact team slug, for example `@openclaw/maintainer`.

### Capacity blocked

Increase cap in Admin → Policy or move active runs out of Running.

### Take over hidden

Takeover appears only for active runs whose runtime capabilities include takeover. Container runs do not advertise takeover.
