import assert from "node:assert/strict";
import test from "node:test";

import { AnnexBDecodeGate, accessUnits, parseAnnexB } from "../src/app/rfb/annex-b.ts";
import {
  HEVCDecoder,
  hevcCodecString,
  hevcDescription,
  hevcSampleUnits,
  hevcUnits,
} from "../src/app/rfb/hevc.ts";

test("HEVC decoder resets and requests an IRAP after queue saturation", async (t) => {
  type Callbacks = {
    output(frame: {
      width: number;
      height: number;
      displayWidth: number;
      displayHeight: number;
      close(): void;
    }): void;
    error(error: Error): void;
  };
  const submitted: unknown[] = [];
  let refreshes = 0;
  const videoDecoder = Object.getOwnPropertyDescriptor(globalThis, "VideoDecoder");
  const encodedVideoChunk = Object.getOwnPropertyDescriptor(globalThis, "EncodedVideoChunk");
  t.after(() => {
    restoreGlobal("VideoDecoder", videoDecoder);
    restoreGlobal("EncodedVideoChunk", encodedVideoChunk);
  });
  class FakeVideoDecoder {
    state: "unconfigured" | "configured" | "closed" = "unconfigured";
    decodeQueueSize = 0;
    constructor(_value: Callbacks) {}
    configure(): void {
      this.state = "configured";
    }
    decode(chunk: unknown): void {
      submitted.push(chunk);
      this.decodeQueueSize += 1;
    }
    close(): void {
      this.state = "closed";
    }
    static async isConfigSupported(): Promise<{ supported: boolean }> {
      return { supported: true };
    }
  }
  class FakeEncodedVideoChunk {
    readonly init: unknown;
    constructor(init: unknown) {
      this.init = init;
    }
  }
  Object.defineProperty(globalThis, "VideoDecoder", {
    value: FakeVideoDecoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "EncodedVideoChunk", {
    value: FakeEncodedVideoChunk,
    configurable: true,
  });

  const decoder = new HEVCDecoder(
    () => {},
    () => {},
    () => (refreshes += 1),
  );
  const completion = decoder.decode(
    annexBPayload(
      hevcVps(0),
      makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0),
      hevcPps(0, 0),
      hevcNal(19),
      hevcNal(1),
      hevcNal(1),
      hevcNal(1),
      hevcNal(1),
    ),
    0,
  );
  await completion;
  assert.equal(submitted.length, 4);
  assert.equal(refreshes, 1);
  decoder.close();
});

test("shared Annex-B parser applies per-codec NAL typing", () => {
  const payload = new Uint8Array([0, 0, 1, 0x42, 1, 0x80, 0, 0, 0, 1, 0x26, 1, 0x80]);
  assert.deepEqual(
    parseAnnexB(payload, "h264").map((unit) => unit.type),
    [2, 6],
  );
  assert.deepEqual(
    parseAnnexB(payload, "hevc").map((unit) => unit.type),
    [33, 19],
  );
});

test("shared Annex-B parser strips legal trailing_zero_8bits", () => {
  const payload = new Uint8Array([0, 0, 1, 0x42, 1, 0x80, 0, 0, 0, 0, 1, 0x26, 1, 0x80, 0, 0]);
  assert.deepEqual(
    parseAnnexB(payload, "hevc").map((unit) => [...unit.data]),
    [
      [0x42, 1, 0x80],
      [0x26, 1, 0x80],
    ],
  );
});

test("hvcC derives Main profile, compatibility, constraints, and level from SPS", () => {
  const vps = hevcVps(0);
  const sps = makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0);
  const pps = hevcPps(0, 0);
  const description = hevcDescription([vps], [sps], [pps]);
  assert.deepEqual(
    [...description.subarray(0, 13)],
    [1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 120],
  );
  assert.equal(description[16]! & 0x03, 1);
  assert.equal(description[17]! & 0x07, 0);
  assert.equal(description[18]! & 0x07, 0);
  assert.equal(description[22], 3);
  assert.equal(description[23]! & 0x3f, 32);
  assert.equal(hevcCodecString(sps), "hvc1.1.6.L120.90");
});

