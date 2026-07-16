export interface AnnexBNalUnit {
  type: number;
  data: Uint8Array;
}

export interface BrowserVideoFrame {
  width: number;
  height: number;
  displayWidth: number;
  displayHeight: number;
  close(): void;
}

interface BrowserVideoDecoder {
  readonly state: "unconfigured" | "configured" | "closed";
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  reset(): void;
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

function videoDecoderAPI(): VideoDecoderAPI | undefined {
  return (globalThis as unknown as { VideoDecoder?: VideoDecoderAPI }).VideoDecoder;
}

function encodedVideoChunkAPI(): EncodedVideoChunkAPI {
  const api = (globalThis as unknown as { EncodedVideoChunk?: EncodedVideoChunkAPI })
    .EncodedVideoChunk;
  if (!api) throw new Error("WebCodecs EncodedVideoChunk is unavailable");
  return api;
}

export function parseAnnexB(data: Uint8Array): AnnexBNalUnit[] {
  const units: AnnexBNalUnit[] = [];
  let payloadStart = -1;
  for (let index = 0; index + 3 < data.byteLength; index += 1) {
    if (data[index] !== 0 || data[index + 1] !== 0) continue;
    const startCodeOffset = index;
    let nextPayload = -1;
    if (data[index + 2] === 1) {
      nextPayload = index + 3;
      index += 2;
    } else if (data[index + 2] === 0 && data[index + 3] === 1) {
      nextPayload = index + 4;
      index += 3;
    }
    if (nextPayload < 0) continue;
    if (payloadStart >= 0) appendNalUnit(units, data.slice(payloadStart, startCodeOffset));
    payloadStart = nextPayload;
  }
  if (payloadStart >= 0) appendNalUnit(units, data.slice(payloadStart));
  return units;
}

function appendNalUnit(units: AnnexBNalUnit[], data: Uint8Array): void {
  if (!data.byteLength) return;
  if (units.length >= 1_024) throw new Error("H.264 access unit has too many NAL units");
  units.push({ type: data[0]! & 0x1f, data });
}

export function annexBToAvcc(units: AnnexBNalUnit[]): Uint8Array {
  const length = units.reduce((total, unit) => total + 4 + unit.data.byteLength, 0);
  const result = new Uint8Array(length);
  const view = new DataView(result.buffer);
  let offset = 0;
  for (const unit of units) {
    view.setUint32(offset, unit.data.byteLength);
    offset += 4;
    result.set(unit.data, offset);
    offset += unit.data.byteLength;
  }
  return result;
}

export function avcDescription(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  if (sps.byteLength < 4 || pps.byteLength < 1) throw new Error("invalid H.264 parameter sets");
  const result = new Uint8Array(11 + sps.byteLength + pps.byteLength);
  const view = new DataView(result.buffer);
  result.set([1, sps[1]!, sps[2]!, sps[3]!, 0xff, 0xe1], 0);
  view.setUint16(6, sps.byteLength);
  result.set(sps, 8);
  result[8 + sps.byteLength] = 1;
  view.setUint16(9 + sps.byteLength, pps.byteLength);
  result.set(pps, 11 + sps.byteLength);
  return result;
}

export async function supportsWebCodecsH264(): Promise<boolean> {
  const api = videoDecoderAPI();
  if (!api) return false;
  try {
    const result = await api.isConfigSupported({
      codec: "avc1.42E01F",
      optimizeForLatency: true,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

export class H264Decoder {
  #decoder: BrowserVideoDecoder | null = null;
  #sps: Uint8Array | null = null;
  #pps: Uint8Array | null = null;
  #timestamp = 0;
  #output: (frame: BrowserVideoFrame) => Promise<void> | void;
  #error: (error: Error) => void;
  #pending: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  constructor(
    output: (frame: BrowserVideoFrame) => Promise<void> | void,
    error: (error: Error) => void,
  ) {
    this.#output = output;
    this.#error = error;
    this.#createDecoder(error);
  }

  decode(payload: Uint8Array, flags: number): Promise<void> {
    // The Crabfleet host marks decoder-context resets with bit 0x2.
    if (flags & 0x2) this.reset();
    const units = parseAnnexB(payload);
    for (const unit of units) {
      if (unit.type === 7) this.#sps = unit.data;
      if (unit.type === 8) this.#pps = unit.data;
    }
    if (!this.#decoder || this.#decoder.state === "closed") throw new Error("H.264 decoder closed");
    if (this.#decoder.state === "unconfigured") this.#configure();
    const key = units.some((unit) => unit.type === 5);
    this.#decoder.decode(
      new (encodedVideoChunkAPI())({
        type: key ? "key" : "delta",
        timestamp: this.#timestamp,
        duration: 16_667,
        data: annexBToAvcc(units),
      }),
    );
    this.#timestamp += 16_667;
    return new Promise((resolve, reject) => this.#pending.push({ resolve, reject }));
  }

  reset(): void {
    if (!this.#decoder) return;
    if (this.#decoder.state !== "closed") this.#decoder.close();
    this.#rejectPending(new Error("H.264 decoder context reset"));
    this.#sps = null;
    this.#pps = null;
    this.#createDecoder(this.#error);
  }

  close(): void {
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
    this.#rejectPending(new Error("H.264 decoder closed"));
  }

  #createDecoder(error: (error: Error) => void): void {
    const Decoder = videoDecoderAPI();
    if (!Decoder) throw new Error("WebCodecs VideoDecoder is unavailable");
    this.#decoder = new Decoder({
      output: (frame) => {
        const pending = this.#pending.shift();
        Promise.resolve(this.#output(frame)).then(pending?.resolve, pending?.reject);
      },
      error: (decodeError) => {
        error(decodeError);
        this.#rejectPending(decodeError);
      },
    });
  }

  #configure(): void {
    if (!this.#sps || !this.#pps) throw new Error("H.264 frame arrived before SPS/PPS");
    const hex = [...this.#sps.slice(1, 4)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    this.#decoder!.configure({
      codec: `avc1.${hex}`,
      description: avcDescription(this.#sps, this.#pps),
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    });
  }

  #rejectPending(error: Error): void {
    for (const pending of this.#pending.splice(0)) pending.reject(error);
  }
}
