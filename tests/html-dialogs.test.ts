import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("app actions use styled HTML dialogs instead of browser prompts", async () => {
  const source = await readFile(new URL("../src/app/main.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bwindow\.(?:alert|confirm|prompt)\s*\(/);
  assert.match(source, /<dialog/);
  assert.match(source, /showModal\(\)/);
  assert.match(source, /key=\{state\.deployment\?\.defaultRuntime \|\| "container"\}/);
  assert.match(source, /useEffect\(\(\) => setRepo\(preferred\), \[preferred\]\)/);
});

test("fleet terminal affordances require attachable session state", async () => {
  const source = await readFile(new URL("../src/app/fleet.jsx", import.meta.url), "utf8");

  assert.match(source, /const attachable = isFleetSessionAttachable\(session\)/);
  assert.match(source, /\{attachable \? \(/);
  assert.match(source, /cli=\{totals\.attachable \?\? props\.cli\}/);
});
