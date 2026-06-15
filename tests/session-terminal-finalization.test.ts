import assert from "node:assert/strict";
import test from "node:test";

import { terminalInteractiveSessionFinalizationMessage } from "../src/worker/session-terminal-finalization.ts";

test("terminal finalization messages preserve lifecycle and failure evidence", () => {
  assert.equal(
    terminalInteractiveSessionFinalizationMessage("stopped", undefined),
    "interactive workspace stopped",
  );
  assert.equal(
    terminalInteractiveSessionFinalizationMessage("expired", undefined),
    "interactive workspace expired",
  );
  assert.equal(
    terminalInteractiveSessionFinalizationMessage("failed", {
      terminal_failure_reason: "provider create failed",
      reconcile_error: "release retry failed",
      last_event: "generic failure",
    }),
    "provider create failed",
  );
  assert.equal(
    terminalInteractiveSessionFinalizationMessage("failed", {
      terminal_failure_reason: null,
      reconcile_error: null,
      last_event: null,
    }),
    "interactive workspace failed after release",
  );
});
