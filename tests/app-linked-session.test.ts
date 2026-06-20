import assert from "node:assert/strict";
import test from "node:test";

import {
  linkedSessionFailure,
  linkedSessionUsesSharedFallback,
} from "../src/app/linked-session.js";

test("linked session failures preserve identity and access-specific copy", () => {
  const missing = linkedSessionFailure("IS-404", 404, "share-token");
  assert.equal(missing.id, "IS-404");
  assert.equal(missing.status, "unavailable");
  assert.equal(missing.lastEvent, "Codex session was not found.");
  assert.equal(missing.sharedReadOnly, true);
  assert.equal(missing.sharedLinkOnly, true);

  const forbidden = linkedSessionFailure("IS-403", 403, null);
  assert.equal(forbidden.lastEvent, "You do not have access to this Codex session.");
  assert.equal(forbidden.sharedReadOnly, false);
  assert.equal(forbidden.sharedLinkOnly, false);
});

test("signed-in linked sessions fall back only to explicit public share tokens", () => {
  assert.equal(linkedSessionUsesSharedFallback(404, "share-token"), true);
  assert.equal(linkedSessionUsesSharedFallback(403, "share-token"), true);
  assert.equal(linkedSessionUsesSharedFallback(401, "share-token"), false);
  assert.equal(linkedSessionUsesSharedFallback(404, null), false);
});
