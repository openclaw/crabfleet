import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextRecurringRunAt,
  normalizeCardSchedule,
  parseStoredCardSchedule,
} from "../src/recurring-cards.ts";

test("normalizes interval schedules", () => {
  assert.deepEqual(normalizeCardSchedule({ kind: "interval", everyMs: 86_400_000 }), {
    kind: "interval",
    everyMs: 86_400_000,
  });
  assert.deepEqual(parseStoredCardSchedule('{"kind":"interval","everyMs":60000}'), {
    kind: "interval",
    everyMs: 60_000,
  });
});

test("rejects unsupported or unsafe schedules", () => {
  assert.equal(normalizeCardSchedule(null), null);
  assert.throws(() => normalizeCardSchedule({ kind: "cron", expr: "0 6 * * *" }), /kind/);
  assert.throws(() => normalizeCardSchedule({ kind: "interval", everyMs: 1000 }), /between/);
  assert.throws(() => normalizeCardSchedule({ kind: "interval", everyMs: 1.5 }), /integer/);
});

test("computes the next due interval without immediate loops", () => {
  const schedule = { kind: "interval" as const, everyMs: 1_000 };
  assert.equal(nextRecurringRunAt(schedule, 10_000, null), 11_000);
  assert.equal(nextRecurringRunAt(schedule, 10_000, 9_500), 10_500);
  assert.equal(nextRecurringRunAt(schedule, 10_000, 5_000), 11_000);
});

test("honors a future startAt for first run", () => {
  const schedule = { kind: "interval" as const, everyMs: 1_000, startAt: 20_000 };
  assert.equal(nextRecurringRunAt(schedule, 10_000, null), 20_000);
  assert.equal(nextRecurringRunAt(schedule, 20_000, null), 21_000);
});
