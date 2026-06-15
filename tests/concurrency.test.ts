import assert from "node:assert/strict";
import test from "node:test";

import { mapWithConcurrency } from "../src/worker/concurrency.ts";

test("bounded concurrency processes each value without exceeding the worker limit", async () => {
  const completed: number[] = [];
  let active = 0;
  let maximumActive = 0;

  await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, value % 2));
    completed.push(value);
    active -= 1;
  });

  assert.equal(maximumActive, 2);
  assert.deepEqual(new Set(completed), new Set([1, 2, 3, 4, 5]));
});

test("bounded concurrency handles empty input and propagates operation failures", async () => {
  let calls = 0;
  await mapWithConcurrency([], 0, async () => {
    calls += 1;
  });
  assert.equal(calls, 0);

  await assert.rejects(
    mapWithConcurrency([1], 0, async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );
});