test("hvcC derives RExt 4:4:4 profile and bit depth from actual SPS", () => {
  const vps = hevcVps(0);
  const sps = makeSps(0x04, [0x08, 0, 0, 0], [0x9c, 0, 0, 0, 0, 0], 120, 3, 2, 2);
  const pps = hevcPps(0, 0);
  const description = hevcDescription([vps], [sps], [pps]);
  assert.equal(description[1]! & 0x1f, 4);
  assert.deepEqual([...description.subarray(2, 12)], [0x08, 0, 0, 0, 0x9c, 0, 0, 0, 0, 0]);
  assert.equal(description[16]! & 0x03, 3);
  assert.equal(description[17]! & 0x07, 2);
  assert.equal(description[18]! & 0x07, 2);
  assert.equal(hevcCodecString(sps), "hvc1.4.10.L120.9c");
});

test("HEVC codec strings dot-delimit multiple constraint bytes", () => {
  const sps = makeSps(0x04, [0x08, 0, 0, 0], [0x9c, 0x80, 0, 0, 0, 0], 120, 3, 2, 2);
  assert.equal(hevcCodecString(sps), "hvc1.4.10.L120.9c.80");
});

test("hvcC accepts SPS sub-layer profile data", () => {
  const sps = makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0, true);
  assert.equal(hevcCodecString(sps), "hvc1.1.6.L120.90");
});

test("hvcC preserves multiple parameter sets in each complete array", () => {
  const vps = [hevcVps(0), hevcVps(1)];
  const sps = [
    makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0),
    makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0, false, 1),
  ];
  const pps = [hevcPps(0, 0), hevcPps(1, 1)];
  const description = hevcDescription(vps, sps, pps);
  assert.deepEqual(hvcCArrayCounts(description), [2, 2, 2]);
});

test("hvcC rejects parameter sets that do not fit its 16-bit lengths", () => {
  const sps = makeSps(0x01, [0x60, 0, 0, 0], [0x90, 0, 0, 0, 0, 0], 120, 1, 0, 0);
  assert.throws(
    () => hevcDescription([new Uint8Array(65_536)], [sps], [hevcPps(0, 0)]),
    /invalid HEVC parameter sets/,
  );
});

test("HEVC recovery gate accepts IRAP and suppresses RASL after non-IDR IRAP", () => {
  const gate = new AnnexBDecodeGate("hevc");
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(1)])), false);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(21)])), true);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(8)])), false);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(9)])), false);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(1)])), true);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(8)])), true);

  for (const type of [16, 19, 20]) {
    gate.reset();
    assert.equal(gate.shouldDecode(hevcUnits([hevcNal(type)])), true);
  }
});

test("HEVC recovery gate keeps RASL suppression across RADL pictures", () => {
  const gate = new AnnexBDecodeGate("hevc");
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(21)])), true);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(6)])), true);
  assert.equal(gate.suppressingRasl, true);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(8)])), false);
  assert.equal(gate.shouldDecode(hevcUnits([hevcNal(1)])), true);
  assert.equal(gate.suppressingRasl, false);
});

test("HEVC access-unit grouping keeps suffix NALs with the preceding picture", () => {
  const first = hevcNal(19, [0x80]);
  const continuation = hevcNal(19, [0]);
  const suffix = hevcNal(40, [0]);
  const reservedSuffix = hevcNal(45, [0]);
  const unspecifiedSuffix = hevcNal(56, [0]);
  const next = hevcNal(1, [0x80]);
  assert.deepEqual(
    accessUnits(
      hevcUnits([first, continuation, suffix, reservedSuffix, unspecifiedSuffix, next]),
      "hevc",
    ),
    [
      hevcUnits([first, continuation, suffix, reservedSuffix, unspecifiedSuffix]),
      hevcUnits([next]),
    ],
  );
});

