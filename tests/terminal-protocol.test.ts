import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  TERMINAL_WS_MAGIC,
  TERMINAL_WS_VERSION,
  TerminalMessageType,
  TerminalSubscribeFlags,
  decodeAckPayload,
  decodeResizePayload,
  decodeSubscribePayload,
  decodeTerminalFrame,
  encodeAckPayload,
  encodeJsonPayload,
  encodeResizePayload,
  encodeSubscribePayload,
  encodeTerminalFrame,
  tryDecodeTerminalFrame,
} from "@openclaw/libterminal/protocol";

type TerminalProtocolFixture = {
  magic: number;
  version: number;
  messages: typeof TerminalMessageType;
  subscribeFlags: typeof TerminalSubscribeFlags;
  vectors: {
    outputFrame: string;
    pingFrame: string;
    subscribe: string;
    resize: string;
    ack: string;
  };
};

const fixture = JSON.parse(
  readFileSync(new URL("../protocol/terminal-v2.json", import.meta.url), "utf8"),
) as TerminalProtocolFixture;
const sharedFixture = JSON.parse(
  readFileSync(
    new URL(import.meta.resolve("@openclaw/libterminal/protocol/terminal-v2.json")),
    "utf8",
  ),
) as TerminalProtocolFixture;
const hex = (value: Uint8Array): string => Buffer.from(value).toString("hex");

test("TypeScript terminal constants and encoders match the shared v2 protocol", () => {
  assert.deepEqual(fixture, sharedFixture);
  assert.equal(TERMINAL_WS_MAGIC, fixture.magic);
  assert.equal(TERMINAL_WS_VERSION, fixture.version);
  assert.deepEqual(TerminalMessageType, fixture.messages);
  assert.deepEqual(TerminalSubscribeFlags, fixture.subscribeFlags);
  assert.equal(
    hex(
      encodeTerminalFrame({
        type: TerminalMessageType.Output,
        sessionId: "IS-123",
        payload: new Uint8Array([0, 1, 2, 255]),
      }),
    ),
    fixture.vectors.outputFrame,
  );
  assert.equal(
    hex(encodeTerminalFrame({ type: TerminalMessageType.Ping })),
    fixture.vectors.pingFrame,
  );
  assert.equal(
    hex(
      encodeSubscribePayload({
        flags:
          TerminalSubscribeFlags.Output |
          TerminalSubscribeFlags.Events |
          TerminalSubscribeFlags.OutputAcknowledgements,
        columns: 144,
        rows: 41,
      }),
    ),
    fixture.vectors.subscribe,
  );
  assert.equal(hex(encodeResizePayload({ columns: 132, rows: 43 })), fixture.vectors.resize);
  assert.equal(hex(encodeAckPayload(65_535)), fixture.vectors.ack);
});

test("terminal frames round-trip binary payloads and session ids", () => {
  const payload = new Uint8Array([0, 1, 2, 255]);
  const encoded = encodeTerminalFrame({
    type: TerminalMessageType.Output,
    sessionId: "IS-123",
    payload,
  });

  const decoded = decodeTerminalFrame(encoded);
  assert.deepEqual(decoded, {
    type: TerminalMessageType.Output,
    sessionId: "IS-123",
    payload,
  });
});

test("terminal decoder rejects truncated, trailing, and wrong-version frames", () => {
  assert.equal(tryDecodeTerminalFrame(new Uint8Array([0x43, 0x59])), null);
  const encoded = encodeTerminalFrame({ type: TerminalMessageType.Ping });
  encoded[2] = 99;
  assert.equal(tryDecodeTerminalFrame(encoded), null);
  const wrongType = encodeTerminalFrame({ type: TerminalMessageType.Ping });
  wrongType[3] = 99;
  assert.equal(tryDecodeTerminalFrame(wrongType), null);
  assert.equal(
    tryDecodeTerminalFrame(
      Uint8Array.from([...encodeTerminalFrame({ type: TerminalMessageType.Ping }), 0]),
    ),
    null,
  );
});

test("terminal subscribe and resize payloads use one exact little-endian shape", () => {
  const subscribe = decodeSubscribePayload(
    encodeSubscribePayload({
      flags:
        TerminalSubscribeFlags.Output |
        TerminalSubscribeFlags.Events |
        TerminalSubscribeFlags.OutputAcknowledgements,
      snapshotMinIntervalMs: 100,
      snapshotMaxIntervalMs: 500,
      columns: 0,
      rows: 0,
    }),
  );
  assert.deepEqual(subscribe, {
    flags:
      TerminalSubscribeFlags.Output |
      TerminalSubscribeFlags.Events |
      TerminalSubscribeFlags.OutputAcknowledgements,
    snapshotMinIntervalMs: 100,
    snapshotMaxIntervalMs: 500,
    columns: 0,
    rows: 0,
  });

  assert.deepEqual(decodeResizePayload(encodeResizePayload({ columns: 132, rows: 43 })), {
    columns: 132,
    rows: 43,
  });
  assert.equal(decodeAckPayload(encodeAckPayload(65_535)), 65_535);
  assert.throws(() => decodeSubscribePayload(new Uint8Array(12)));
  assert.throws(() => decodeSubscribePayload(new Uint8Array(21)));
  assert.throws(() => decodeResizePayload(new Uint8Array(9)));
  assert.throws(() => decodeAckPayload(new Uint8Array(5)));
});

test("terminal subscribe payloads carry initial PTY size", () => {
  assert.deepEqual(
    decodeSubscribePayload(
      encodeSubscribePayload({
        flags: TerminalSubscribeFlags.Output,
        columns: 144,
        rows: 41,
      }),
    ),
    {
      flags: TerminalSubscribeFlags.Output,
      snapshotMinIntervalMs: 0,
      snapshotMaxIntervalMs: 0,
      columns: 144,
      rows: 41,
    },
  );
});

test("json payloads fit inside regular terminal frames", () => {
  const payload = encodeJsonPayload({ ok: true, version: 2 });
  const decoded = decodeTerminalFrame(
    encodeTerminalFrame({ type: TerminalMessageType.Welcome, payload }),
  );
  assert.equal(new TextDecoder().decode(decoded?.payload), '{"ok":true,"version":2}');
});
