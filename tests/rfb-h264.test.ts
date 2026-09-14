import assert from "node:assert/strict";
import test from "node:test";

import { annexBToLengthPrefixed, parseAnnexB } from "../src/app/rfb/annex-b.ts";
import { H264Decoder, avcDescription } from "../src/app/rfb/h264.ts";
import type { BrowserVideoFrame } from "../src/app/rfb/video.ts";

test("H.264 rendering exceptions reject decoding instead of stalling fallback", async () => {
  const previousDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  const previousChunk = Object.getOwnPropertyDescriptor(globalThis, "EncodedVideoChunk");
  let emit: ((frame: BrowserVideoFrame) => void) | undefined;
  class FakeDecoder {
    state = "unconfigured";
    constructor(callbacks: { output(frame: BrowserVideoFrame): void }) {
      emit = callbacks.output;
    }
    configure(): void {
      this.state = "configured";
    }
    decode(): void {}
    close(): void {
      this.state = "closed";
    }
  }
  Object.defineProperty(globalThis, "VideoDecoder", { configurable: true, value: FakeDecoder });
  Object.defineProperty(globalThis, "EncodedVideoChunk", { configurable: true, value: class {} });
  const decoder = new H264Decoder(
    () => {
      throw new Error("presentation failed");
    },
    () => {},
  );
  try {
    let closed = 0;
    const frame = {
      width: 4,
      height: 4,
      displayWidth: 4,
      displayHeight: 4,
      close: () => {
        closed += 1;
      },
    };
    const payload = new Uint8Array([
      0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 1,
    ]);
    const rejected = assert.rejects(decoder.decode(payload, 0), /presentation failed/);
    assert.doesNotThrow(() => emit!(frame));
    await rejected;
    assert.equal(closed, 1);
    decoder.close();
    emit!(frame);
    assert.equal(closed, 2, "late frames must be closed without presentation");
  } finally {
    decoder.close();
    if (previousDecoder) Object.defineProperty(globalThis, "VideoDecoder", previousDecoder);
    else Reflect.deleteProperty(globalThis, "VideoDecoder");
    if (previousChunk) Object.defineProperty(globalThis, "EncodedVideoChunk", previousChunk);
    else Reflect.deleteProperty(globalThis, "EncodedVideoChunk");
  }
});

test("Annex-B parser accepts three- and four-byte start codes", () => {
  const payload = new Uint8Array([
    0, 0, 0, 1, 0x67, 0x42, 0, 0x1f, 0xaa, 0, 0, 1, 0x68, 0xbb, 0, 0, 0, 1, 0x65, 1, 2, 3,
  ]);
  const units = parseAnnexB(payload, "h264");
  assert.deepEqual(
    units.map((unit) => unit.type),
    [7, 8, 5],
  );
  assert.deepEqual(
    [...annexBToLengthPrefixed(units)],
    [0, 0, 0, 5, 0x67, 0x42, 0, 0x1f, 0xaa, 0, 0, 0, 2, 0x68, 0xbb, 0, 0, 0, 4, 0x65, 1, 2, 3],
  );
});

test("AVC description carries SPS and PPS with four-byte NAL lengths", () => {
  const sps = new Uint8Array([0x67, 0x42, 0x80, 0x1f, 0xaa]);
  const pps = new Uint8Array([0x68, 0xbb]);
  assert.deepEqual(
    [...avcDescription(sps, pps)],
    [1, 0x42, 0x80, 0x1f, 0xff, 0xe1, 0, 5, ...sps, 1, 0, 2, ...pps],
  );
});

test("AVC description rejects parameter sets that do not fit its 16-bit lengths", () => {
  const sps = new Uint8Array([0x67, 0x42, 0, 0x1f]);
  const pps = new Uint8Array([0x68]);
  assert.throws(() => avcDescription(new Uint8Array(65_536), pps), /invalid H.264 parameter sets/);
  assert.throws(() => avcDescription(sps, new Uint8Array(65_536)), /invalid H.264 parameter sets/);
});

test("Annex-B parser rejects pathological NAL counts", () => {
  const payload = new Uint8Array(4 * 1_026);
  for (let offset = 0; offset < payload.byteLength; offset += 4) {
    payload.set([0, 0, 1, 0x09], offset);
  }
  assert.throws(() => parseAnnexB(payload, "h264"), /too many NAL units/);
});

test("H.264 leaves acceleration to the browser across SPS changes and fences retired callbacks", async (t) => {
  const previousDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  const previousChunk = Object.getOwnPropertyDescriptor(globalThis, "EncodedVideoChunk");
  t.after(() => {
    if (previousDecoder) Object.defineProperty(globalThis, "VideoDecoder", previousDecoder);
    else Reflect.deleteProperty(globalThis, "VideoDecoder");
    if (previousChunk) Object.defineProperty(globalThis, "EncodedVideoChunk", previousChunk);
    else Reflect.deleteProperty(globalThis, "EncodedVideoChunk");
  });
  const instances: FakeDecoder[] = [];
  class FakeDecoder {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    configuration: Record<string, unknown> | null = null;
    callbacks: { output(frame: BrowserVideoFrame): void; error(error: Error): void };
    constructor(callbacks: { output(frame: BrowserVideoFrame): void; error(error: Error): void }) {
      this.callbacks = callbacks;
      instances.push(this);
    }
    configure(configuration: Record<string, unknown>): void {
      assert.equal(
        configuration.hardwareAcceleration ?? "no-preference",
        "no-preference",
        "configuration must allow the browser to choose hardware or software decoding",
      );
      this.configuration = configuration;
      this.state = "configured";
    }
    decode(): void {}
    close(): void {
      this.state = "closed";
    }
  }
  Object.defineProperty(globalThis, "VideoDecoder", { configurable: true, value: FakeDecoder });
  Object.defineProperty(globalThis, "EncodedVideoChunk", { configurable: true, value: class {} });
  const errors: Error[] = [];
  const presented: BrowserVideoFrame[] = [];
  const decoder = new H264Decoder(
    (frame) => {
      presented.push(frame);
    },
    (error) => errors.push(error),
  );
  t.after(() => decoder.close());
  const sps = new Uint8Array([0x67, 0x42, 0, 0x1f, 0xaa]);
  const changed = new Uint8Array([0x67, 0x42, 0, 0x1f, 0xbb]);
  const pps = new Uint8Array([0x68, 0xbb]);
  const payload = (set: Uint8Array) =>
    new Uint8Array([0, 0, 1, ...set, 0, 0, 1, ...pps, 0, 0, 1, 0x65, 1]);
  let closed = 0;
  const frame = {
    width: 4,
    height: 4,
    displayWidth: 4,
    displayHeight: 4,
    close: () => {
      closed += 1;
    },
  };
  const first = decoder.decode(payload(sps), 0);
  instances[0]!.callbacks.output(frame);
  await first;
  const same = decoder.decode(payload(sps), 0);
  instances[0]!.callbacks.output(frame);
  await same;
  assert.equal(instances.length, 1);
  const resized = decoder.decode(payload(changed), 0);
  assert.equal(instances.length, 2);
  assert.equal(instances[0]!.state, "closed");
  assert.deepEqual(instances[1]!.configuration?.description, avcDescription(changed, pps));
  instances[0]!.callbacks.output(frame);
  instances[0]!.callbacks.error(new Error("old decoder failure"));
  assert.equal(closed, 1);
  assert.deepEqual(errors, []);
  instances[1]!.callbacks.output(frame);
  await resized;
  assert.equal(presented.length, 3, "retired decoder must not consume the new frame's completion");
});
