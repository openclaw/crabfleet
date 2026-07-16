import assert from "node:assert/strict";
import test from "node:test";

import {
  RFBClient,
  RFB_ENCODINGS,
  encodeSetEncodings,
  encodeTightCompactLength,
  readBoundedStream,
  readTightCompactLength,
  type RFBTransport,
} from "../src/app/rfb/client.ts";

test("RFB 3.8 handshake records exact client bytes and paces empty updates", async () => {
  const name = new TextEncoder().encode("Studio Mac");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(1280),
    uint16(720),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [0, 0, 0, 0],
  );
  const transport = new ScriptedTransport(transcript);
  const initialized: unknown[] = [];
  const client = new RFBClient(transport, {
    h264: true,
    onServerInit: (info) => initialized.push(info),
  });

  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(initialized, [{ width: 1280, height: 720, name: "Studio Mac", codec: "H.264" }]);
  assert.deepEqual(transport.sent[0], new TextEncoder().encode("RFB 003.008\n"));
  assert.deepEqual(transport.sent[1], new Uint8Array([1]));
  assert.deepEqual(transport.sent[2], new Uint8Array([1]));
  assert.deepEqual(
    transport.sent[3],
    encodeSetEncodings([
      RFB_ENCODINGS.openH264,
      RFB_ENCODINGS.tight,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
  assert.equal(transport.sent[4]?.[0], 6, "client advertises extended clipboard caps");
  assert.deepEqual(transport.sent[5], framebufferRequest(false, 1280, 720));
  assert.deepEqual(transport.sent[6], framebufferRequest(true, 1280, 720));
});

test("Tight compact lengths round-trip at every byte boundary", async () => {
  for (const length of [0, 1, 0x7f, 0x80, 0x3fff, 0x4000, (1 << 22) - 1]) {
    const encoded = encodeTightCompactLength(length);
    const transport = new ScriptedTransport(encoded);
    assert.equal(await readTightCompactLength(transport), length);
  }
  assert.throws(() => encodeTightCompactLength(1 << 22), /invalid Tight length/);
});

test("SetEncodings preserves signed pseudo-encoding words", () => {
  const encoded = encodeSetEncodings([
    RFB_ENCODINGS.openH264,
    RFB_ENCODINGS.tight,
    RFB_ENCODINGS.extendedDesktopSize,
    RFB_ENCODINGS.extendedClipboard,
  ]);
  assert.equal(new DataView(encoded.buffer).getInt32(12), -308);
  assert.equal(new DataView(encoded.buffer).getUint32(16), 0xc0a1e5ce);
});

test("resize waits for ExtendedDesktopSize and preserves the host screen identity", async () => {
  const name = new TextEncoder().encode("Studio");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(1280),
    uint16(720),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [0, 0, 0, 1],
    uint16(0),
    uint16(0),
    uint16(1280),
    uint16(720),
    uint32(RFB_ENCODINGS.extendedDesktopSize),
    [1, 0, 0, 0],
    uint32(42),
    uint16(0),
    uint16(0),
    uint16(1280),
    uint16(720),
    uint32(0x20),
  );
  const transport = new ScriptedTransport(transcript);
  const client = new RFBClient(transport, { h264: false });
  client.resize(800, 600);
  assert.equal(transport.sent.length, 0);
  await assert.rejects(client.start(), /scripted server ended/);
  const resize = transport.sent.find((message) => message[0] === 251);
  assert.ok(resize);
  const view = new DataView(resize.buffer, resize.byteOffset, resize.byteLength);
  assert.equal(view.getUint32(8), 42);
  assert.equal(view.getUint16(16), 800);
  assert.equal(view.getUint16(18), 600);
  assert.equal(view.getUint32(20), 0x20);
});

test("extended clipboard inflation aborts before materializing oversized output", async () => {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(8));
      controller.enqueue(new Uint8Array(8));
      controller.close();
    },
  });
  await assert.rejects(readBoundedStream(readable, 10), /exceeds 1 MiB/);
});

test("extended clipboard Request receives Provide regardless of unsolicited maximum", async () => {
  const name = new TextEncoder().encode("Studio");
  const requestBody = uint32((1 << 25) | 1);
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [3, 0, 0, 0],
    uint32(-requestBody.byteLength),
    requestBody,
  );
  const transport = new ScriptedTransport(transcript);
  const client = new RFBClient(transport, {
    h264: false,
    readClipboard: async () => "hello 🦀",
  });
  await assert.rejects(client.start(), /scripted server ended/);
  const response = transport.sent.filter((message) => message[0] === 6).at(-1);
  assert.ok(response);
  const view = new DataView(response.buffer, response.byteOffset, response.byteLength);
  assert.ok(view.getInt32(4) < 0);
  assert.equal(view.getUint32(8), (1 << 28) | 1);
});

test("clipboard transfer errors do not terminate framebuffer processing", async () => {
  const name = new TextEncoder().encode("Studio");
  const requestBody = uint32((1 << 25) | 1);
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [3, 0, 0, 0],
    uint32(-requestBody.byteLength),
    requestBody,
    [0, 0, 0, 0],
  );
  const transport = new ScriptedTransport(transcript);
  const clipboardErrors: string[] = [];
  const client = new RFBClient(transport, {
    h264: false,
    readClipboard: async () => "x".repeat(1_048_576),
    onClipboardError: (message) => clipboardErrors.push(message),
  });
  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(clipboardErrors, ["clipboard text exceeds 1 MiB"]);
  assert.deepEqual(transport.sent.at(-1), framebufferRequest(true, 800, 600));
});

class ScriptedTransport implements RFBTransport {
  readonly sent: Uint8Array[] = [];
  #incoming: Uint8Array;
  #offset = 0;

  constructor(incoming: Uint8Array) {
    this.#incoming = incoming;
  }

  async readExactly(count: number): Promise<Uint8Array> {
    if (this.#offset + count > this.#incoming.byteLength) throw new Error("scripted server ended");
    const result = this.#incoming.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return result;
  }

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(): void {}
}

function framebufferRequest(incremental: boolean, width: number, height: number): Uint8Array {
  return bytes([3, incremental ? 1 : 0], uint16(0), uint16(0), uint16(width), uint16(height));
}

function uint16(value: number): Uint8Array {
  const result = new Uint8Array(2);
  new DataView(result.buffer).setUint16(0, value);
  return result;
}

function uint32(value: number): Uint8Array {
  const result = new Uint8Array(4);
  new DataView(result.buffer).setUint32(0, value);
  return result;
}

function bytes(...parts: Array<Uint8Array | number[]>): Uint8Array {
  const arrays = parts.map((part) => new Uint8Array(part));
  const result = new Uint8Array(arrays.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}
