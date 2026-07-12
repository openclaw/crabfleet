import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { SPEC_MARKDOWN } from "../src/generated.ts";

test("generated embedded specification matches the canonical markdown", async () => {
  const source = await readFile(new URL("../docs/spec.md", import.meta.url), "utf8");
  const markdown = source.replace(/^---\n[\s\S]*?\n---\n+/, "");

  assert.equal(SPEC_MARKDOWN, markdown);
  assert.match(SPEC_MARKDOWN, /relay-generation-fenced binary `CFR1` input/);
});
