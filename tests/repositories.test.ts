import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import test from "node:test";

import { normalizeRepo } from "../src/worker/repositories.ts";

test("normalizeRepo preserves canonical repository normalization", () => {
  const cases = [
    [undefined, ""],
    [" OpenClaw/Crabfleet ", "openclaw/crabfleet"],
    ["HTTPS://github.com/OpenClaw/Crabfleet.git/", "openclaw/crabfleet"],
    ["openclaw/crabfleet////", "openclaw/crabfleet"],
    ["openclaw/crabfleet.git", "openclaw/crabfleet"],
    ["openclaw/crabfleet.git/branch", "openclaw/crabfleet.git/branch"],
  ] as const;

  for (const [input, expected] of cases) {
    assert.equal(normalizeRepo(input), expected);
  }
});

test("normalizeRepo handles long internal slash runs in bounded time", () => {
  const input = `openclaw/crabfleet${"/".repeat(32_768)}x`;
  const startedAt = performance.now();

  assert.equal(normalizeRepo(input), input);
  assert.ok(performance.now() - startedAt < 250);
});
