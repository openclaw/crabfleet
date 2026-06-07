---
name: crabfleet-supervisor
description: "Crabfleet session tree, spawning, summaries, and transcripts."
---

# Crabfleet Supervisor

Use when Codex needs to inspect, spawn, or supervise Crabfleet Codex sessions.

## Commands

- List visible owner/session tree: `crabfleet list`
- Machine-readable state: `crabfleet list --json`
- Spawn child session: `crabfleet new --repo openclaw/crabfleet --purpose "short mission" "initial prompt"`
- Send text to a session PTY: `crabfleet message <session-id> "next instruction"`
- Read transcript: `crabfleet transcript <session-id>`
- Show summary: `crabfleet summary <session-id>`
- Update summary: `crabfleet summary <session-id> "current status"`
- Update purpose: `crabfleet summary <session-id> --purpose "short mission"`

## Agent Auth

Inside a Crabfleet sandbox, prefer the local `crabfleet` CLI. It uses:

- `CRABFLEET_API_URL`
- `CRABFLEET_SESSION_ID`
- `CRABFLEET_PARENT_SESSION_ID`
- `CRABFLEET_ROOT_SESSION_ID`
- `CRABFLEET_AGENT_TOKEN`

The agent token is scoped to the current session and same-owner supervision.
Do not print it. Do not paste it into public GitHub/Slack output.

## Notes

- `list` groups sessions by owner and indents child sessions under parents.
- `new` automatically uses the current session as parent when
  `CRABFLEET_SESSION_ID` is set.
- `message` appends Enter by default; use `--no-enter` for partial input.
- Transcripts are Markdown from R2 when archived, otherwise a D1 event-log
  fallback.
- Summaries are for human/agent routing; keep them short and current.
