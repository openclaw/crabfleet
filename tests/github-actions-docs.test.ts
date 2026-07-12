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
  assert.match(guide, /const framed = terminal\.protocol === "cfr1-framed-io-v2"/);
  assert.match(guide, /empty protocol means an older relay kept this socket in legacy raw mode/);
  assert.match(guide, /terminal\.send\(framed \? encodeUtf8Output\(outputText\) : outputText\)/);
  assert.doesNotMatch(guide, /close\(1002, "framed protocol not negotiated"\)/);
  assert.doesNotMatch(guide, /throw new Error\("relay did not negotiate cfr1-framed-io-v2"\)/);
  assert.doesNotMatch(guide, /searchParams\.set\("runnerProtocol"/);
  assert.match(guide, /`runnerProtocol` query remains compatibility-only/);
  assert.match(guide, /New runners must not add it, close, or reconnect solely because/);
  assert.equal(guide.match(/runnerProtocol/g)?.length, 1);
  assert.match(guide, /let pendingInputs = \[\]/);
  assert.match(guide, /let inputQueue = Promise\.resolve\(\)/);
  assert.match(guide, /let terminalClosed = false;\s+let activeGeneration;/);
  assert.match(
    guide,
    /const input = admitInput\(event\.data\);\s+if \(!input\) return;\s+inputQueue = inputQueue\.then\(\(\) => \{\s+if \(!inputIsActive\(input\)\) \{\s+releaseInputs\(\[input\]\);\s+return;\s+\}\s+return acceptInput\(input\);\s+\}\)/,
  );
  assert.doesNotMatch(guide, /\.then\(\(\) => acceptInput\(event\.data\)\)/);
  assert.match(
    guide,
    /if \(framed\) \{\s+if \(activeGeneration === undefined\) \{\s+activeGeneration = input\.generation;\s+\} else if \(input\.generation !== activeGeneration\) \{\s+sendAck\(input, false\);\s+return null;/,
  );
  assert.match(
    guide,
    /function inputIsActive\(input\) \{\s+return \(\s+!terminalClosed &&\s+terminal\.readyState === WebSocket\.OPEN &&\s+\(!framed \|\| input\.generation === activeGeneration\)/,
  );
  assert.match(
    guide,
    /function deactivateTerminal\(\) \{\s+if \(terminalClosed\) return;\s+terminalClosed = true;\s+activeGeneration = undefined;\s+rejectInputs\(takePendingInputs\(\), 1001, "terminal closed"\);\s+closeSteering\(\);/,
  );
  assert.match(guide, /terminal\.addEventListener\("close", deactivateTerminal\)/);
  assert.match(guide, /terminal\.addEventListener\("error", deactivateTerminal\)/);
  assert.match(guide, /pendingInputs\.push\(input\)/);
  assert.match(guide, /text = decodeCompleteUtf8\(payload\)/);
  assert.match(guide, /if \(text === null\) \{\s+armPendingInputTimer\(\);\s+return;/);
  assert.match(
    guide,
    /const inputs = takePendingInputs\(\);\s+try \{\s+await deliverSteeringInput\(text\);\s+settleInputs\(inputs, true\)/,
  );
  assert.match(guide, /catch \{\s+rejectInputs\(inputs, 1011, "steering rejected input"\);/);
  assert.match(guide, /const maxAdmittedInputBytes = 16 \* 1024/);
  assert.match(guide, /const maxAdmittedInputFrames = 32/);
  assert.match(guide, /const maxPendingInputAgeMs = 1_000/);
  assert.match(guide, /const nextBytes = admittedInputBytes \+ input\.payload\.byteLength/);
  assert.match(guide, /const nextFrames = admittedInputFrames \+ 1/);
  assert.match(guide, /nextBytes > maxAdmittedInputBytes/);
  assert.match(guide, /nextFrames > maxAdmittedInputFrames/);
  assert.match(guide, /if \(framed\) \{\s+sendAck\(input, false\);/);
  assert.match(guide, /terminal\.close\(1009, "input backlog exceeded"\)/);
  assert.match(guide, /function decodeRawInput\(data\)/);
  assert.match(guide, /typeof data === "string"/);
  assert.match(guide, /data instanceof ArrayBuffer/);
  assert.match(guide, /admittedInputBytes -= input\.payload\.byteLength/);
  assert.match(guide, /admittedInputFrames -= inputs\.length/);
  assert.match(guide, /clearTimeout\(pendingInputTimer\)/);
  assert.match(
    guide,
    /const inputs = pendingInputs;\s+pendingInputs = \[\];\s+pendingInputBytes = 0;\s+return inputs;/,
  );
  assert.match(guide, /new TextDecoder\("utf-8", \{ fatal: true, ignoreBOM: true \}\)/);
  assert.doesNotMatch(guide, /inputDecoder\.decode/);
  assert.match(guide, /subscribeSteeringOutput\(\(outputText\) => \{/);
  assert.match(guide, /encodeUtf8Output\(outputText\)/);
  assert.match(guide, /deliberately\s+a UTF-8 text\s+adapter/);
  assert.match(guide, /byte-oriented restricted steering adapter/);
  assert.match(guide, /Generation-fenced viewers add `viewerProtocol=cfr1-framed-io-v2`/);
  assert.match(guide, /stale-generation input is rejected before it\s+can reach/);
  assert.match(guide, /encodeAck\(input\.inputId, input\.generation, accepted\)/);
  assert.match(guide, /Legacy viewers omit that query/);
  assert.match(
    guide,
    /acknowledgement deadline expires\s+while the runner write may still be in flight[\s\S]*`input-delivery-unknown`, not\s+`input-rejected`, because that write may still complete/,
  );
  assert.match(
    guide,
    /\{"type":"input-delivery-unknown","error":"terminal input delivery outcome is unknown; the runner may still complete it"\}/,
  );
  assert.match(guide, /subscribeSteeringExit\(\(\) => \{/);
  assert.match(guide, /terminal\.close\(1000, "pty exited"\)/);
  assert.match(guide, /must never forward that input to a\s+shell or subprocess/);
  assert.doesNotMatch(guide, /spawn\(process\.env\.SHELL|env:\s*process\.env|pty\.write/);

  const messageHandler = guide.indexOf('terminal.addEventListener("message"');
  const admission = guide.indexOf("const input = admitInput(event.data);", messageHandler);
  const serialization = guide.indexOf("inputQueue = inputQueue.then(() => {", messageHandler);
  const activeCheck = guide.indexOf("if (!inputIsActive(input))", serialization);
  const deliveryAdmission = guide.indexOf("return acceptInput(input);", activeCheck);
  assert.ok(messageHandler >= 0);
  assert.ok(admission > messageHandler);
  assert.ok(serialization > admission);
  assert.ok(activeCheck > serialization);
  assert.ok(deliveryAdmission > activeCheck);

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