test("hvc1 samples keep picture suffixes but exclude in-band parameter sets and filler", () => {
  const units = hevcUnits([
    hevcNal(32),
    hevcNal(33),
    hevcNal(34),
    hevcNal(19),
    hevcNal(38),
    hevcNal(40),
  ]);
  assert.deepEqual(
    hevcSampleUnits(units).map((unit) => unit.type),
    [19, 40],
  );
});

function hvcCArrayCounts(description: Uint8Array): number[] {
  const view = new DataView(description.buffer, description.byteOffset, description.byteLength);
  const counts: number[] = [];
  let offset = 23;
  for (let index = 0; index < description[22]!; index += 1) {
    const count = view.getUint16(offset + 1);
    counts.push(count);
    offset += 3;
    for (let unit = 0; unit < count; unit += 1) {
      const length = view.getUint16(offset);
      offset += 2 + length;
    }
  }
  return counts;
}

function hevcNal(type: number, payload: number[] = [0x80]): Uint8Array {
  return new Uint8Array([type << 1, 1, ...payload]);
}

function annexBPayload(...units: Uint8Array[]): Uint8Array {
  const escaped = units.map(escapeNal);
  const result = new Uint8Array(escaped.reduce((total, unit) => total + 4 + unit.byteLength, 0));
  let offset = 0;
  for (const unit of escaped) {
    result.set([0, 0, 0, 1], offset);
    result.set(unit, offset + 4);
    offset += 4 + unit.byteLength;
  }
  return result;
}

function escapeNal(unit: Uint8Array): Uint8Array {
  const result: number[] = [];
  let zeros = 0;
  for (const byte of unit) {
    if (zeros >= 2 && byte <= 3) {
      result.push(3);
      zeros = 0;
    }
    result.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return new Uint8Array(result);
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

function hevcVps(id: number): Uint8Array {
  return hevcNal(32, [(id << 4) | 0x08]);
}

function hevcPps(id: number, spsId: number): Uint8Array {
  const bits = new BitWriter();
  bits.expGolomb(id);
  bits.expGolomb(spsId);
  return hevcNal(34, bits.bytes());
}

function makeSps(
  profileByte: number,
  compatibility: number[],
  constraints: number[],
  level: number,
  chromaFormat: number,
  bitDepthLumaMinus8: number,
  bitDepthChromaMinus8: number,
  subLayerProfile = false,
  spsId = 0,
): Uint8Array {
  const bits = new BitWriter();
  bits.write(0, 4);
  bits.write(subLayerProfile ? 1 : 0, 3);
  bits.write(1, 1);
  bits.write(profileByte, 8);
  for (const byte of compatibility) bits.write(byte, 8);
  for (const byte of constraints) bits.write(byte, 8);
  bits.write(level, 8);
  if (subLayerProfile) {
    bits.write(1, 1);
    bits.write(0, 1);
    bits.write(0, 14);
    bits.write(0, 88);
  }
  bits.expGolomb(spsId);
  bits.expGolomb(chromaFormat);
  if (chromaFormat === 3) bits.write(0, 1);
  bits.expGolomb(1_920);
  bits.expGolomb(1_080);
  bits.write(0, 1);
  bits.expGolomb(bitDepthLumaMinus8);
  bits.expGolomb(bitDepthChromaMinus8);
  return new Uint8Array([33 << 1, 1, ...bits.bytes()]);
}

class BitWriter {
  #bits: number[] = [];

  write(value: number, count: number): void {
    for (let shift = count - 1; shift >= 0; shift -= 1) this.#bits.push((value >> shift) & 1);
  }

  expGolomb(value: number): void {
    const encoded = value + 1;
    const count = Math.floor(Math.log2(encoded));
    this.write(0, count);
    this.write(encoded, count + 1);
  }

  bytes(): number[] {
    this.#bits.push(1);
    while (this.#bits.length % 8) this.#bits.push(0);
    const result: number[] = [];
    for (let offset = 0; offset < this.#bits.length; offset += 8) {
      let value = 0;
      for (let index = 0; index < 8; index += 1) value = value * 2 + this.#bits[offset + index]!;
      result.push(value);
    }
    return result;
  }
}
