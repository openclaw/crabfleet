import assert from "node:assert/strict";
import test from "node:test";

import {
  initialRecurringRunAt,
  nextRecurringRunAt,
  normalizeCardSchedule,
  parseStoredCardSchedule,
} from "../src/worker/card-schedule.ts";

test("normalizes the interval schedule contract", () => {
  assert.deepEqual(normalizeCardSchedule({ kind: "interval", everyMs: 86_400_000 }), {
    kind: "interval",
    everyMs: 86_400_000,
  });
  assert.deepEqual(normalizeCardSchedule({ kind: "interval", everyMs: 60_000, startAt: 123_000 }), {
    kind: "interval",
    everyMs: 60_000,
    startAt: 123_000,
  });
  assert.deepEqual(parseStoredCardSchedule('{"kind":"interval","everyMs":60000}'), {
    kind: "interval",
    everyMs: 60_000,
  });
  assert.equal(normalizeCardSchedule(null), null);
});

test("rejects ambiguous and unsafe schedules", () => {
  assert.throws(() => normalizeCardSchedule({ kind: "cron", everyMs: 60_000 }), /kind/);
  assert.throws(() => normalizeCardSchedule({ kind: "interval", everyMs: "60000" }), /integer/);
  assert.throws(
    () => normalizeCardSchedule({ kind: "interval", intervalMs: 60_000 }),
    /unsupported field/,
  );
  assert.throws(() => normalizeCardSchedule({ kind: "interval", everyMs: 1_000 }), /between/);
  assert.throws(
    () => normalizeCardSchedule({ kind: "interval", everyMs: 60_000, start_at: 0 }),
    /unsupported field/,
  );
});

test("computes stale interval catch-up in constant time", () => {
  const schedule = { kind: "interval" as const, everyMs: 60_000, startAt: 0 };
  assert.equal(initialRecurringRunAt(schedule, 10_000), 60_000);
  assert.equal(nextRecurringRunAt(schedule, 0, 1_700_000_000_000), 1_700_000_040_000);
  assert.equal(nextRecurringRunAt(schedule, 120_000, 120_000), 180_000);
});

test("honors a future first occurrence", () => {
  const schedule = { kind: "interval" as const, everyMs: 60_000, startAt: 200_000 };
  assert.equal(initialRecurringRunAt(schedule, 100_000), 200_000);
});
