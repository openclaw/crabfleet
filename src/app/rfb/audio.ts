export type RFBAudioMessage =
  | { kind: "config"; channels: number; sampleRate: number; cookie: Uint8Array }
  | { kind: "packet"; timestampMs: number; payload: Uint8Array }
  | { kind: "stop" };

declare global {
  interface ImportMeta {
    readonly url: string;
  }
}

export interface AudioPacket {
  timestampMs: number;
  payload: Uint8Array;
}

export type AudioJitterResult =
  | { kind: "buffered" }
  | { kind: "ready"; packets: AudioPacket[] }
  | { kind: "droppedLate" }
  | { kind: "resynced" };

interface BrowserAudioData {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  copyTo(destination: Float32Array, options: { planeIndex: number; format: "f32-planar" }): void;
  close(): void;
}

interface BrowserAudioDecoder {
  readonly state: "unconfigured" | "configured" | "closed";
  readonly decodeQueueSize: number;
  configure(config: Record<string, unknown>): void;
  decode(chunk: unknown): void;
  close(): void;
}

interface AudioDecoderAPI {
  new (callbacks: {
    output(data: BrowserAudioData): void;
    error(error: Error): void;
  }): BrowserAudioDecoder;
  isConfigSupported(config: Record<string, unknown>): Promise<{ supported?: boolean }>;
}

interface EncodedAudioChunkAPI {
  new (init: { type: "key"; timestamp: number; data: Uint8Array }): unknown;
}

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage(value: unknown, transfer?: ArrayBuffer[]): void;
}

interface BrowserAudioWorkletNode {
  readonly port: WorkletPort;
  connect(destination: unknown): void;
  disconnect(): void;
}

interface BrowserGainNode {
  readonly gain: { value: number };
  connect(destination: unknown): void;
  disconnect(): void;
}

interface AudioWorkletNodeAPI {
  new (
    context: BrowserAudioContext,
    name: string,
    options: Record<string, unknown>,
  ): BrowserAudioWorkletNode;
}

interface BrowserAudioContext {
  readonly state: string;
  readonly destination: unknown;
  readonly audioWorklet: { addModule(url: string): Promise<void> };
  createGain(): BrowserGainNode;
  resume(): Promise<void>;
  close(): Promise<void>;
}

interface AudioContextAPI {
  new (options?: { latencyHint?: string }): BrowserAudioContext;
  readonly prototype: { audioWorklet?: unknown };
}

export interface RemoteAudioStats {
  droppedPackets: number;
  jitterDepthMs: number;
}

const maximumAudioBytes = 64 * 1_024;
const maximumPendingMessages = 12;

export async function supportsWebCodecsAudio(): Promise<boolean> {
  const Decoder = audioDecoderAPI();
  const Context = audioContextAPI();
  if (!Decoder || !Context || !audioWorkletNodeAPI() || !("audioWorklet" in Context.prototype))
    return false;
  try {
    return (
      (
        await Decoder.isConfigSupported({
          codec: "mp4a.40.2",
          sampleRate: 48_000,
          numberOfChannels: 2,
          description: new Uint8Array([0x11, 0x90]),
        })
      ).supported === true
    );
  } catch {
    return false;
  }
}

export function extractAudioSpecificConfig(cookie: Uint8Array): Uint8Array {
  if (cookie.byteLength < 2 || cookie.byteLength > maximumAudioBytes)
    throw new Error("invalid AAC magic cookie");
  const esdsOffset = findFourCC(cookie, "esds");
  if (esdsOffset < 0) return cookie.slice();
  const asc = findDecoderSpecificInfo(cookie, esdsOffset + 8, cookie.byteLength);
  if (!asc || asc.byteLength < 2) throw new Error("esds cookie has no AudioSpecificConfig");
  return asc;
}

export class AudioJitterBuffer {
  readonly packetDurationMs: number;
  readonly targetDelayMs: number;
  readonly maximumDelayMs: number;
  droppedPackets = 0;
  #packets: AudioPacket[] = [];
  #newestTimestampMs: number | null = null;
  #primed = false;

  constructor(sampleRate: number, targetDelayMs = 100, maximumDelayMs = 120) {
    if (!Number.isInteger(sampleRate) || sampleRate < 8_000 || sampleRate > 192_000)
      throw new Error("invalid audio sample rate");
    this.packetDurationMs = Math.max(1, Math.round(1_024_000 / sampleRate));
    this.targetDelayMs = Math.min(120, Math.max(80, Math.round(targetDelayMs)));
    this.maximumDelayMs = Math.max(this.targetDelayMs, Math.min(120, maximumDelayMs));
  }

  get depthMs(): number {
    const first = this.#packets[0];
    const newest = this.#newestTimestampMs;
    return first && newest !== null
      ? Math.max(0, unsignedTimestampDelta(newest, first.timestampMs) + this.packetDurationMs)
      : 0;
  }

