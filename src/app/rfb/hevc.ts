import {
  AnnexBDecodeGate,
  accessUnits,
  annexBToLengthPrefixed,
  isIrap,
  isSlice,
  parseAnnexB,
  videoParameterSets,
  type AnnexBNalUnit,
} from "./annex-b.ts";
import type { BrowserVideoFrame } from "./h264.ts";

interface BrowserVideoDecoder {
  readonly state: "unconfigured" | "configured" | "closed";
  readonly decodeQueueSize: number;
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  close(): void;
}

interface VideoDecoderAPI {
  new (callbacks: {
    output(frame: BrowserVideoFrame): void;
    error(error: Error): void;
  }): BrowserVideoDecoder;
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

interface EncodedVideoChunkAPI {
  new (init: {
    type: "key" | "delta";
    timestamp: number;
    duration: number;
    data: Uint8Array;
  }): unknown;
}

interface HEVCProfileTierLevel {
  profileByte: number;
  compatibility: Uint8Array;
  constraints: Uint8Array;
  level: number;
  temporalLayers: number;
  temporalIdNested: boolean;
  chromaFormat: number;
  bitDepthLumaMinus8: number;
  bitDepthChromaMinus8: number;
  spsId: number;
}

function videoDecoderAPI(): VideoDecoderAPI | undefined {
  return (globalThis as unknown as { VideoDecoder?: VideoDecoderAPI }).VideoDecoder;
}

function encodedVideoChunkAPI(): EncodedVideoChunkAPI {
  const api = (globalThis as unknown as { EncodedVideoChunk?: EncodedVideoChunkAPI })
    .EncodedVideoChunk;
  if (!api) throw new Error("WebCodecs EncodedVideoChunk is unavailable");
  return api;
}

async function supports(codec: string): Promise<boolean> {
  const api = videoDecoderAPI();
  if (!api) return false;
  try {
    return (
      (
        await api.isConfigSupported({
          codec,
          optimizeForLatency: true,
        })
      ).supported === true
    );
  } catch {
    return false;
  }
}

export function supportsWebCodecsHEVC(): Promise<boolean> {
  return supports("hvc1.1.6.L120.90");
}

export function supportsWebCodecsHEVCRExt(): Promise<boolean> {
  return supports("hvc1.4.10.L120.9c");
}

export function hevcDescription(
  vps: readonly Uint8Array[],
  sps: readonly Uint8Array[],
  pps: readonly Uint8Array[],
): Uint8Array {
  const parameterSets = [...vps, ...sps, ...pps];
  if (
    !vps.length ||
    !sps.length ||
    !pps.length ||
    parameterSets.some((value) => !value.byteLength || value.byteLength > 0xffff) ||
    parameterSets.reduce((total, value) => total + value.byteLength, 0) > 64 * 1_024
  )
    throw new Error("invalid HEVC parameter sets");
  validateParameterSetIds(vps, 32);
  validateParameterSetIds(sps, 33);
  validateParameterSetIds(pps, 34);
  const profile = aggregateSpsProfiles(sps);
  const arrays = [
    { type: 32, units: vps },
    { type: 33, units: sps },
    { type: 34, units: pps },
  ];
  const length =
    23 +
    arrays.reduce(
      (total, value) =>
        total + 3 + value.units.reduce((unitTotal, unit) => unitTotal + 2 + unit.byteLength, 0),
      0,
    );
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  result[0] = 1;
  result[1] = profile.profileByte;
  result.set(profile.compatibility, 2);
  result.set(profile.constraints, 6);
  result[12] = profile.level;
  result[13] = 0xf0;
  result[14] = 0;
  result[15] = 0xfc;
  result[16] = 0xfc | profile.chromaFormat;
  result[17] = 0xf8 | profile.bitDepthLumaMinus8;
  result[18] = 0xf8 | profile.bitDepthChromaMinus8;
  view.setUint16(19, 0);
  result[21] =
    ((profile.temporalLayers & 0x07) << 3) | (profile.temporalIdNested ? 0x04 : 0) | 0x03;
  result[22] = arrays.length;
  let offset = 23;
  for (const array of arrays) {
    result[offset] = 0x80 | array.type;
    view.setUint16(offset + 1, array.units.length);
    offset += 3;
    for (const unit of array.units) {
      view.setUint16(offset, unit.byteLength);
      result.set(unit, offset + 2);
      offset += 2 + unit.byteLength;
    }
  }
  return result;
}

export function hevcCodecString(sps: Uint8Array): string {
  return codecStringForProfile(parseHEVCSps(sps));
}

function codecStringForProfile(profile: HEVCProfileTierLevel): string {
  const profileSpace = (profile.profileByte >> 6) & 0x03;
  const profileSpaceName = profileSpace ? String.fromCharCode(64 + profileSpace) : "";
  const profileIdc = profile.profileByte & 0x1f;
  const compatibility = reverseBits32(profile.compatibility).toString(16);
  const tier = profile.profileByte & 0x20 ? "H" : "L";
  const constraintBytes = [...profile.constraints];
  while (constraintBytes.at(-1) === 0) constraintBytes.pop();
  const constraints =
    constraintBytes.map((byte) => byte.toString(16).padStart(2, "0")).join(".") || "0";
  return `hvc1.${profileSpaceName}${profileIdc}.${compatibility}.${tier}${profile.level}.${constraints}`;
}

export class HEVCDecoder {
  #decoder: BrowserVideoDecoder | null = null;
  #vps = new Map<number, Uint8Array>();
  #sps = new Map<number, Uint8Array>();
  #pps = new Map<number, Uint8Array>();
  #timestamp = 0;
  #gate = new AnnexBDecodeGate("hevc");
  #decodeFailure: Error | null = null;
  #presentations = new Set<Promise<void>>();
  #output: (frame: BrowserVideoFrame) => Promise<void> | void;
  #error: (error: Error) => void;
  #needsRefresh: () => void;

