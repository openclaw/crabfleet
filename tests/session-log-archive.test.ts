import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionLogArchiveBase,
  sessionLogSummary,
  sessionLogTranscript,
  shouldArchiveInteractiveSessionLogs,
} from "../src/worker/session-log-archive.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const archive = {
  session_id: "IS-1",
  event_count: 10,
  session_updated_at: 100,
  events_key: "events",
  transcript_key: "transcript",
  summary_key: "summary",
  archived_at: 100,
  updated_at: 100,
};

test("archive cadence handles force, small sessions, batches, and cooldowns", () => {
  assert.equal(shouldArchiveInteractiveSessionLogs(undefined, 0, 100), true);
  assert.equal(shouldArchiveInteractiveSessionLogs(archive, 9, 1000), false);
  assert.equal(shouldArchiveInteractiveSessionLogs({ ...archive, event_count: 1 }, 2, 101), true);
  assert.equal(shouldArchiveInteractiveSessionLogs(archive, 30, 101), true);
  assert.equal(shouldArchiveInteractiveSessionLogs(archive, 10, 60_099), false);
  assert.equal(shouldArchiveInteractiveSessionLogs(archive, 10, 60_100), true);
  assert.equal(shouldArchiveInteractiveSessionLogs(archive, 9, 1, true), true);
});

test("archive object bases sanitize only the session path segment", () => {
  assert.equal(
    sessionLogArchiveBase("IS/1 unsafe"),
    "orgs/openclaw/interactive-sessions/IS_1_unsafe",
  );
});

test("transcripts render row metadata and ordered events", () => {
  const transcript = sessionLogTranscript(
    sessionRow({
      id: "IS-1",
      parent_session_id: "IS-0",
      root_session_id: "IS-root",
      work_state: "running",
      work_phase: "review",
    }),
    [
      {
        id: 1,
        session_id: "IS-1",
        actor: "operator",
        message: "started",
        created_at: 0,
      },
    ],
  );

  assert.match(transcript, /^# IS-1/m);
  assert.match(transcript, /parent: IS-0/);
  assert.match(transcript, /root: IS-root/);
  assert.match(transcript, /work_state: running/);
  assert.match(transcript, /1970-01-01T00:00:00.000Z operator: started/);
});

test("transcripts accept domain sessions and summaries keep event anchors", () => {
  const row = sessionRow({
    id: "IS-1",
    root_session_id: null,
    work_state: "completed",
    last_event: "fallback",
    updated_at: 120,
  });
  const session = interactiveSession(row, []);
  assert.match(sessionLogTranscript(session, []), /root: IS-1/);

  const summary = sessionLogSummary(row, [
    { id: 1, session_id: "IS-1", actor: "a", message: "first", created_at: 10 },
    { id: 2, session_id: "IS-1", actor: "b", message: "last", created_at: 20 },
  ]);
  assert.equal(summary.workState, "completed");
  assert.equal(summary.eventCount, 2);
  assert.equal(summary.firstEventAt, 10);
  assert.equal(summary.lastEventAt, 20);
  assert.equal(summary.lastEvent, "last");
  assert.equal(summary.updatedAt, 120);
});
