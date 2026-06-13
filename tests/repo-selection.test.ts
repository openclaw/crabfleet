import assert from "node:assert/strict";
import test from "node:test";

import { preferredEnabledRepo } from "../src/repo-selection.ts";

test("repo-less SSH create prefers the configured repo only when enabled", () => {
  assert.equal(
    preferredEnabledRepo(["alpha/project", "tenant/preferred"], "tenant/preferred"),
    "tenant/preferred",
  );
  assert.equal(
    preferredEnabledRepo(["alpha/project", "zeta/project"], "tenant/preferred"),
    "alpha/project",
  );
  assert.equal(preferredEnabledRepo([], "tenant/preferred"), undefined);
});
