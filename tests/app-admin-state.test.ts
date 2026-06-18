import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAdminPolicy } from "../src/app/admin-state.js";

test("admin policy normalization clamps finite caps and defaults invalid input", () => {
  assert.deepEqual(normalizeAdminPolicy({ cap: "500", retention: "30", merge: "guarded" }), {
    cap: 200,
    retention: "30",
    merge: "guarded",
  });
  assert.equal(normalizeAdminPolicy({ cap: "0", retention: "14", merge: "disabled" }).cap, 1);
  assert.equal(normalizeAdminPolicy({ cap: "bad", retention: "60", merge: "guarded" }).cap, 20);
});
