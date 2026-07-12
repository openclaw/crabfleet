---
title: GitHub Actions Sessions
layout: default
permalink: /github-actions-sessions/
description: "Durable, resumable, browser-steerable GitHub Actions sessions."
---

# GitHub Actions Sessions

Crabfleet can represent a GitHub Actions job as a durable interactive session.
The Action remains the execution host; Crabfleet supplies identity, status,
terminal relay, browser steering, event history, and terminal finalization.

This document defines the Crabfleet side of the integration. The ClawSweeper
workflow, repair policy, GitCrawl intake, mutation gates, and operator flow are
documented in
[`openclaw/clawsweeper/docs/steerable-repair-automation.md`](https://github.com/openclaw/clawsweeper/blob/main/docs/steerable-repair-automation.md).

## Why This Exists

A normal GitHub Actions job has useful logs but no durable interactive identity.
It is also difficult to answer:

- Which logical task does this rerun belong to?
- Is Codex waiting, running, validating, blocked, or complete?
- Which Codex thread and turn are active?
- Can an operator steer the active turn without moving execution to a laptop?
- Does a later planning or execution runner continue the same work?
- Why did the work stop?

GitHub Actions sessions add those capabilities without turning Crabfleet into
the workflow runner.

## Architecture

```mermaid
flowchart LR
  A[OpenClaw service] -->|register work key| B[Crabfleet Worker]
  B --> C[(D1 interactive session)]
  B --> D[SessionControlDO]
  E[GitHub Actions runner] -->|outbound WebSocket| D
  F[Browser Ghostty viewer] -->|terminal hub| D
  F -->|input| D
  D -->|CFR1 input frame| E
  E -->|CFR1 acknowledgement| D
  E -->|Codex turn/steer| G[Codex app-server]
  E -->|heartbeat and work state| B
  B --> H[(R2 event archives)]
```

Components:

- **D1 interactive session**: canonical metadata, work state, phase, heartbeat,
  thread and turn IDs, event rows, and archive pointers.
- **SessionControlDO**: one current outbound runner and multiple authenticated
  browser viewers.
- **Terminal hub**: existing browser multiplex transport used by the Ghostty
  session grid.
- **R2**: periodically refreshed event NDJSON, transcript, and summary snapshots
  when the `SESSION_LOGS` binding is configured, finalized at terminal completion.

## Session Identity

The caller supplies a stable `workKey`, for example:

```text
openclaw/openclaw:issue-openclaw-openclaw-123
openclaw/openclaw:automerge-openclaw-openclaw-456
openclaw/openclaw:gitcrawl-157024-autonomous-smoke
```

`workKey` is unique across interactive sessions. Registering the same key:

- returns the same logical `IS-<number>` session;
- updates repository, branch, purpose, summary, source URL, and run URL;
- rotates the agent token;
- resets work to `registered / waiting_for_runner`;
- clears stale stop, failure, terminal finalization, and credential-cleanup
  state;
- disconnects the previous runner relay;
- appends a resumed event.

The stable work key is what lets a disposable Action runner participate in a
longer logical task.

## Registration API

Internal OpenClaw services register or resume work with:

```http
POST /api/openclaw/action-sessions
Authorization: Bearer CRABBOX_OPENCLAW_TOKEN
Content-Type: application/json
```

Example:

```json
{
  "workKey": "openclaw/openclaw:issue-openclaw-openclaw-123",
  "workKind": "issue_to_pr",
  "repo": "openclaw/openclaw",
  "branch": "clawsweeper/issue-openclaw-openclaw-123",
  "owner": "operator@example.test",
  "sourceUrl": "https://github.com/openclaw/openclaw/issues/123",
  "runUrl": "https://github.com/openclaw/clawsweeper/actions/runs/123456",
  "purpose": "Convert issue to pull request",
  "summary": "GitHub Actions work for issue-openclaw-openclaw-123"
}
```

Required fields for both new registrations and resumes:

- `workKey`
- `workKind`
- `repo`
- `owner`, resolved to exactly one active Crabfleet user by login, email, or stable subject

When a request reuses an existing `workKey`, Crabfleet treats it as a resume only after the supplied `owner` resolves to the same stable owner subject already recorded on that work key. Ownerless resumes fail closed with `owner is required for GitHub Actions work` and do not rotate the agent token.

Optional fields:

- `branch`, default `main`
- `sourceUrl`
- `runUrl`
- `purpose`
- `summary`

The repository must be enabled in Crabfleet. Identifier fields use a bounded,
restricted grammar; source and run links must be HTTP(S).

Response:

```json
{
  "session": {
    "id": "IS-123",
    "runtime": "github_actions",
    "workState": "registered",
    "workPhase": "waiting_for_runner"
  },
  "agentToken": "rotated-session-token",
  "runnerPtyUrl": "wss://crabfleet.openclaw.ai/api/agent/interactive-sessions/IS-123/runner-pty?agentToken=...",
  "browserUrl": "https://crabfleet.openclaw.ai/app/sessions/IS-123"
}
```

The actual response also includes the decorated session object. The runner PTY
credential is stored only as a hash in D1 and is not returned through viewer
session APIs.

## Work Kinds

Crabfleet treats `workKind` as an operator-facing classifier:

| Work kind        | Fleet label    |
| ---------------- | -------------- |
| `issue_to_pr`    | Issue to PR    |
| `pr_repair`      | PR repair      |
| `repair_cluster` | Repair cluster |

The value does not grant permissions. The calling workflow remains responsible
for target authorization and mutation policy.

## Work-State API

The current Action runner posts updates to:

```http
POST /api/agent/interactive-sessions/:id/work-state
Authorization: Bearer <agentToken>
Content-Type: application/json
```

Example:

```json
{
  "state": "running",
  "phase": "codex",
  "summary": "Codex turn active",
  "codexThreadId": "thread-id",
  "codexTurnId": "turn-id"
}
```

Every accepted update refreshes `lastHeartbeatAt`.

Active states:

- `registered`
- `running`

Terminal states:

- `completed`
- `blocked`
- `failed`
- `canceled`

`phase` is intentionally open-ended so the workflow can expose useful steps
such as `waiting_for_runner`, `codex`, `validating`, `post_flight`, `requeued`,
or `done`.

`completionReason` should be present for terminal states. Example reasons from
ClawSweeper include:

- `plan_complete`
- `gates_passed`
- `action_failed`
- `workflow_canceled`

Crabfleet records the state transition as a session event and exposes the
latest state in Fleet, Sessions, API, CLI, and logs.

## Structured Action Events

The Action runner can append durable machine-readable events without changing
the work-state heartbeat:

```http
POST /api/agent/interactive-sessions/:id/events
Authorization: Bearer <agentToken>
Content-Type: application/json
```

```json
{
  "eventKey": "clawsweeper:run:123:pull:42:update",
  "type": "clawsweeper.action",
  "message": "updated pull request 42",
  "payload": {
    "version": 1,
    "action": "pull_request_updated",
    "number": 42,
    "headSha": "0123456789abcdef"
  }
}
```

The payload must be a JSON object with a positive integer `version`. Crabfleet
keeps all additional fields so ClawSweeper can extend action metadata without a
coordinated schema migration. Payloads are bounded to 64 KiB serialized, 16
levels, 1,024 aggregate members, and 16 KiB per UTF-8 string or object key.
Each session is also capped atomically at 2,048 structured events and 8 MiB of
aggregate UTF-8 event data, keeping API and archive reads bounded.

`eventKey` is unique within the session. An exact semantic replay succeeds and
returns the original event with `duplicate: true`; changed content under the
same key returns `409`. This lets retried workflow steps publish once without a
separate read-before-write race. The endpoint only appends the event ledger: it
does not update `workState`, `workPhase`, `lastHeartbeatAt`, or `lastEvent`.
Credential-shaped payload fields are recursively replaced with `[redacted]`,
and embedded credential text is scrubbed from payload strings and `message`
before D1/R2 persistence. Once the session is terminal, the endpoint accepts
only side-effect-free exact replays of already-persisted events for five minutes
and rejects new history. The endpoint rejects that credential after the retry
window so completed sessions do not retain indefinite event access.
An exact replay of a row written before credential redaction repairs the D1 row,
forces archive replacement, durably requeues terminal archive finalization, and
returns only the sanitized event.

## Runner PTY

The Action connects outbound to the returned `runnerPtyUrl`. Node's global
`WebSocket` can open the URL without custom headers.

The returned URL opens a legacy raw-input/raw-output socket. A runner opts into
collision-free framed I/O by adding the exact
`runnerProtocol=cfr1-framed-io-v1` query before opening the socket. The relay
records that mode before accepting the connection. Viewer input then arrives in
a binary `CFR1` frame carrying a correlation ID, and runner output uses a
distinct `CFR1` output frame. The runner returns a correlated acknowledgement
only after its PTY accepts the input write.

Complete Node runner integration:

```sh
npm install @lydell/node-pty
```

```js
import { spawn } from "@lydell/node-pty";

const runnerPtyUrl = process.env.CRABFLEET_RUNNER_PTY_URL;
if (!runnerPtyUrl) throw new Error("CRABFLEET_RUNNER_PTY_URL is required");

const magic = new Uint8Array([0x43, 0x46, 0x52, 0x31]); // CFR1
const inputIdDecoder = new TextDecoder();
const inputDecoder = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();
const framedRunnerPtyUrl = new URL(runnerPtyUrl);
framedRunnerPtyUrl.searchParams.set("runnerProtocol", "cfr1-framed-io-v1");
const terminal = new WebSocket(framedRunnerPtyUrl);
terminal.binaryType = "arraybuffer";

await new Promise((resolve, reject) => {
  terminal.addEventListener("open", resolve, { once: true });
  terminal.addEventListener("error", reject, { once: true });
});

const pty = spawn(process.env.SHELL || "/bin/bash", [], {
  cwd: process.cwd(),
  env: process.env,
});

pty.onData((output) => {
  terminal.send(encodeOutput(output));
});

terminal.addEventListener("message", (event) => {
  acceptInput(event.data);
});

function acceptInput(data) {
  const input = decodeInput(data);
  if (!input) return;
  try {
    // Reject frames that split or contain invalid UTF-8 instead of corrupting PTY input.
    pty.write(inputDecoder.decode(input.payload));
    terminal.send(encodeAck(input.inputId, true));
  } catch {
    terminal.send(encodeAck(input.inputId, false));
  }
}

function decodeInput(data) {
  if (!(data instanceof ArrayBuffer)) return null;
  const frame = new Uint8Array(data);
  if (frame.byteLength < 7 || !magic.every((value, index) => frame[index] === value)) {
    return null;
  }
  if (frame[4] !== 0x01) return null;
  const inputIdBytes = frame[5];
  if (!inputIdBytes || inputIdBytes > 80 || 6 + inputIdBytes > frame.byteLength) {
    return null;
  }
  const inputId = inputIdDecoder.decode(frame.subarray(6, 6 + inputIdBytes));
  if (!/^[A-Za-z0-9_-]+$/.test(inputId)) return null;
  return {
    inputId,
    payload: frame.slice(6 + inputIdBytes),
  };
}

function encodeAck(inputId, accepted) {
  const inputIdBytes = encoder.encode(inputId);
  const frame = new Uint8Array(7 + inputIdBytes.byteLength);
  frame.set(magic);
  frame[4] = 0x02;
  frame[5] = inputIdBytes.byteLength;
  frame.set(inputIdBytes, 6);
  frame[6 + inputIdBytes.byteLength] = accepted ? 1 : 0;
  return frame;
}

function encodeOutput(output) {
  const payload = encoder.encode(output);
  const frame = new Uint8Array(6 + payload.byteLength);
  frame.set(magic);
  frame[4] = 0x04;
  frame[5] = 0;
  frame.set(payload, 6);
  return frame;
}

terminal.addEventListener("close", () => {
  pty.kill();
});

terminal.addEventListener("error", () => {
  pty.kill();
});
```

Set `CRABFLEET_RUNNER_PTY_URL` to the `runnerPtyUrl` returned by registration.
For a PTY API with an asynchronous write callback or promise, await that
acceptance signal before sending `encodeAck(..., true)`. Do not acknowledge when
the WebSocket merely queues the input frame. This Node adapter also requires each
input frame to contain complete, valid UTF-8; invalid or split sequences receive
a negative acknowledgement and must be resent on valid boundaries.

The protocol query is consumed during connection setup and is not forwarded as
terminal data. There is no capability message or mode transition after the
socket opens. Each `CFR1` frame occupies one binary WebSocket message. Payloads
are opaque bytes; adapters targeting string-only PTY APIs must either preserve
decoder state across acknowledgements or reject frames that end inside a text
encoding sequence, as the Node example does:

| Offset | Size     | Value                                                                          |
| ------ | -------- | ------------------------------------------------------------------------------ |
| 0      | 4        | ASCII `CFR1`                                                                   |
| 4      | 1        | `0x01` input, `0x02` acknowledgement, `0x03` lifecycle event, or `0x04` output |
| 5      | 1        | input ID byte length                                                           |
| 6      | variable | input ID followed by the type-specific payload                                 |

Input payloads are raw terminal bytes. An acknowledgement payload starts with
`1` for accepted or `0` for rejected and may include UTF-8 error text after the
status byte. Lifecycle events use an empty input ID and event code `0x01` for
runner connected, `0x02` for runner disconnected, or `0x03` for runner waiting.
Output uses an empty input ID followed by raw terminal bytes.
The full wire contract is also specified in
[API](/api/#get-api-agent-interactive-sessions-id-runner-pty).

Properties:

- Authentication is the session-scoped `agentToken` query value.
- Only one runner is current.
- A new runner connection replaces the previous runner.
- Multiple browser viewers may remain connected.
- Legacy runners open the returned URL unchanged, receive raw viewer input, and
  send raw output.
- Framed runners add the exact protocol query before connecting, receive framed
  input immediately, and wrap every output payload in a `0x04` frame.
- Negotiated input produces `input-accepted` only after the correlated runner
  acknowledgement. Legacy input reports acceptance after relay delivery.
- Runner lifecycle events are typed binary frames even while no runner is
  connected.
- The relay frames legacy output internally, so raw bytes beginning with
  `CFR1` cannot collide with acknowledgements or lifecycle events.

The relay does not interpret Codex JSON-RPC. The runner-side integration decides
how accepted terminal input maps to model steering.

## Browser Attach

Authorized signed-in session owners, maintainers/owners, or delegated controllers attach through the normal Crabfleet terminal hub. A
`github_actions` session advertises:

```json
{
  "terminal": true,
  "takeover": true,
  "vnc": false,
  "desktop": false,
  "logs": true,
  "artifacts": false
}
```

The Fleet page shows:

- session ID;
- repository and branch;
- GitHub Actions runtime;
- work kind;
- work state and phase;
- summary;
- event and log count;
- source and Actions links;
- terminal affordance.

The Sessions page and focused `/sessions/:id` route render the live Ghostty
terminal. When the runner is absent, the tile shows the waiting or replay state
instead of inventing a local shell.

## Steering Semantics

Crabfleet forwards negotiated terminal input inside correlated `CFR1` frames. In the
ClawSweeper integration, the runner:

1. Accepts the framed bytes into its input handler and acknowledges that input
   ID.
2. Collects printable input until Enter.
3. Echoes `[steer] <instruction>` to the terminal as raw output.
4. Calls Codex `turn/steer` with the active thread and expected turn ID.
5. Reports rejection or no-active-turn conditions in the terminal.

`Ctrl-C` maps to `turn/interrupt`.

This distinction matters: browser input does not become a general shell on the
GitHub-hosted runner. It is consumed by the registered runner process and
translated into the integration's explicit steering protocol.

## Resumption

Crabfleet resumption and Codex thread resumption are complementary.

Crabfleet preserves:

- logical `IS-<number>` session;
- work key;
- event history and archive identity;
- current source and Actions links;
- latest reported thread and turn IDs.

ClawSweeper preserves:

- the Codex app-server sessions directory;
- the thread state file;
- the durable repair job and result artifacts.

On a new Action attempt:

1. ClawSweeper registers the same work key.
2. Crabfleet rotates credentials and marks the session waiting.
3. The runner restores its cached Codex state.
4. Codex attempts `thread/resume`.
5. The runner connects the new outbound PTY.
6. Work-state updates replace stale phase and heartbeat data.

If Codex cannot resume the stored thread, the runner can start a new thread
without creating a new Crabfleet session.

## Heartbeats

The ClawSweeper runner posts active work state every 60 seconds while a Codex
turn is running. Crabfleet records:

- `lastHeartbeatAt`;
- state and phase;
- summary;
- Codex thread ID;
- Codex turn ID.

Crabfleet does not declare a GitHub Actions task successful merely because a
heartbeat stops. The workflow must post a terminal state and completion reason.
The GitHub Actions run conclusion remains an independent source of truth.

## Completion

A session is logically complete when the caller posts a terminal work state.
Crabfleet exposes the final state, phase, and reason and closes the runner-side
relay as the workflow exits.

For ClawSweeper:

- `completed / done / plan_complete` means planning and deterministic result
  review passed.
- `completed / done / gates_passed` means repair and all configured
  deterministic gates passed.
- `blocked / action_failed` means required workflow gates did not complete.
- A user-ended Crabfleet terminal session does not claim a terminal workflow
  state. The GitHub run remains authoritative and may continue.

Crabfleet completion is status evidence, not GitHub mutation authority. The
ClawSweeper result ledger and target repository state describe what was
actually changed.

## Ending the Crabfleet terminal session

GitHub Actions sessions use a dedicated terminal-session end lifecycle. This
does not call GitHub's workflow-cancellation API.

An authorized End action:

1. Atomically appends the terminal-session event and updates the session.
2. Sets `status = stopped`.
3. Clears Crabfleet's synthetic work state instead of claiming the workflow was
   canceled.
4. Sets `workPhase = session_ended`.
5. Records that the Crabfleet terminal ended without canceling the workflow.
6. Clears the agent token, attach URL, and control state.
7. Disconnects the current runner.
8. Archives and finalizes terminal logs.

The browser, CLI, and SSH surfaces warn that the GitHub Actions workflow run
may continue. Cancel the run in GitHub when provider-side cancellation is
required.

`github_actions` sessions are excluded from runtime-adapter workspace
reconciliation. They do not have a provider workspace lease for that
reconciler to release.

Registration after an earlier terminal state explicitly clears stale terminal
and cleanup markers before accepting the resumed runner.

## Authentication

### Service Authentication

`POST /api/openclaw/action-sessions` requires the configured
`CRABBOX_OPENCLAW_TOKEN`. This credential is for trusted OpenClaw services and
must not be exposed to Codex or browsers.

### Agent Authentication

Each registration generates a fresh random agent token. Crabfleet stores its
SHA-256 hash and accepts the plaintext token only through:

- bearer auth for work-state updates;
- the scoped query parameter for the runner WebSocket.

Re-registering the work key invalidates the old agent token.

### Viewer Authentication

Normal Fleet and terminal viewers use Crabfleet browser authentication and
allowlist roles. The browser never receives the service or agent token.

Read-only share links use a separate hashed share token and do not grant input.
Writable terminal input requires an authenticated authorized viewer.

## Data Model

Relevant interactive-session fields:

- `runtime = github_actions`
- `profile = github-actions`
- `work_key`
- `work_kind`
- `work_state`
- `work_phase`
- `source_url`
- `github_run_url`
- `codex_thread_id`
- `codex_turn_id`
- `last_heartbeat_at`
- `completion_reason`
- hashed agent token

GitHub Actions sessions do not use:

- a provider workspace ID;
- a runtime-adapter control plane;
- a sandbox lease;
- VNC or desktop capability.

## Events and Archives

Typical event timeline:

```text
GitHub Actions work registered
GitHub Actions runner connected
running: codex
running: validating
completed: done
```

A rerun starts with:

```text
GitHub Actions work resumed
```

Viewer terminal attaches are also recorded.

When `SESSION_LOGS` is configured, session events periodically refresh:

- NDJSON event archive with `eventKey`, `type`, and structured `payload`;
- Markdown transcript;
- JSON summary.

D1 keeps the compact event list and archive pointers used by the app and API.
Legacy message events remain in the same stream with a null key and payload and
the `message` type. Terminal completion forces a current snapshot before
finalization clears.

## Operational Checks

### Verify Registration

Open Fleet or fetch:

```text
GET /api/interactive-sessions/:id/logs
```

Confirm:

- `runtime` is `github_actions`;
- `workKey` and `workKind` are correct;
- `githubRunUrl` points to the current attempt;
- `workState` is `registered`;
- `workPhase` is `waiting_for_runner`.

### Verify Runner Attach

Confirm:

- event `GitHub Actions runner connected`;
- terminal tile shows Attached or Live PTY;
- work state advances to `running`;
- heartbeat and thread or turn IDs appear.

### Verify Steering

During an active turn:

1. Open the focused session terminal.
2. Type a narrow instruction and press Enter.
3. Confirm the terminal echoes `[steer]`.
4. Confirm the Codex response reflects the instruction.
5. Confirm the workflow continues to deterministic validation after the turn.

### Verify Completion

Confirm:

- GitHub Actions run conclusion;
- terminal `workState`;
- `workPhase = done` for success;
- expected `completionReason`;
- final event in the session timeline;
- target-side ClawSweeper result evidence.

## Troubleshooting

### Stuck at `waiting_for_runner`

Likely causes:

- the Action registered but has not started the Codex wrapper;
- the runner PTY connection failed;
- the job failed between registration and worker startup.

Check the exact GitHub Actions job step, then inspect session events.

### Runner Attached but No Heartbeat

The PTY relay and work-state API are separate. Check that the runner has both
`runnerPtyUrl` and `workStateUrl`, and that the current agent token was not
rotated by another registration.

### Steering Says No Active Turn

The Codex turn has not started or has already completed. Deterministic workflow
steps may still be running.

### Old Runner Stops Receiving Input

A newer registration or runner connection replaced it. This is expected. One
logical session has one current runner.

### Session Shows an Old Failure After Rerun

Registration should clear terminal failure and finalization state. Verify the
caller reused the same work key and that production includes the dedicated
GitHub Actions resume lifecycle.

### Repeated Legacy Stop Events

This indicates a lifecycle regression. GitHub Actions sessions must be excluded
from non-adapter stopping reconciliation and must not carry a synthetic workspace
lease.

### Action Succeeded but Session Is Not Complete

The workflow did not post its terminal work-state update. Fix the caller's
success and failure completion steps; do not infer success from socket
disconnect alone.

## Integration Invariants

- `workKey` is stable and unique for logical work.
- Re-registration rotates the agent token.
- Only one runner is current.
- Viewer credentials and runner credentials never cross.
- Work-state and PTY transports are independent.
- Terminal input is interpreted by the runner integration.
- Terminal states require explicit caller updates.
- Cancellation is separate from provider workspace teardown.
- `github_actions` sessions never enter runtime-adapter workspace reconciliation.
- Crabfleet reports status and control; the caller owns task policy and external
  mutations.
