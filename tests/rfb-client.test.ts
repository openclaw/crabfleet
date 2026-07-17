import assert from "node:assert/strict";
import test from "node:test";

import {
  RFBClient,
  RFB_ENCODINGS,
  decodeClipboardProvide,
  encodeQualityControl,
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
    [201, 1, 0, 0],
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
      RFB_ENCODINGS.qualityControl,
      RFB_ENCODINGS.cursorWithAlpha,
      RFB_ENCODINGS.pointerPosition,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
  assert.equal(transport.sent[4]?.[0], 6, "client advertises extended clipboard caps");
  assert.deepEqual(transport.sent[5], framebufferRequest(false, 1280, 720));
  assert.deepEqual(transport.sent[6], framebufferRequest(true, 1280, 720));
});

test("H.264 decode failure renegotiates Tight and requests a full JPEG frame", async () => {
  const name = new TextEncoder().encode("Studio");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [0, 0, 0, 1],
    uint16(0),
    uint16(0),
    uint16(800),
    uint16(600),
    uint32(RFB_ENCODINGS.openH264),
    uint32(3),
    uint32(0),
    [0, 0, 1],
    [0, 0, 0, 1],
    uint16(0),
    uint16(0),
    uint16(800),
    uint16(600),
    uint32(RFB_ENCODINGS.tight),
    [0x90, 2, 0xff, 0xd8],
  );
  const transport = new ScriptedTransport(transcript);
  const frames: string[] = [];
  const states: string[] = [];
  const client = new RFBClient(transport, {
    h264: true,
    onState: (state) => states.push(state),
    onFrame: (frame) => {
      frames.push(frame.encoding);
      if (frame.encoding === "h264") throw new Error("profile unsupported");
    },
  });

  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(frames, ["h264", "jpeg"]);
  assert.ok(states.includes("H.264 unavailable; switching to JPEG / Tight"));
  assert.deepEqual(
    transport.sent[6],
    encodeSetEncodings([
      RFB_ENCODINGS.tight,
      RFB_ENCODINGS.qualityControl,
      RFB_ENCODINGS.cursorWithAlpha,
      RFB_ENCODINGS.pointerPosition,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
  assert.deepEqual(transport.sent[7], framebufferRequest(false, 800, 600));
  assert.deepEqual(transport.sent[8], framebufferRequest(true, 800, 600));
});

test("capability handshake advertises HEVC, C444, and CAF1 only when probed", async () => {
  const name = new TextEncoder().encode("Studio");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [201, 1, 0, 0],
  );
  const transport = new ScriptedTransport(transcript);
  const client = new RFBClient(transport, {
    hevc: true,
    h264: true,
    chroma444: true,
    audio: true,
    qualityMode: "sharp",
  });
  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(
    transport.sent[3],
    encodeSetEncodings([
      RFB_ENCODINGS.hevc,
      RFB_ENCODINGS.chroma444,
      RFB_ENCODINGS.openH264,
      RFB_ENCODINGS.tight,
      RFB_ENCODINGS.audio,
      RFB_ENCODINGS.qualityControl,
      RFB_ENCODINGS.cursorWithAlpha,
      RFB_ENCODINGS.pointerPosition,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
  assert.deepEqual(transport.sent[6], encodeQualityControl("sharp"));
});

test("QCTL waits for a valid server acknowledgement", async () => {
  const name = new TextEncoder().encode("Legacy host");
  const legacy = new ScriptedTransport(
    bytes(
      new TextEncoder().encode("RFB 003.008\n"),
      [1, 1],
      uint32(0),
      uint16(800),
      uint16(600),
      new Uint8Array(16),
      uint32(name.byteLength),
      name,
    ),
  );
  await assert.rejects(
    new RFBClient(legacy, { h264: false, qualityMode: "smooth" }).start(),
    /scripted server ended/,
  );
  assert.equal(
    legacy.sent.some((frame) => frame[0] === 201),
    false,
  );

  const malformed = new ScriptedTransport(
    bytes(
      new TextEncoder().encode("RFB 003.008\n"),
      [1, 1],
      uint32(0),
      uint16(800),
      uint16(600),
      new Uint8Array(16),
      uint32(name.byteLength),
      name,
      [201, 2, 0, 0],
    ),
  );
  await assert.rejects(
    new RFBClient(malformed, { h264: false, qualityMode: "sharp" }).start(),
    /invalid QCTL capability acknowledgement/,
  );
});

test("HEVC and H.264 failures renegotiate down the codec chain while retaining CAF1", async () => {
  const name = new TextEncoder().encode("Studio");
  const videoUpdate = (encoding: number) =>
    bytes(
      [0, 0],
      uint16(1),
      uint16(0),
      uint16(0),
      uint16(800),
      uint16(600),
      uint32(encoding),
      uint32(3),
      uint32(0),
      [0, 0, 1],
    );
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    videoUpdate(RFB_ENCODINGS.hevc),
    videoUpdate(RFB_ENCODINGS.openH264),
    [0, 0, 0, 1],
    uint16(0),
    uint16(0),
    uint16(800),
    uint16(600),
    uint32(RFB_ENCODINGS.tight),
    [0x90, 2, 0xff, 0xd8],
  );
  const transport = new ScriptedTransport(transcript);
  const frames: string[] = [];
  const client = new RFBClient(transport, {
    hevc: true,
    h264: true,
    audio: true,
    onFrame: (frame) => {
      frames.push(frame.encoding);
      if (frame.encoding !== "jpeg") throw new Error("decoder failed");
    },
  });
  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(frames, ["hevc", "h264", "jpeg"]);
  assert.deepEqual(
    transport.sent[6],
    encodeSetEncodings([
      RFB_ENCODINGS.openH264,
      RFB_ENCODINGS.tight,
      RFB_ENCODINGS.audio,
      RFB_ENCODINGS.qualityControl,
      RFB_ENCODINGS.cursorWithAlpha,
      RFB_ENCODINGS.pointerPosition,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
  assert.deepEqual(
    transport.sent[8],
    encodeSetEncodings([
      RFB_ENCODINGS.tight,
      RFB_ENCODINGS.audio,
      RFB_ENCODINGS.qualityControl,
      RFB_ENCODINGS.cursorWithAlpha,
      RFB_ENCODINGS.pointerPosition,
      RFB_ENCODINGS.extendedDesktopSize,
      RFB_ENCODINGS.extendedClipboard,
    ]),
  );
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
    RFB_ENCODINGS.cursorWithAlpha,
    RFB_ENCODINGS.pointerPosition,
    RFB_ENCODINGS.extendedDesktopSize,
    RFB_ENCODINGS.extendedClipboard,
  ]);
  assert.equal(new DataView(encoded.buffer).getInt32(12), -314);
  assert.equal(new DataView(encoded.buffer).getInt32(16), -232);
  assert.equal(new DataView(encoded.buffer).getInt32(20), -308);
  assert.equal(new DataView(encoded.buffer).getUint32(24), 0xc0a1e5ce);
});

test("QCTL quality messages use the strict four-byte wire format", () => {
  assert.deepEqual(encodeQualityControl("auto"), new Uint8Array([201, 0, 0, 0]));
  assert.deepEqual(encodeQualityControl("sharp"), new Uint8Array([201, 1, 0, 0]));
  assert.deepEqual(encodeQualityControl("smooth"), new Uint8Array([201, 2, 0, 0]));
});

test("browser parses host CursorWithAlpha and PointerPos fixtures", async () => {
  const name = new TextEncoder().encode("Studio");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(2),
    uint16(1),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [
      0, 0, 0, 1, 0, 1, 0, 0, 0, 2, 0, 1, 0xff, 0xff, 0xfe, 0xc6, 0, 0, 0, 0, 0x11, 0x22, 0x33,
      0xff, 0x20, 0x10, 0x08, 0x80,
    ],
    [0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0x18],
  );
  const transport = new ScriptedTransport(transcript);
  const cursors: unknown[] = [];
  const positions: unknown[] = [];
  const client = new RFBClient(transport, {
    h264: false,
    onCursor: (cursor) => cursors.push(cursor),
    onPointerPosition: (position) => positions.push(position),
  });

  await assert.rejects(client.start(), /scripted server ended/);
  assert.deepEqual(cursors, [
    {
      width: 2,
      height: 1,
      hotspotX: 1,
      hotspotY: 0,
      rgba: new Uint8Array([0x11, 0x22, 0x33, 0xff, 0x20, 0x10, 0x08, 0x80]),
    },
  ]);
  assert.deepEqual(positions, [{ x: 1, y: 0 }]);
});

test("browser fails the session on malformed cursor bounds", async () => {
  const name = new TextEncoder().encode("Studio");
  const transcript = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(2),
    uint16(1),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [0, 0, 0, 1, 0, 0, 0, 0, 0, 129, 0, 1, 0xff, 0xff, 0xfe, 0xc6, 0, 0, 0, 0],
  );
  const transport = new ScriptedTransport(transcript);
  const client = new RFBClient(transport, { h264: false });

  await assert.rejects(client.start(), /invalid CursorWithAlpha rectangle/);
  assert.deepEqual(transport.closed, { code: 1002, reason: "RFB protocol error" });

  const invalidPixels = bytes(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(2),
    uint16(1),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
    [0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 1, 0xff, 0xff, 0xfe, 0xc6, 0, 0, 0, 0, 1, 0, 0, 0],
  );
  const pixelTransport = new ScriptedTransport(invalidPixels);
  const pixelClient = new RFBClient(pixelTransport, { h264: false });
  await assert.rejects(pixelClient.start(), /invalid premultiplied CursorWithAlpha pixels/);
  assert.deepEqual(pixelTransport.closed, { code: 1002, reason: "RFB protocol error" });
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

test("legacy clipboard fallback rejects text over 1 MiB", async () => {
  const transport = new ScriptedTransport(new Uint8Array());
  const client = new RFBClient(transport, { h264: false });
  await assert.rejects(client.sendClipboardText("x".repeat(1_048_577)), /exceeds 1 MiB/);
  assert.equal(transport.sent.length, 0);
});

test("remote clipboard reads expose only snapshots approved by explicit sends", async () => {
  const name = new TextEncoder().encode("Studio");
  const transport = new InteractiveTransport();
  transport.append(
    new TextEncoder().encode("RFB 003.008\n"),
    [1, 1],
    uint32(0),
    uint16(800),
    uint16(600),
    new Uint8Array(16),
    uint32(name.byteLength),
    name,
  );
  const client = new RFBClient(transport, { h264: false });
  const running = client.start();
  await waitForSent(transport, 6);

  transport.append(serverClipboardAction((1 << 25) | 1));
  await waitForSent(transport, 7);
  assert.equal(await clipboardResponseText(transport.sent[6]!), "");

  transport.append(serverClipboardAction(1 << 26));
  await waitForSent(transport, 8);
  assert.equal(clipboardNotifyHasText(transport.sent[7]!), false);

  let draft = "approved text";
  await client.sendClipboardText(draft);
  draft = "edited but not sent";
  transport.append(serverClipboardAction((1 << 25) | 1));
  await waitForSent(transport, 10);
  assert.equal(await clipboardResponseText(transport.sent[9]!), "approved text");

  transport.append(serverClipboardAction(1 << 26));
  await waitForSent(transport, 11);
  assert.equal(clipboardNotifyHasText(transport.sent[10]!), true);

  await client.sendClipboardText(draft);
  transport.append(serverClipboardAction((1 << 25) | 1));
  await waitForSent(transport, 13);
  assert.equal(await clipboardResponseText(transport.sent[12]!), "edited but not sent");

  transport.end();
  await assert.rejects(running, /scripted server ended/);
});

test("rejected clipboard text is not approved for later remote requests", async () => {
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
    onClipboardError: (message) => clipboardErrors.push(message),
  });
  await assert.rejects(client.sendClipboardText("x".repeat(1_048_577)), /exceeds 1 MiB/);
  await assert.rejects(client.start(), /scripted server ended/);
  const response = transport.sent.filter((message) => message[0] === 6).at(-1);
  assert.ok(response);
  assert.equal(await clipboardResponseText(response), "");
  assert.deepEqual(clipboardErrors, []);
  assert.deepEqual(transport.sent.at(-1), framebufferRequest(true, 800, 600));
});

class ScriptedTransport implements RFBTransport {
  readonly sent: Uint8Array[] = [];
  closed: { code?: number; reason?: string } | undefined;
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

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

class InteractiveTransport implements RFBTransport {
  readonly sent: Uint8Array[] = [];
  #incoming = new Uint8Array();
  #ended = false;
  #pending:
    | {
        count: number;
        resolve: (value: Uint8Array) => void;
        reject: (error: Error) => void;
      }
    | undefined;

  append(...parts: Array<Uint8Array | number[]>): void {
    this.#incoming = bytes(this.#incoming, ...parts);
    this.#drain();
  }

  end(): void {
    this.#ended = true;
    this.#drain();
  }

  readExactly(count: number): Promise<Uint8Array> {
    assert.equal(this.#pending, undefined);
    return new Promise((resolve, reject) => {
      this.#pending = { count, resolve, reject };
      this.#drain();
    });
  }

  send(data: Uint8Array): void {
    this.sent.push(data.slice());
  }

  close(): void {
    this.end();
  }

  #drain(): void {
    const pending = this.#pending;
    if (!pending) return;
    if (this.#incoming.byteLength >= pending.count) {
      const result = this.#incoming.slice(0, pending.count);
      this.#incoming = this.#incoming.slice(pending.count);
      this.#pending = undefined;
      pending.resolve(result);
    } else if (this.#ended) {
      this.#pending = undefined;
      pending.reject(new Error("scripted server ended"));
    }
  }
}

function serverClipboardAction(flags: number): Uint8Array {
  const body = uint32(flags);
  return bytes([3, 0, 0, 0], uint32(-body.byteLength), body);
}

async function clipboardResponseText(frame: Uint8Array): Promise<string | null> {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const length = view.getInt32(4);
  if (length >= 0) return new TextDecoder("latin1").decode(frame.subarray(8, 8 + length));
  const body = frame.subarray(8, 8 - length);
  assert.equal(
    new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0),
    (1 << 28) | 1,
  );
  return await decodeClipboardProvide(body.subarray(4));
}

function clipboardNotifyHasText(frame: Uint8Array): boolean {
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  assert.equal(view.getInt32(4), -4);
  const flags = view.getUint32(8);
  assert.equal(flags & 0xff000000, 1 << 27);
  return Boolean(flags & 1);
}

async function waitForSent(transport: InteractiveTransport, count: number): Promise<void> {
  for (let attempt = 0; attempt < 100 && transport.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(transport.sent.length, count);
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
