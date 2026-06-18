import assert from "node:assert/strict";
import test from "node:test";

import { mergeTerminalStatus } from "../src/app/terminal-state.js";

test("terminal status updates retain identity for unchanged labels", () => {
  const current = { "IS-1": "Live PTY" };
  assert.equal(mergeTerminalStatus(current, "IS-1", "Live PTY"), current);
  assert.deepEqual(mergeTerminalStatus(current, "IS-1", "Read-only PTY"), {
    "IS-1": "Read-only PTY",
  });
  assert.deepEqual(mergeTerminalStatus(current, "IS-2", "Connecting"), {
    "IS-1": "Live PTY",
    "IS-2": "Connecting",
  });
});