  enqueue(packet: AudioPacket): AudioJitterResult {
    if (!packet.payload.byteLength || packet.payload.byteLength > maximumAudioBytes)
      throw new Error("invalid audio packet");
    if (this.#newestTimestampMs !== null) {
      const delta = signedTimestampDelta(packet.timestampMs, this.#newestTimestampMs);
      if (delta <= 0) {
        this.droppedPackets += 1;
        return { kind: "droppedLate" };
      }
      if (delta > 500) {
        this.reset();
        this.#packets.push(packet);
        this.#newestTimestampMs = packet.timestampMs;
        return { kind: "resynced" };
      }
    }
    this.#packets.push(packet);
    this.#newestTimestampMs = packet.timestampMs;
    while (this.depthMs > this.maximumDelayMs && this.#packets.length > 1) {
      this.#packets.shift();
      this.droppedPackets += 1;
    }
    if (!this.#primed) {
      if (this.depthMs < this.targetDelayMs) return { kind: "buffered" };
      this.#primed = true;
    }
    const packets = this.#packets.splice(0);
    return { kind: "ready", packets };
  }

  reset(): void {
    this.#packets.length = 0;
    this.#newestTimestampMs = null;
    this.#primed = false;
  }
}

export class BoundedAudioMessageQueue {
  readonly capacity: number;
  droppedPackets = 0;
  muted = true;
  #messages: RFBAudioMessage[] = [];
  #scheduled = false;
  #receive: (message: RFBAudioMessage) => void;
  #mute: (muted: boolean) => void;
  #error: (error: Error) => void;
  #closed = false;

  constructor(
    receive: (message: RFBAudioMessage) => void,
    mute: (muted: boolean) => void,
    capacity = maximumPendingMessages,
    error: (error: Error) => void = () => {},
  ) {
    this.#receive = receive;
    this.#mute = mute;
    this.capacity = capacity;
    this.#error = error;
  }