  constructor(
    output: (frame: BrowserVideoFrame) => Promise<void> | void,
    error: (error: Error) => void,
    needsRefresh: () => void = () => {},
  ) {
    this.#output = output;
    this.#error = error;
    this.#needsRefresh = needsRefresh;
    this.#createDecoder();
  }

  decode(payload: Uint8Array, flags: number): void {
    if (flags & 0x2) this.reset();
    if (this.#decodeFailure) throw this.#decodeFailure;
    const grouped = accessUnits(parseAnnexB(payload, "hevc"), "hevc");
    const rebuildDescription = Boolean(flags & ~0x2);
    for (const units of grouped) {
      const sets = videoParameterSets(units, "hevc");
      this.#updateParameterSets(sets);
      if (!units.some((unit) => isSlice("hevc", unit.type))) continue;
      if (!this.#decoder || this.#decoder.state === "closed")
        throw new Error("HEVC decoder closed");
      const key = units.some((unit) => isIrap("hevc", unit.type));
      if (rebuildDescription && key) this.#gate.reset();
      if (!this.#gate.shouldDecode(units)) continue;
      if (this.#decoder.state === "unconfigured" || (rebuildDescription && key)) this.#configure();
      if (this.#decoder.decodeQueueSize >= 4) {
        this.reset();
        this.#needsRefresh();
        break;
      }
      this.#decoder.decode(
        new (encodedVideoChunkAPI())({
          type: key ? "key" : "delta",
          timestamp: this.#timestamp,
          duration: 16_667,
          data: annexBToLengthPrefixed(hevcSampleUnits(units)),
        }),
      );
      this.#timestamp += 16_667;
    }
  }

  reset(): void {
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
    this.#vps.clear();
    this.#sps.clear();
    this.#pps.clear();
    this.#gate.reset();
    this.#decodeFailure = null;
    this.#createDecoder();
  }

  close(): void {
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
  }

  #createDecoder(): void {
    const Decoder = videoDecoderAPI();
    if (!Decoder) throw new Error("WebCodecs VideoDecoder is unavailable");
    this.#decoder = new Decoder({
      output: (frame) => {
        if (this.#presentations.size >= 2) {
          frame.close();
          return;
        }
        const presentation = Promise.resolve()
          .then(() => this.#output(frame))
          .catch((error: unknown) => this.#recordFailure(asError(error)))
          .finally(() => this.#presentations.delete(presentation));
        this.#presentations.add(presentation);
      },
      error: (error) => this.#recordFailure(error),
    });
  }

  #configure(): void {
    if (!this.#vps.size || !this.#sps.size || !this.#pps.size)
      throw new Error("HEVC frame arrived before VPS/SPS/PPS");
    const vps = mapValues(this.#vps);
    const sps = mapValues(this.#sps);
    const pps = mapValues(this.#pps);
    const profile = aggregateSpsProfiles(sps);
    this.#decoder!.configure({
      codec: codecStringForProfile(profile),
      description: hevcDescription(vps, sps, pps),
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
  }

  #recordFailure(error: Error): void {
    if (this.#decodeFailure) return;
    this.#decodeFailure = error;
    this.#gate.reset();
    this.#error(error);
  }

  #updateParameterSets(sets: { vps: Uint8Array[]; sps: Uint8Array[]; pps: Uint8Array[] }): void {
    const vps = mergeById(this.#vps, sets.vps, 32);
    const sps = mergeById(this.#sps, sets.sps, 33);
    const pps = mergeById(this.#pps, sets.pps, 34);
    const total = [...vps.values(), ...sps.values(), ...pps.values()].reduce(
      (sum, value) => sum + value.byteLength,
      0,
    );
    if (total > 64 * 1_024) throw new Error("HEVC parameter sets exceed 64 KiB");
    this.#vps = vps;
    this.#sps = sps;
    this.#pps = pps;
  }
}

export function hevcSampleUnits(units: readonly AnnexBNalUnit[]): AnnexBNalUnit[] {
  return units.filter((unit) => ![32, 33, 34, 38].includes(unit.type));
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function reverseBits32(bytes: Uint8Array): number {
  let input = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  let output = 0;
  for (let index = 0; index < 32; index += 1) {
    output = (output * 2 + (input & 1)) >>> 0;
    input >>>= 1;
  }
  return output;
}

function aggregateSpsProfiles(sps: readonly Uint8Array[]): HEVCProfileTierLevel {
  const profiles = sps.map(parseHEVCSps);
  const first = profiles[0];
  if (!first) throw new Error("missing HEVC SPS");
  for (const profile of profiles.slice(1)) {
    if (
      profile.profileByte !== first.profileByte ||
      !bytesEqual(profile.compatibility, first.compatibility) ||
      !bytesEqual(profile.constraints, first.constraints) ||
      profile.temporalLayers !== first.temporalLayers ||
      profile.temporalIdNested !== first.temporalIdNested ||
      profile.chromaFormat !== first.chromaFormat ||
      profile.bitDepthLumaMinus8 !== first.bitDepthLumaMinus8 ||
      profile.bitDepthChromaMinus8 !== first.bitDepthChromaMinus8
    )
      throw new Error("incompatible HEVC SPS parameter sets");
  }
  return { ...first, level: Math.max(...profiles.map((profile) => profile.level)) };
}

function mergeById(
  existing: ReadonlyMap<number, Uint8Array>,
  incoming: readonly Uint8Array[],
  type: 32 | 33 | 34,
): Map<number, Uint8Array> {
  const merged = new Map(existing);
  for (const value of incoming) merged.set(parameterSetId(type, value), value);
  return merged;
}

function validateParameterSetIds(values: readonly Uint8Array[], type: 32 | 33 | 34): void {
  const ids = new Set<number>();
  for (const value of values) {
    const id = parameterSetId(type, value);
    if (ids.has(id)) throw new Error("duplicate HEVC parameter set id");
    ids.add(id);
  }
}

function parameterSetId(type: 32 | 33 | 34, data: Uint8Array): number {
  if (((data[0]! >> 1) & 0x3f) !== type) throw new Error("invalid HEVC parameter set");
  if (type === 33) return parseHEVCSps(data).spsId;
  const bits = new BitReader(removeEmulationPrevention(data.subarray(2)));
  if (type === 32) return bits.read(4);
  return bits.readExpGolomb();
}

function mapValues(values: ReadonlyMap<number, Uint8Array>): Uint8Array[] {
  return [...values.entries()].sort(([left], [right]) => left - right).map(([, value]) => value);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

function parseHEVCSps(sps: Uint8Array): HEVCProfileTierLevel {
  if (sps.byteLength < 15 || ((sps[0]! >> 1) & 0x3f) !== 33) throw new Error("invalid HEVC SPS");
  const bits = new BitReader(removeEmulationPrevention(sps.subarray(2)));
  bits.read(4);
  const maxSubLayersMinus1 = bits.read(3);
  const temporalIdNested = Boolean(bits.read(1));
  const profileByte = bits.read(8);
  const compatibility = bits.readBytes(4);
  const constraints = bits.readBytes(6);
  const level = bits.read(8);
  const subLayerProfilePresent: boolean[] = [];
  const subLayerLevelPresent: boolean[] = [];
  for (let index = 0; index < maxSubLayersMinus1; index += 1) {
    subLayerProfilePresent.push(Boolean(bits.read(1)));
    subLayerLevelPresent.push(Boolean(bits.read(1)));
  }
  if (maxSubLayersMinus1 > 0)
    for (let index = maxSubLayersMinus1; index < 8; index += 1) bits.read(2);
  for (let index = 0; index < maxSubLayersMinus1; index += 1) {
    if (subLayerProfilePresent[index]) bits.skip(88);
    if (subLayerLevelPresent[index]) bits.read(8);
  }
  const spsId = bits.readExpGolomb();
  const chromaFormat = bits.readExpGolomb();
  if (chromaFormat > 3) throw new Error("invalid HEVC chroma format");
  if (chromaFormat === 3) bits.read(1);
  bits.readExpGolomb();
  bits.readExpGolomb();
  if (bits.read(1)) {
    bits.readExpGolomb();
    bits.readExpGolomb();
    bits.readExpGolomb();
    bits.readExpGolomb();
  }
  const bitDepthLumaMinus8 = bits.readExpGolomb();
  const bitDepthChromaMinus8 = bits.readExpGolomb();
  if (bitDepthLumaMinus8 > 7 || bitDepthChromaMinus8 > 7)
    throw new Error("unsupported HEVC bit depth");
  return {
    profileByte,
    compatibility,
    constraints,
    level,
    temporalLayers: maxSubLayersMinus1 + 1,
    temporalIdNested,
    chromaFormat,
    bitDepthLumaMinus8,
    bitDepthChromaMinus8,
    spsId,
  };
}

function removeEmulationPrevention(data: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < data.byteLength; index += 1) {
    if (index >= 2 && data[index] === 0x03 && data[index - 1] === 0 && data[index - 2] === 0)
      continue;
    output.push(data[index]!);
  }
  return new Uint8Array(output);
}

class BitReader {
  #data: Uint8Array;
  #offset = 0;

  constructor(data: Uint8Array) {
    this.#data = data;
  }

  read(count: number): number {
    if (count < 0 || count > 32 || this.#offset + count > this.#data.byteLength * 8)
      throw new Error("truncated HEVC SPS");
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + ((this.#data[this.#offset >> 3]! >> (7 - (this.#offset & 7))) & 1);
      this.#offset += 1;
    }
    return value;
  }

  readBytes(count: number): Uint8Array {
    const value = new Uint8Array(count);
    for (let index = 0; index < count; index += 1) value[index] = this.read(8);
    return value;
  }

  skip(count: number): void {
    if (count < 0 || this.#offset + count > this.#data.byteLength * 8)
      throw new Error("truncated HEVC SPS");
    this.#offset += count;
  }

  readExpGolomb(): number {
    let zeroes = 0;
    while (this.read(1) === 0) {
      zeroes += 1;
      if (zeroes > 31) throw new Error("invalid HEVC Exp-Golomb value");
    }
    return zeroes ? 2 ** zeroes - 1 + this.read(zeroes) : 0;
  }
}

export function hevcUnits(data: readonly Uint8Array[]): AnnexBNalUnit[] {
  return data.map((unit) => ({ type: (unit[0]! >> 1) & 0x3f, data: unit }));
}
