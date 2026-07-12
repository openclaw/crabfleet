import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the documented Node runner preserves split UTF-8 input frames", async () => {
  const [readme, guide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/github-actions-sessions.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /complete byte-safe encoder, decoder, and Node PTY runner/);
  assert.doesNotMatch(readme, /encodeCfr1Output|decodeCfr1Input|encodeCfr1Ack/);
  assert.match(guide, /new TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.match(guide, /inputDecoder\.decode\(input\.payload, \{ stream: true \}\)/);
  assert.match(guide, /pty\.onExit\(\(\) => \{/);
  assert.match(guide, /terminal\.close\(1000, "pty exited"\)/);

  const decoder = new TextDecoder("utf-8", { fatal: true });
  assert.equal(decoder.decode(Uint8Array.from([0xf0, 0x9f]), { stream: true }), "");
  assert.equal(decoder.decode(Uint8Array.from([0xa6, 0x80]), { stream: true }), "🦀");
});
