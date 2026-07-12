import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the documented Node runner rejects split UTF-8 input frames", async () => {
  const [readme, guide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/github-actions-sessions.md", import.meta.url), "utf8"),
  ]);

  for (const documentation of [readme, guide]) {
    assert.match(documentation, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
    assert.match(documentation, /inputDecoder\.decode\(input\.payload\)/);
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  assert.throws(() => decoder.decode(Uint8Array.from([0xf0, 0x9f])), TypeError);
  assert.throws(() => decoder.decode(Uint8Array.from([0xa6, 0x80])), TypeError);
});
