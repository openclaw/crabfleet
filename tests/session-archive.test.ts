import assert from "node:assert/strict";
import test from "node:test";

import {
  obsoleteSessionArchiveObjectKeys,
  sameSessionArchiveObjectKeys,
  sessionArchiveAttemptKeys,
} from "../src/session-archive.ts";

test("concurrent archive attempts always use distinct object keys", () => {
  const first = sessionArchiveAttemptKeys("sessions/IS-101", 4, 123, 456, "attempt-a");
  const second = sessionArchiveAttemptKeys("sessions/IS-101", 4, 123, 456, "attempt-b");
  assert.equal(sameSessionArchiveObjectKeys(first, second), false);
});

test("archive cleanup never selects the committed object keys", () => {
  const previous = sessionArchiveAttemptKeys("sessions/IS-101", 3, 100, 400, "previous");
  const attempted = sessionArchiveAttemptKeys("sessions/IS-101", 4, 123, 456, "attempted");
  const winner = sessionArchiveAttemptKeys("sessions/IS-101", 4, 123, 456, "winner");

  assert.deepEqual(obsoleteSessionArchiveObjectKeys(attempted, previous, attempted), previous);
  assert.deepEqual(obsoleteSessionArchiveObjectKeys(winner, previous, attempted), attempted);
  assert.equal(obsoleteSessionArchiveObjectKeys(attempted, attempted, attempted), undefined);
});