  enqueue(message: RFBAudioMessage): void {
    if (this.#closed) return;
    if (message.kind === "config" || message.kind === "stop") this.#messages.length = 0;
    else if (this.#messages.length >= this.capacity) {
      const packet = this.#messages.findIndex((value) => value.kind === "packet");
      if (packet < 0) {
        this.droppedPackets += 1;
        return;
      }
      this.#messages.splice(packet, 1);
      this.droppedPackets += 1;
    }
    this.#messages.push(message);
    if (this.#scheduled) return;
    this.#scheduled = true;
    queueMicrotask(() => this.#drain());
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.#mute(muted);
  }

  close(): void {
    this.#closed = true;
    this.#messages.length = 0;
  }

  #drain(): void {
    try {
      while (!this.#closed && this.#messages.length) this.#receive(this.#messages.shift()!);
    } catch (error) {
      this.#messages.length = 0;
      this.#error(asError(error));
    } finally {
      this.#scheduled = false;
      if (this.#messages.length) {
        this.#scheduled = true;
        queueMicrotask(() => this.#drain());
      }
    }
  }
}

export class RemoteAudioPlayer {
  #decoder: BrowserAudioDecoder | null = null;
  #context: BrowserAudioContext | null = null;
  #worklet: BrowserAudioWorkletNode | null = null;
  #gain: BrowserGainNode | null = null;
  #jitter: AudioJitterBuffer | null = null;
  #configuration: { channels: number; sampleRate: number; asc: Uint8Array } | null = null;
  #stats: RemoteAudioStats = { droppedPackets: 0, jitterDepthMs: 0 };
  #onStats: (stats: RemoteAudioStats) => void;
  #queue: BoundedAudioMessageQueue;
  #decoderGeneration = 0;
  #audioFailed = false;
  #onError: (error: Error) => void;
  #initialization: Promise<void> | null = null;
  #closed = false;

  constructor(
    onStats: (stats: RemoteAudioStats) => void = () => {},
    onError: (error: Error) => void = () => {},
  ) {
    this.#onStats = onStats;
    this.#onError = onError;
    this.#queue = new BoundedAudioMessageQueue(
      (message) => this.#handle(message),
      (muted) => {
        if (this.#gain) this.#gain.gain.value = muted ? 0 : 1;
        this.#worklet?.port.postMessage({ kind: "mute", muted });
      },
      maximumPendingMessages,
      (error) => this.#disable(error),
    );
  }

  receive(message: RFBAudioMessage): void {
    if (this.#closed) return;
    this.#queue.enqueue(message);
    this.#publishStats();
  }

  setMuted(muted: boolean): void {
    this.#queue.setMuted(muted);
  }

  async enableFromGesture(): Promise<void> {
    if (this.#closed) throw new Error("audio player closed");
    if (!this.#worklet) {
      const initialization = this.#initialization ?? this.#initializeAudioGraph();
      this.#initialization = initialization;
      try {
        await initialization;
      } finally {
        if (this.#initialization === initialization) this.#initialization = null;
      }
    }
    if (this.#closed || !this.#context) throw new Error("audio player closed");
    const context = this.#context;
    if (context.state !== "running") await context.resume();
    // close() may have run while resume() was pending; unmuting then would
    // report success for a detached graph and desync the shared audio state.
    if (this.#closed || this.#context !== context) throw new Error("audio player closed");
    this.setMuted(false);
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#queue.setMuted(true);
    this.#queue.close();
    this.#decoder?.close();
    this.#decoder = null;
    this.#worklet?.disconnect();
    this.#worklet = null;
    this.#gain?.disconnect();
    this.#gain = null;
    const context = this.#context;
    this.#context = null;
    if (context) await context.close();
  }

  async #initializeAudioGraph(): Promise<void> {
    const Context = audioContextAPI();
    const Node = audioWorkletNodeAPI();
    if (!Context || !Node) throw new Error("AudioWorklet is unavailable");
    const context = new Context({ latencyHint: "interactive" });
    this.#context = context;
    try {
      await context.audioWorklet.addModule(new URL("./audio-worklet.js", import.meta.url).href);
      if (this.#closed || this.#context !== context) throw new Error("audio player closed");
      const worklet = new Node(context, "crabfleet-remote-audio", {
        outputChannelCount: [2],
      });
      const gain = context.createGain();
      gain.gain.value = 0;
      worklet.port.onmessage = (event) => this.#receiveWorkletStats(event.data);
      worklet.connect(gain);
      gain.connect(context.destination);
      this.#worklet = worklet;
      this.#gain = gain;
      const configuration = this.#configuration;
      if (configuration)
        worklet.port.postMessage({
          kind: "configure",
          channels: configuration.channels,
          sampleRate: configuration.sampleRate,
        });
    } catch (error) {
      if (this.#context === context) {
        this.#context = null;
        await context.close().catch(() => {});
      }
      throw error;
    }
  }

  #handle(message: RFBAudioMessage): void {
    if (this.#closed) return;
    if (message.kind === "config") {
      this.#configure(message);
      return;
    }
    if (message.kind === "stop") {
      this.#stop();
      return;
    }
    const jitter = this.#jitter;
    if (!jitter || this.#audioFailed) return;
    const result = jitter.enqueue(message);
    if (result.kind === "resynced") {
      this.#worklet?.port.postMessage({ kind: "reset" });
      this.#rebuildDecoder();
    } else if (result.kind === "ready") {
      for (const packet of result.packets) this.#decode(packet);
    }
    this.#publishStats();
  }

  #configure(message: Extract<RFBAudioMessage, { kind: "config" }>): void {
    this.#stop();
    const asc = extractAudioSpecificConfig(message.cookie);
    this.#audioFailed = false;
    this.#configuration = { channels: message.channels, sampleRate: message.sampleRate, asc };
    this.#jitter = new AudioJitterBuffer(message.sampleRate);
    this.#rebuildDecoder();
    this.#worklet?.port.postMessage({
      kind: "configure",
      channels: message.channels,
      sampleRate: message.sampleRate,
    });
  }

  #rebuildDecoder(): void {
    if (this.#closed) return;
    const configuration = this.#configuration;
    if (!configuration) return;
    this.#decoder?.close();
    const generation = ++this.#decoderGeneration;
    const Decoder = audioDecoderAPI();
    if (!Decoder) throw new Error("WebCodecs AudioDecoder is unavailable");
    this.#decoder = new Decoder({
      output: (data) => this.#output(data),
      error: (error) => {
        if (generation === this.#decoderGeneration) this.#disable(error);
      },
    });
    this.#decoder.configure({
      codec: "mp4a.40.2",
      sampleRate: configuration.sampleRate,
      numberOfChannels: configuration.channels,
      description: configuration.asc,
    });
  }

  #decode(packet: AudioPacket): void {
    const decoder = this.#decoder;
    if (!decoder || decoder.state !== "configured") return;
    if (decoder.decodeQueueSize >= maximumPendingMessages) {
      this.#stats.droppedPackets += 1;
      return;
    }
    const Chunk = encodedAudioChunkAPI();
    decoder.decode(
      new Chunk({ type: "key", timestamp: packet.timestampMs * 1_000, data: packet.payload }),
    );
  }

  #output(data: BrowserAudioData): void {
    try {
      const channels = Math.min(2, data.numberOfChannels);
      const interleaved = new Float32Array(data.numberOfFrames * channels);
      for (let channel = 0; channel < channels; channel += 1) {
        const plane = new Float32Array(data.numberOfFrames);
        data.copyTo(plane, { planeIndex: channel, format: "f32-planar" });
        for (let frame = 0; frame < data.numberOfFrames; frame += 1)
          interleaved[frame * channels + channel] = plane[frame]!;
      }
      this.#worklet?.port.postMessage({ kind: "pcm", channels, samples: interleaved.buffer }, [
        interleaved.buffer,
      ]);
    } finally {
      data.close();
    }
  }

