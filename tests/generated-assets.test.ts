import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("generated embedded specification matches the canonical markdown", async () => {
  await execFileAsync(process.execPath, ["scripts/generate-assets.mjs"]);
  const { SPEC_MARKDOWN } = await import(`../src/generated.ts?spec-assets=${Date.now()}`);
  const source = await readFile(new URL("../docs/spec.md", import.meta.url), "utf8");
  const markdown = source.replace(/^---\n[\s\S]*?\n---\n+/, "");

  assert.equal(SPEC_MARKDOWN, markdown);
  assert.match(SPEC_MARKDOWN, /relay-generation-fenced binary `CFR1` input/);
});
