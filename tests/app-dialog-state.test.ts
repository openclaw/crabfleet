import assert from "node:assert/strict";
import test from "node:test";

import { actionDialogReducer, initialActionDialogState } from "../src/app/dialog-state.js";

test("action dialogs allocate stable identities and close only when idle", () => {
  const opened = actionDialogReducer(initialActionDialogState, {
    type: "open",
    options: { kind: "danger", title: "Delete", action: () => undefined },
  });
  assert.equal(opened.nextId, 2);
  assert.deepEqual(
    { ...opened.dialog, action: undefined },
    {
      id: 1,
      pending: false,
      error: "",
      kind: "danger",
      title: "Delete",
      action: undefined,
    },
  );

  const pending = actionDialogReducer(opened, { type: "start", id: 1 });
  assert.equal(pending.dialog?.pending, true);
  assert.equal(actionDialogReducer(pending, { type: "close" }), pending);

  const closed = actionDialogReducer(opened, { type: "close" });
  assert.equal(closed.dialog, null);
  assert.equal(closed.nextId, 2);
});

test("action dialog completion is fenced to the active identity", () => {
  const first = actionDialogReducer(initialActionDialogState, {
    type: "open",
    options: { title: "First" },
  });
  const second = actionDialogReducer(first, {
    type: "open",
    options: { title: "Second" },
  });

  assert.equal(actionDialogReducer(second, { type: "resolve", id: 1 }), second);
  assert.equal(actionDialogReducer(second, { type: "reject", id: 1, message: "old" }), second);

  const failed = actionDialogReducer(second, {
    type: "reject",
    id: 2,
    message: "Failed safely",
  });
  assert.equal(failed.dialog?.pending, false);
  assert.equal(failed.dialog?.error, "Failed safely");
  assert.equal(actionDialogReducer(failed, { type: "resolve", id: 2 }).dialog, null);
});
