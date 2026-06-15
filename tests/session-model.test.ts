import assert from "node:assert/strict";
import test from "node:test";

import type {
  InteractiveSessionLogArchiveTable,
  InteractiveSessionRow,
} from "../src/worker/database.ts";
import {
  crabboxCapabilities,
  interactiveSession,
  interactiveSessionAdapterControlPlane,
  interactiveSessionEvent,
  interactiveSessionLogArchive,
  runtimeCapabilities,
} from "../src/worker/session-model.ts";

function sessionRow(values: Partial<InteractiveSessionRow> = {}): InteractiveSessionRow {
  return {
    id: "IS-42",
    parent_session_id: null,
    root_session_id: null,
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "container",
    adapter: null,
    profile: "cloudflare-sandbox",
    adapter_workspace_id: null,
    adapter_control_plane: "https://adapter.example",
    provider_resource_id: null,
    capabilities_json: "{}",
    expires_at: null,
    last_reconciled_at: null,
    reconcile_error: null,
    terminal_status: null,
    terminal_failure_reason: null,
    adapter_ttl_seconds: null,
    adapter_idle_timeout_seconds: null,
    adapter_requested_capabilities_json: null,
    adapter_create_payload_json: null,
    adapter_create_pending: 0,
    preparation_pending: 0,
    openclaw_request_id: null,
    openclaw_request_hash: null,
    openclaw_admission_closed: 0,
    terminal_finalize_pending: 0,
    credential_cleanup_terminal_status: null,
    sandbox_refresh_sandbox_id: null,
    sandbox_refresh_claim: null,
    sandbox_refresh_claim_expires_at: null,
    command: "codex",
    prompt: "Fix the issue",
    purpose: "Fix the issue",
    summary: "Working",
    owner: "owner",
    created_by: "github:42",
    status: "ready",
    lease_id: "lease-1",
    attach_url: "wss://terminal.example",
    vnc_url: null,
    last_event: "ready",
    created_at: 1,
    updated_at: 2,
    last_seen_at: 3,
    stopped_at: null,
    share_mode: "private",
    share_token_hash: null,
    share_token_preview: null,
    control_requested_by: null,
    control_requested_at: null,
    controller: null,
    control_granted_at: null,
    control_expires_at: null,
    multiplayer_mode: 1,
    agent_token_hash: null,
    work_key: null,
    work_kind: null,
    work_state: "",
    work_phase: "",
    source_url: null,
    github_run_url: null,
    codex_thread_id: null,
    codex_turn_id: null,
    last_heartbeat_at: null,
    completion_reason: null,
    ...values,
  };
}

test("runtime capabilities use runtime defaults and honor explicit booleans only", () => {
  assert.deepEqual(runtimeCapabilities("crabbox", "{"), crabboxCapabilities);
  assert.deepEqual(runtimeCapabilities("container", '{"terminal":false,"vnc":true}'), {
    terminal: false,
    takeover: false,
    vnc: true,
    desktop: false,
    logs: true,
    artifacts: true,
  });
  assert.deepEqual(runtimeCapabilities("container", '{"terminal":"yes","logs":null}'), {
    terminal: true,
    takeover: false,
    vnc: false,
    desktop: false,
    logs: true,
    artifacts: true,
  });
});

test("interactive session mapping centralizes row names, defaults, and hidden identity", () => {
  const archive = {
    sessionId: "IS-42",
    eventCount: 3,
    eventsKey: "events",
    transcriptKey: "transcript",
    summaryKey: "summary",
    archivedAt: 4,
    updatedAt: 5,
  };
  const session = interactiveSession(
    sessionRow({
      capabilities_json: '{"terminal":false}',
      work_state: "running",
    }),
    ["ready"],
    archive,
  );

  assert.equal(session.rootSessionId, "IS-42");
  assert.equal(session.attachUrl, null);
  assert.equal(session.multiplayerMode, true);
  assert.equal(session.workState, "running");
  assert.deepEqual(session.logs, ["ready"]);
  assert.equal(session.logArchive, archive);
  assert.equal(session[interactiveSessionAdapterControlPlane], "https://adapter.example");
});

test("event and archive rows map to public session records", () => {
  assert.deepEqual(
    interactiveSessionEvent({
      id: 1,
      session_id: "IS-42",
      actor: "owner",
      message: "ready",
      created_at: 10,
    }),
    { actor: "owner", message: "ready", createdAt: 10 },
  );

  const row: InteractiveSessionLogArchiveTable = {
    session_id: "IS-42",
    event_count: 3,
    events_key: "events",
    transcript_key: "transcript",
    summary_key: "summary",
    archived_at: 11,
    updated_at: 12,
    session_updated_at: 10,
  };
  assert.deepEqual(interactiveSessionLogArchive(row), {
    sessionId: "IS-42",
    eventCount: 3,
    eventsKey: "events",
    transcriptKey: "transcript",
    summaryKey: "summary",
    archivedAt: 11,
    updatedAt: 12,
  });
});
