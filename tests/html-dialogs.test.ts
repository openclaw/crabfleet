import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("app actions use styled HTML dialogs instead of browser prompts", async () => {
  const source = await readFile(new URL("../src/app/main.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /<dialog/);
  assert.match(source, /showModal\(\)/);
});
