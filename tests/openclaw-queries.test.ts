import assert from "node:assert/strict";
import test from "node:test";

import { interactiveSession } from "../src/worker/session-model.ts";
import {
  buildOpenClawTranscript,
  openClawSessionSummary,
  openClawTranscriptEventLimit,
  openClawTranscriptEventWindow,
  openClawVisibleRoomSessions,
} from "../src/worker/openclaw-queries.ts";
import { sessionRow } from "./helpers/session-row.ts";

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("OpenClaw room queries reject invalid roots and filter invalid descendants", () => {
  const root = interactiveSession(
    sessionRow({
      id: "IS-1",
      root_session_id: "IS-1",
      created_by: "service:openclaw",
    }),
    [],
  );
  const child = interactiveSession(
    sessionRow({
      id: "IS-2",
      parent_session_id: "IS-1",
      root_session_id: "IS-1",
      created_by: "session:IS-1",
    }),
    [],
  );
  const invalid = { ...child, id: "IS-3", createdBy: "github:42" };

  assert.deepEqual(
    openClawVisibleRoomSessions("IS-1", root, {
      sessions: [root, child, invalid],
      overflow: false,
    }).map((session) => session.id),
    ["IS-1", "IS-2"],
  );
  assert.throws(
    () => openClawVisibleRoomSessions("IS-1", null, { sessions: [], overflow: false }),
    (error) => {
      assert.equal(status(error), 404);
      return true;
    },
  );
  assert.throws(
    () => openClawVisibleRoomSessions("IS-1", root, { sessions: [root], overflow: true }),
    (error) => {
      assert.equal(status(error), 503);
      return true;
    },
  );
});

test("OpenClaw transcript queries consume a sentinel and preserve truncation evidence", () => {
  const events = Array.from({ length: openClawTranscriptEventWindow }, (_, index) => index + 1);
  let rendered: number[] = [];
  const result = buildOpenClawTranscript(events, 300, (selected) => {
    rendered = selected;
    return selected.join(",");
  });

  assert.equal(openClawTranscriptEventLimit, 240);
  assert.equal(openClawTranscriptEventWindow, 241);
  assert.equal(rendered.length, 240);
  assert.equal(rendered[0], 2);
  assert.equal(result.eventCount, 300);
  assert.equal(result.truncated, true);
  assert.equal(
    buildOpenClawTranscript([1, 2], 2, (selected) => selected.join(",")).truncated,
    false,
  );
});

test("OpenClaw summaries remove logs without mutating the session", () => {
  const session = interactiveSession(sessionRow(), ["first", "second"]);
  const summary = openClawSessionSummary(session);
  assert.deepEqual(summary.logs, []);
  assert.deepEqual(session.logs, ["first", "second"]);
  assert.equal(summary.id, session.id);
});
