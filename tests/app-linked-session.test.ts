import assert from "node:assert/strict";
import test from "node:test";

import { linkedSessionFailure } from "../src/app/linked-session.js";

test("linked session failures preserve identity and access-specific copy", () => {
  const missing = linkedSessionFailure("IS-404", 404, "share-token");
  assert.equal(missing.id, "IS-404");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.lastEvent, "Codex session was not found.");
  assert.equal(missing.sharedReadOnly, true);

  const forbidden = linkedSessionFailure("IS-403", 403, null);
  assert.equal(forbidden.lastEvent, "You do not have access to this Codex session.");
  assert.equal(forbidden.sharedReadOnly, false);
});
