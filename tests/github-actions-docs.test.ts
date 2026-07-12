import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the documented Node runner acknowledges only delivered UTF-8 input", async () => {
  const [readme, guide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/github-actions-sessions.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /complete byte-safe encoder, decoder, and Node PTY runner/);
  assert.match(readme, /runnerProtocol", "cfr1-framed-io-v2"/);
  assert.match(readme, /`runnerProtocol=cfr1-framed-io-v2` query/);
  assert.doesNotMatch(readme, /New runners opt into[\s\S]*cfr1-framed-io-v1/);
  assert.doesNotMatch(readme, /encodeCfr1Output|decodeCfr1Input|encodeCfr1Ack/);
  assert.match(guide, /let pendingInputs = \[\]/);
  assert.match(guide, /pendingInputs\.push\(input\)/);
  assert.match(guide, /const text = decodeCompleteUtf8\(payload\)/);
  assert.match(guide, /if \(text === null\) return/);
  assert.match(guide, /pty\.write\(text\);\s+settlePendingInputs\(true\)/);
  assert.match(guide, /const maxPendingInputBytes = 16 \* 1024/);
  assert.match(guide, /const maxPendingInputFrames = 32/);
  assert.match(guide, /const maxPendingInputAgeMs = 1_000/);
  assert.match(guide, /setTimeout\(\(\) => settlePendingInputs\(false\), maxPendingInputAgeMs\)/);
  assert.match(guide, /pendingInputBytes > maxPendingInputBytes/);
  assert.match(guide, /pendingInputs\.length > maxPendingInputFrames/);
  assert.match(guide, /clearTimeout\(pendingInputTimer\)/);
  assert.match(guide, /new TextDecoder\("utf-8", \{ fatal: true, ignoreBOM: true \}\)/);
  assert.doesNotMatch(guide, /inputDecoder\.decode/);
  assert.match(guide, /pty\.onData\(\(outputText\) => \{/);
  assert.match(guide, /encodeUtf8Output\(outputText\)/);
  assert.match(guide, /deliberately a UTF-8 text adapter/);
  assert.match(guide, /lossless\s+arbitrary PTY bytes must use a byte-oriented PTY adapter/);
  assert.match(guide, /Generation-fenced viewers add `viewerProtocol=cfr1-framed-io-v2`/);
  assert.match(guide, /stale-generation input is rejected before it\s+can reach/);
  assert.match(guide, /encodeAck\(input\.inputId, input\.generation, accepted\)/);
  assert.match(guide, /Legacy viewers omit that query/);
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

test("the architecture documents negotiated and legacy viewer output", async () => {
  const architecture = await readFile(new URL("../docs/architecture.md", import.meta.url), "utf8");

  assert.match(architecture, /Viewer framing is negotiated independently/);
  assert.match(
    architecture,
    /opted-in viewers receive `CFR1` terminal, lifecycle, and acknowledgement/,
  );
  assert.match(
    architecture,
    /legacy viewers retain raw terminal output and JSON control-message fallbacks/,
  );
});