  #stop(): void {
    this.#decoderGeneration += 1;
    this.#decoder?.close();
    this.#decoder = null;
    this.#jitter = null;
    this.#configuration = null;
    this.#worklet?.port.postMessage({ kind: "reset" });
  }

  #disable(error: Error): void {
    if (this.#audioFailed) return;
    this.#audioFailed = true;
    this.#decoderGeneration += 1;
    if (this.#decoder?.state !== "closed") this.#decoder?.close();
    this.#decoder = null;
    this.#jitter?.reset();
    this.#worklet?.port.postMessage({ kind: "reset" });
    this.#stats.droppedPackets += 1;
    this.#publishStats();
    this.#onError(error);
  }

  #receiveWorkletStats(value: unknown): void {
    if (!value || typeof value !== "object") return;
    const stats = value as { kind?: unknown; depthMs?: unknown; droppedPackets?: unknown };
    if (stats.kind !== "stats" || typeof stats.depthMs !== "number") return;
    this.#stats.jitterDepthMs = Math.max(0, stats.depthMs);
    if (typeof stats.droppedPackets === "number")
      this.#stats.droppedPackets += Math.max(0, stats.droppedPackets);
    this.#publishStats();
  }

  #publishStats(): void {
    const jitterDrops = this.#jitter?.droppedPackets ?? 0;
    this.#onStats({
      droppedPackets: this.#stats.droppedPackets + this.#queue.droppedPackets + jitterDrops,
      jitterDepthMs: this.#stats.jitterDepthMs || this.#jitter?.depthMs || 0,
    });
  }
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function audioDecoderAPI(): AudioDecoderAPI | undefined {
  return (globalThis as unknown as { AudioDecoder?: AudioDecoderAPI }).AudioDecoder;
}

function encodedAudioChunkAPI(): EncodedAudioChunkAPI {
  const api = (globalThis as unknown as { EncodedAudioChunk?: EncodedAudioChunkAPI })
    .EncodedAudioChunk;
  if (!api) throw new Error("WebCodecs EncodedAudioChunk is unavailable");
  return api;
}

function audioContextAPI(): AudioContextAPI | undefined {
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextAPI;
    webkitAudioContext?: AudioContextAPI;
  };
  return scope.AudioContext ?? scope.webkitAudioContext;
}

function audioWorkletNodeAPI(): AudioWorkletNodeAPI | undefined {
  return (globalThis as unknown as { AudioWorkletNode?: AudioWorkletNodeAPI }).AudioWorkletNode;
}

function findFourCC(data: Uint8Array, name: string): number {
  const bytes = new TextEncoder().encode(name);
  for (let offset = 0; offset + 4 <= data.byteLength; offset += 1) {
    if (bytes.every((byte, index) => data[offset + index] === byte)) return offset;
  }
  return -1;
}

function findDecoderSpecificInfo(data: Uint8Array, start: number, end: number): Uint8Array | null {
  let offset = start;
  while (offset < end) {
    const tag = data[offset++];
    if (tag === undefined) return null;
    const length = readDescriptorLength(data, offset, end);
    if (!length) return null;
    offset = length.next;
    const payloadEnd = offset + length.value;
    if (payloadEnd > end) return null;
    if (tag === 0x05) return data.slice(offset, payloadEnd);
    let nested = offset;
    if (tag === 0x03) {
      if (nested + 3 > payloadEnd) return null;
      const flags = data[nested + 2]!;
      nested += 3;
      if (flags & 0x80) nested += 2;
      if (flags & 0x40) nested += 1 + (data[nested] ?? 0);
      if (flags & 0x20) nested += 2;
    } else if (tag === 0x04) nested += 13;
    if ((tag === 0x03 || tag === 0x04) && nested <= payloadEnd) {
      const found = findDecoderSpecificInfo(data, nested, payloadEnd);
      if (found) return found;
    }
    offset = payloadEnd;
  }
  return null;
}

function readDescriptorLength(
  data: Uint8Array,
  start: number,
  end: number,
): { value: number; next: number } | null {
  let value = 0;
  let offset = start;
  for (let count = 0; count < 4 && offset < end; count += 1) {
    const byte = data[offset++]!;
    value = (value << 7) | (byte & 0x7f);
    if (!(byte & 0x80)) return { value, next: offset };
  }
  return null;
}

function signedTimestampDelta(value: number, reference: number): number {
  return (value - reference) | 0;
}

function unsignedTimestampDelta(value: number, reference: number): number {
  return (value - reference) >>> 0;
}
