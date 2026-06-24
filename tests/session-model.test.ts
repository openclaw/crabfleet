import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveSessionLogArchiveTable } from "../src/worker/database.ts";
import {
  crabboxCapabilities,
  interactiveSession,
  interactiveSessionAdapterControlPlane,
  interactiveSessionEvent,
  interactiveSessionLogArchive,
  runtimeCapabilities,
} from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

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
      reconcile_error: "provider unavailable",
      work_state: "running",
    }),
    ["ready"],
    archive,
  );

  assert.equal(session.rootSessionId, "IS-42");
  assert.equal(session.attachUrl, null);
  assert.equal(session.multiplayerMode, true);
  assert.equal(session.workState, "running");
  assert.equal(session.reconciliationNeedsAttention, true);
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
