import assert from "node:assert/strict";
import test from "node:test";

import { database } from "../src/worker/database.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  terminalFinalizationClearPendingQuery,
  terminalInteractiveSessionFinalizationMessage,
} from "../src/worker/session-terminal-finalization.ts";

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

test("terminal finalization remains pending while any credential lifecycle row exists", () => {
  const db = database({ DB: {} as D1Database } as RuntimeEnv);
  const compiled = terminalFinalizationClearPendingQuery("IS-42", "stopped", true).compile(db);

  assert.match(compiled.sql, /interactive_session_credential_policies/i);
  assert.match(compiled.sql, /interactive_session_credential_policy_registrations/i);
  assert.match(compiled.sql, /NOT EXISTS/i);
});
