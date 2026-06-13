import assert from "node:assert/strict";
import { test } from "node:test";

import { completeTerminalFinalization } from "../src/terminal-finalization.ts";

test("terminal finalization retries after an archive failure", async () => {
  let eventInserted = true;
  let archiveAttempts = 0;
  let cleared = false;
  const operations = {
    ensureEvent: async () => {
      const inserted = eventInserted;
      eventInserted = false;
      return inserted;
    },
    readArchiveState: async () => ({
      eventCount: 4,
      archiveEventCount: archiveAttempts > 1 ? 4 : 3,
      archiveObjectsReady: archiveAttempts > 1,
      archiveSessionVersionMatches: archiveAttempts > 1,
    }),
    archive: async () => {
      archiveAttempts += 1;
      if (archiveAttempts === 1) throw new Error("R2 unavailable");
    },
    clearPending: async () => {
      cleared = true;
      return true;
    },
  };

  await assert.rejects(completeTerminalFinalization(operations), /R2 unavailable/);
  assert.equal(cleared, false);
  await completeTerminalFinalization(operations);
  assert.equal(archiveAttempts, 2);
  assert.equal(cleared, true);
});

test("terminal finalization resumes after interruption between archive and marker clear", async () => {
  let archiveAttempts = 0;
  let clearAttempts = 0;
  const operations = {
    ensureEvent: async () => false,
    readArchiveState: async () => ({
      eventCount: 4,
      archiveEventCount: 4,
      archiveObjectsReady: true,
      archiveSessionVersionMatches: true,
    }),
    archive: async () => {
      archiveAttempts += 1;
    },
    clearPending: async () => {
      clearAttempts += 1;
      if (clearAttempts === 1) throw new Error("interrupted");
      return true;
    },
  };

  await assert.rejects(completeTerminalFinalization(operations), /interrupted/);
  await completeTerminalFinalization(operations);
  assert.equal(archiveAttempts, 0);
  assert.equal(clearAttempts, 2);
});

test("terminal finalization re-archives events racing marker clear", async () => {
  let eventCount = 4;
  let archiveEventCount = 4;
  let archiveAttempts = 0;
  let clearAttempts = 0;
  const operations = {
    ensureEvent: async () => false,
    readArchiveState: async () => ({
      eventCount,
      archiveEventCount,
      archiveObjectsReady: true,
      archiveSessionVersionMatches: true,
    }),
    archive: async () => {
      archiveAttempts += 1;
      archiveEventCount = eventCount;
    },
    clearPending: async () => {
      clearAttempts += 1;
      if (clearAttempts === 1) {
        eventCount += 1;
        return false;
      }
      return archiveEventCount >= eventCount;
    },
  };

  await completeTerminalFinalization(operations);
  assert.equal(archiveAttempts, 1);
  assert.equal(clearAttempts, 2);
  assert.equal(archiveEventCount, 5);
});

test("terminal finalization re-archives mutable session metadata", async () => {
  let archiveSessionVersion = 10;
  const currentSessionVersion = 11;
  let archiveAttempts = 0;
  const operations = {
    ensureEvent: async () => false,
    readArchiveState: async () => ({
      eventCount: 4,
      archiveEventCount: 4,
      archiveObjectsReady: true,
      archiveSessionVersionMatches: archiveSessionVersion === currentSessionVersion,
    }),
    archive: async () => {
      archiveAttempts += 1;
      archiveSessionVersion = currentSessionVersion;
    },
    clearPending: async () => archiveSessionVersion === currentSessionVersion,
  };

  await completeTerminalFinalization(operations);
  assert.equal(archiveAttempts, 1);
});
