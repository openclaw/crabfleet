import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("the documented Node runner acknowledges only delivered UTF-8 input", async () => {
  const [readme, guide] = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/github-actions-sessions.md", import.meta.url), "utf8"),
  ]);

  assert.match(readme, /complete byte-safe encoder, decoder, and Node PTY runner/);
  assert.match(readme, /new WebSocket\(runnerPtyUrl, "cfr1-framed-io-v2"\)/);
  assert.match(readme, /terminal\.protocol === "cfr1-framed-io-v2"/);
  assert.match(readme, /ignore the offer leave `WebSocket\.protocol` empty/);
  assert.doesNotMatch(readme, /New runners opt into[\s\S]*cfr1-framed-io-v1/);
  assert.doesNotMatch(readme, /encodeCfr1Output|decodeCfr1Input|encodeCfr1Ack/);
  assert.match(guide, /new WebSocket\(runnerPtyUrl, "cfr1-framed-io-v2"\)/);
  assert.match(guide, /terminal\.protocol !== "cfr1-framed-io-v2"/);
  assert.doesNotMatch(guide, /searchParams\.set\("runnerProtocol"/);
  assert.match(guide, /let pendingInputs = \[\]/);
  assert.match(guide, /let inputQueue = Promise\.resolve\(\)/);
  assert.match(
    guide,
    /inputQueue = inputQueue\s+\.then\(\(\) => acceptInput\(event\.data\)\)\s+\.catch/,
  );
  assert.match(guide, /pendingInputs\.push\(input\)/);
  assert.match(guide, /text = decodeCompleteUtf8\(payload\)/);
  assert.match(guide, /if \(text === null\) \{\s+armPendingInputTimer\(\);\s+return;/);
  assert.match(
    guide,
    /const inputs = takePendingInputs\(\);\s+try \{\s+await deliverSteeringInput\(text\);\s+settleInputs\(inputs, true\)/,
  );
  assert.match(guide, /catch \{\s+settleInputs\(inputs, false\);/);
  assert.match(guide, /const maxPendingInputBytes = 16 \* 1024/);
  assert.match(guide, /const maxPendingInputFrames = 32/);
  assert.match(guide, /const maxPendingInputAgeMs = 1_000/);
  assert.match(guide, /settleInputs\(takePendingInputs\(\), false\)/);
  assert.match(guide, /pendingInputBytes > maxPendingInputBytes/);
  assert.match(guide, /pendingInputs\.length > maxPendingInputFrames/);
  assert.match(guide, /clearTimeout\(pendingInputTimer\)/);
  assert.match(
    guide,
    /const inputs = pendingInputs;\s+pendingInputs = \[\];\s+pendingInputBytes = 0;\s+return inputs;/,
  );
  assert.match(guide, /new TextDecoder\("utf-8", \{ fatal: true, ignoreBOM: true \}\)/);
  assert.doesNotMatch(guide, /inputDecoder\.decode/);
  assert.match(guide, /subscribeSteeringOutput\(\(outputText\) => \{/);
  assert.match(guide, /encodeUtf8Output\(outputText\)/);
  assert.match(guide, /deliberately a UTF-8 text adapter/);
  assert.match(guide, /byte-oriented restricted steering adapter/);
  assert.match(guide, /Generation-fenced viewers add `viewerProtocol=cfr1-framed-io-v2`/);
  assert.match(guide, /stale-generation input is rejected before it\s+can reach/);
  assert.match(guide, /encodeAck\(input\.inputId, input\.generation, accepted\)/);
  assert.match(guide, /Legacy viewers omit that query/);
  assert.match(guide, /subscribeSteeringExit\(\(\) => \{/);
  assert.match(guide, /terminal\.close\(1000, "pty exited"\)/);
  assert.match(guide, /must never forward that input to a\s+shell or subprocess/);
  assert.doesNotMatch(guide, /spawn\(process\.env\.SHELL|env:\s*process\.env|pty\.write/);

  const timerArm = guide.indexOf("armPendingInputTimer();");
  const batchSnapshot = guide.indexOf("const inputs = takePendingInputs();");
  const delivery = guide.indexOf("await deliverSteeringInput(text);");
  assert.ok(timerArm > guide.indexOf("if (text === null)"));
  assert.ok(batchSnapshot > timerArm);
  assert.ok(delivery > batchSnapshot);

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
