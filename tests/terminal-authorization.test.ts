import assert from "node:assert/strict";
import test from "node:test";

import { cachedBooleanGrant } from "../src/terminal-authorization.ts";

test("terminal authorization coalesces concurrent reads within a short TTL", async () => {
  let now = 100;
  let reads = 0;
  let resolveRead: ((allowed: boolean) => void) | undefined;
  const grant = cachedBooleanGrant(
    () => {
      reads += 1;
      return new Promise<boolean>((resolve) => {
        resolveRead = resolve;
      });
    },
    10,
    () => now,
  );

  const checks = [grant(), grant(), grant()];
  await Promise.resolve();
  assert.equal(reads, 1);
  resolveRead?.(true);
  assert.deepEqual(await Promise.all(checks), [true, true, true]);
  assert.equal(await grant(), true);
  assert.equal(reads, 1);

  now = 111;
  const refreshed = grant();
  await Promise.resolve();
  assert.equal(reads, 2);
  resolveRead?.(false);
  assert.equal(await refreshed, false);
});

test("terminal authorization fails closed when its state read fails", async () => {
  const grant = cachedBooleanGrant(async () => {
    throw new Error("D1 unavailable");
  });
  assert.equal(await grant(), false);
});
