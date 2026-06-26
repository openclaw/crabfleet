import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleInteractiveSessionReconciliation,
  scheduleNativeAuthPruning,
  scheduleRecurringCardTick,
  type ScheduledExecutionContext,
} from "../src/worker/scheduled.ts";

function context(tasks: Promise<unknown>[]): ScheduledExecutionContext {
  return {
    waitUntil(task) {
      tasks.push(task);
    },
  };
}

test("scheduled reconciliation captures one clock and registers its task", async () => {
  const tasks: Promise<unknown>[] = [];
  const calls: string[] = [];

  scheduleInteractiveSessionReconciliation(context(tasks), {
    now: () => {
      calls.push("now");
      return 123;
    },
    reconcile: async (now) => {
      calls.push(`reconcile:${now}`);
    },
    reportError: () => {
      calls.push("error");
    },
  });

  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.deepEqual(calls, ["now", "reconcile:123"]);
});

test("scheduled reconciliation reports task failures without rejecting waitUntil", async () => {
  const tasks: Promise<unknown>[] = [];
  const failure = new Error("failed");
  const reported: unknown[] = [];

  scheduleInteractiveSessionReconciliation(context(tasks), {
    now: () => 456,
    reconcile: async () => {
      throw failure;
    },
    reportError: (error) => {
      reported.push(error);
    },
  });

  await assert.doesNotReject(tasks[0]);
  assert.deepEqual(reported, [failure]);
});

test("scheduled recurring cards capture one clock and register their task", async () => {
  const tasks: Promise<unknown>[] = [];
  const calls: string[] = [];

  scheduleRecurringCardTick(context(tasks), {
    now: () => {
      calls.push("now");
      return 789;
    },
    run: async (now) => {
      calls.push(`run:${now}`);
    },
    reportError: () => {
      calls.push("error");
    },
  });

  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.deepEqual(calls, ["now", "run:789"]);
});

test("scheduled recurring cards report failures without rejecting waitUntil", async () => {
  const tasks: Promise<unknown>[] = [];
  const failure = new Error("failed");
  const reported: unknown[] = [];

  scheduleRecurringCardTick(context(tasks), {
    now: () => 789,
    run: async () => {
      throw failure;
    },
    reportError: (error) => {
      reported.push(error);
    },
  });

  await assert.doesNotReject(tasks[0]);
  assert.deepEqual(reported, [failure]);
});

test("scheduled native auth cleanup prunes expired credentials", async () => {
  const tasks: Promise<unknown>[] = [];
  const calls: string[] = [];

  scheduleNativeAuthPruning(context(tasks), {
    now: () => {
      calls.push("now");
      return 987;
    },
    prune: async (now) => {
      calls.push(`prune:${now}`);
    },
    reportError: () => {
      calls.push("error");
    },
  });

  assert.equal(tasks.length, 1);
  await tasks[0];
  assert.deepEqual(calls, ["now", "prune:987"]);
});
