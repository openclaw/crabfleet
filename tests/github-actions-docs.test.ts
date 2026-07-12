import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the documented Node runner acknowledges only delivered UTF-8 input", async () => {
  const [readme, guide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/github-actions-sessions.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /complete byte-safe encoder, decoder, and Node PTY runner/);
  assert.doesNotMatch(readme, /encodeCfr1Output|decodeCfr1Input|encodeCfr1Ack/);
  assert.match(guide, /let pendingInputs = \[\]/);
  assert.match(guide, /pendingInputs\.push\(input\)/);
  assert.match(guide, /const text = decodeCompleteUtf8\(payload\)/);
  assert.match(guide, /if \(text === null\) return/);
  assert.match(guide, /pty\.write\(text\);\s+settlePendingInputs\(true\)/);
  assert.match(guide, /new TextDecoder\("utf-8", \{ fatal: true, ignoreBOM: true \}\)/);
  assert.doesNotMatch(guide, /inputDecoder\.decode/);
  assert.match(guide, /pty\.onExit\(\(\) => \{/);
  assert.match(guide, /terminal\.close\(1000, "pty exited"\)/);

  const decodeCompleteUtf8 = (payload: Uint8Array) => {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    const text = decoder.decode(payload, { stream: true });
    return new TextEncoder().encode(text).byteLength === payload.byteLength ? text : null;
  };
  assert.equal(decodeCompleteUtf8(Uint8Array.from([0xe2, 0x82])), null);
  assert.equal(decodeCompleteUtf8(Uint8Array.from([0xe2, 0x82, 0xac])), "\u20ac");
  assert.throws(() => decodeCompleteUtf8(Uint8Array.from([0xe2, 0x28, 0xa1])));
});
