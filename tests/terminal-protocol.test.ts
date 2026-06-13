import assert from "node:assert/strict";
import { test } from "node:test";
import {
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
} from "../src/terminal-protocol.ts";

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

test("terminal decoder rejects truncated and wrong-version frames", () => {
  assert.equal(decodeTerminalFrame(new Uint8Array([0x43, 0x59])), null);
  const encoded = encodeTerminalFrame({ type: TerminalMessageType.Ping });
  encoded[2] = 99;
  assert.equal(decodeTerminalFrame(encoded), null);
});

test("terminal subscribe and resize payloads use stable little-endian fields", () => {
  const subscribe = decodeSubscribePayload(
    encodeSubscribePayload({
      flags:
        TerminalSubscribeFlags.Output |
        TerminalSubscribeFlags.Events |
        TerminalSubscribeFlags.OutputAcknowledgements,
      snapshotMinIntervalMs: 100,
      snapshotMaxIntervalMs: 500,
    }),
  );
  assert.deepEqual(subscribe, {
    flags:
      TerminalSubscribeFlags.Output |
      TerminalSubscribeFlags.Events |
      TerminalSubscribeFlags.OutputAcknowledgements,
    snapshotMinIntervalMs: 100,
    snapshotMaxIntervalMs: 500,
    cols: null,
    rows: null,
  });

  assert.deepEqual(decodeResizePayload(encodeResizePayload(132, 43)), { cols: 132, rows: 43 });
  assert.equal(decodeAckPayload(encodeAckPayload(65_535)), 65_535);
});

test("terminal subscribe payloads can carry initial PTY size", () => {
  assert.deepEqual(
    decodeSubscribePayload(
      encodeSubscribePayload({
        flags: TerminalSubscribeFlags.Output,
        cols: 144,
        rows: 41,
      }),
    ),
    {
      flags: TerminalSubscribeFlags.Output,
      snapshotMinIntervalMs: 0,
      snapshotMaxIntervalMs: 0,
      cols: 144,
      rows: 41,
    },
  );
});

test("json payloads fit inside regular terminal frames", () => {
  const payload = encodeJsonPayload({ ok: true, version: 1 });
  const decoded = decodeTerminalFrame(
    encodeTerminalFrame({ type: TerminalMessageType.Welcome, payload }),
  );
  assert.equal(new TextDecoder().decode(decoded?.payload), '{"ok":true,"version":1}');
});
