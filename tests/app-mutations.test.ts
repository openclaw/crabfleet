import assert from "node:assert/strict";
import test from "node:test";

import {
  interactiveStopDialog,
  removeInteractiveSessionState,
  replaceCardState,
  upsertInteractiveSessionState,
} from "../src/app/app-mutations.js";

test("app mutation state helpers replace, insert, and remove owned records", () => {
  const state = {
    cards: [
      { id: "CY-1", title: "Before" },
      { id: "CY-2", title: "Other" },
    ],
    interactiveSessions: [{ id: "IS-1", status: "ready" }],
  };

  assert.deepEqual(replaceCardState(state, { id: "CY-1", title: "After" }).cards, [
    { id: "CY-1", title: "After" },
    { id: "CY-2", title: "Other" },
  ]);
  assert.deepEqual(
    upsertInteractiveSessionState(state, { id: "IS-1", status: "stopped" }).interactiveSessions,
    [{ id: "IS-1", status: "stopped" }],
  );
  assert.deepEqual(
    upsertInteractiveSessionState(state, { id: "IS-2", status: "ready" }).interactiveSessions,
    [
      { id: "IS-2", status: "ready" },
      { id: "IS-1", status: "ready" },
    ],
  );
  assert.deepEqual(removeInteractiveSessionState(state, "IS-1").interactiveSessions, []);
});

test("interactive stop dialogs distinguish workspace deletion and workflow detachment", () => {
  assert.deepEqual(
    interactiveStopDialog(
      {
        id: "IS-1",
        repo: "openclaw/crabfleet",
        adapter: "runtime-v1",
      },
      "IS-1",
    ),
    {
      kind: "danger",
      eyebrow: "Live workspace",
      title: "Delete Crabbox workspace?",
      description:
        "This releases the runtime workspace and cannot be undone. Its final status and logs stay visible in Crabfleet.",
      subject: "openclaw/crabfleet (IS-1)",
      confirmLabel: "Delete workspace",
    },
  );

  const workflow = interactiveStopDialog(
    {
      id: "IS-2",
      repo: "openclaw/crabfleet",
      runtime: "github_actions",
    },
    "IS-2",
  );
  assert.equal(workflow.title, "End GitHub Actions terminal session?");
  assert.equal(workflow.confirmLabel, "End session");
  assert.match(workflow.description, /does not cancel the GitHub Actions workflow run/);

  const fallback = interactiveStopDialog(null, "IS-3");
  assert.equal(fallback.title, "Stop Crabbox session?");
  assert.equal(fallback.confirmLabel, "Stop session");
  assert.match(fallback.description, /releases the managed Sandbox resources/);
});
