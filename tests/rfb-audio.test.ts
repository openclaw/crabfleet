import assert from "node:assert/strict";
import test from "node:test";

import {
  AudioJitterBuffer,
  BoundedAudioMessageQueue,
  RemoteAudioPlayer,
  extractAudioSpecificConfig,
  supportsWebCodecsAudio,
  type RFBAudioMessage,
} from "../src/app/rfb/audio.ts";
import { readRFBAudioMessage, type RFBTransport } from "../src/app/rfb/client.ts";

test("CAF1 support probe checks raw AAC with an AudioSpecificConfig", async (t) => {
  let probed: Record<string, unknown> | undefined;
  const descriptors = saveGlobals("AudioDecoder", "AudioContext", "AudioWorkletNode");
  t.after(() => restoreGlobals(descriptors));
  class FakeAudioDecoder {
    static async isConfigSupported(config: Record<string, unknown>) {
      probed = config;
      return { supported: true };
    }
  }
  class FakeAudioContext {}
  Object.defineProperty(FakeAudioContext.prototype, "audioWorklet", { value: {} });
  Object.defineProperty(globalThis, "AudioDecoder", {
    value: FakeAudioDecoder,
    configurable: true,
  });
  Object.defineProperty(globalThis, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: class {},
    configurable: true,
  });
  assert.equal(await supportsWebCodecsAudio(), true);
  assert.deepEqual(probed?.description, new Uint8Array([0x11, 0x90]));
});

test("closing during AudioWorklet initialization cancels the orphan graph", async (t) => {
  const descriptors = saveGlobals("AudioContext", "AudioWorkletNode");
  t.after(() => restoreGlobals(descriptors));
  let finishModule!: () => void;
  let closeCalls = 0;
  let nodeCreations = 0;
  class FakeAudioContext {
    state = "suspended";
    destination = {};
    audioWorklet = {
      addModule: () => new Promise<void>((resolve) => (finishModule = resolve)),
    };
    createGain() {
      return { gain: { value: 0 }, connect() {}, disconnect() {} };
    }
    async resume() {}
    async close() {
      closeCalls += 1;
      this.state = "closed";
    }
  }
  Object.defineProperty(globalThis, "AudioContext", {
    value: FakeAudioContext,
    configurable: true,
  });
  Object.defineProperty(globalThis, "AudioWorkletNode", {
    value: class {
      port = { onmessage: null, postMessage() {} };
      constructor() {
        nodeCreations += 1;
      }
      connect() {}
      disconnect() {}
    },
    configurable: true,
  });
  const player = new RemoteAudioPlayer();
  const enabling = player.enableFromGesture();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await player.close();
  finishModule();
  await assert.rejects(enabling, /audio player closed/);
  assert.equal(closeCalls, 1);
  assert.equal(nodeCreations, 0);
});

test("CAF1 parser matches host config, packet, and stop encoders byte-for-byte", async () => {
  const config = new Uint8Array([200, 1, 1, 2, 0, 0, 0xbb, 0x80, 0, 0, 0, 2, 0x11, 0x90]);
  const packet = new Uint8Array([200, 2, 0, 0, 0xff, 0xff, 0xff, 0xfe, 0, 0, 0, 2, 0xaa, 0xbb]);
  const stop = new Uint8Array([200, 3, 0, 0]);
  assert.deepEqual(await parseHostMessage(config), {
    kind: "config",
    channels: 2,
    sampleRate: 48_000,
    cookie: new Uint8Array([0x11, 0x90]),
  });
  assert.deepEqual(await parseHostMessage(packet), {
    kind: "packet",
    timestampMs: 0xffff_fffe,
    payload: new Uint8Array([0xaa, 0xbb]),
  });
  assert.deepEqual(await parseHostMessage(stop), { kind: "stop" });
});

test("CAF1 parser rejects malformed bounds and padding", async () => {
  await assert.rejects(
    parseHostMessage(new Uint8Array([200, 1, 1, 3, 0, 0, 0xbb, 0x80, 0, 0, 0, 0])),
    /invalid CAF1 audio configuration/,
  );
  await assert.rejects(
    parseHostMessage(new Uint8Array([200, 2, 1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 1])),
    /invalid CAF1 audio packet/,
  );
  await assert.rejects(parseHostMessage(new Uint8Array([200, 3, 0, 1])), /invalid CAF1 audio stop/);
});

test("audio jitter buffer primes, drops late packets, and resyncs after gaps", () => {
  const jitter = new AudioJitterBuffer(48_000);
  for (const timestampMs of [0, 21, 42, 63])
    assert.deepEqual(jitter.enqueue(audioPacket(timestampMs)), { kind: "buffered" });
  const ready = jitter.enqueue(audioPacket(84));
  assert.equal(ready.kind, "ready");
  if (ready.kind === "ready") assert.equal(ready.packets.length, 5);
  assert.deepEqual(jitter.enqueue(audioPacket(63)), { kind: "droppedLate" });
  assert.deepEqual(jitter.enqueue(audioPacket(700)), { kind: "resynced" });
  assert.equal(jitter.depthMs, 21);
  assert.equal(jitter.droppedPackets, 1);
});

test("AudioSpecificConfig passes through and extracts from an esds cookie", () => {
  const asc = new Uint8Array([0x11, 0x90]);
  assert.deepEqual(extractAudioSpecificConfig(asc), asc);
  const decoderConfig = [0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 2, ...asc];
  const esDescriptor = [0, 1, 0, 0x04, decoderConfig.length, ...decoderConfig];
  const cookie = new Uint8Array([
    0,
    0,
    0,
    0,
    0x65,
    0x73,
    0x64,
    0x73,
    0,
    0,
    0,
    0,
    0x03,
    esDescriptor.length,
    ...esDescriptor,
  ]);
  new DataView(cookie.buffer).setUint32(0, cookie.byteLength);
  assert.deepEqual(extractAudioSpecificConfig(cookie), asc);
});

test("mute reaches playback immediately despite queued decode work", async () => {
  const received: RFBAudioMessage[] = [];
  const muteCalls: boolean[] = [];
  const queue = new BoundedAudioMessageQueue(
    (message) => received.push(message),
    (muted) => muteCalls.push(muted),
  );
  for (let index = 0; index < 12; index += 1) queue.enqueue(audioPacket(index));
  queue.setMuted(false);
  queue.setMuted(true);
  assert.deepEqual(muteCalls, [false, true]);
  assert.equal(received.length, 0);
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.equal(received.length, 12);
  assert.equal(queue.muted, true);
});

test("audio message queue clears its scheduled fence after a processing error", async () => {
  const received: number[] = [];
  const errors: string[] = [];
  const queue = new BoundedAudioMessageQueue(
    (message) => {
      if (message.kind !== "packet") return;
      if (message.timestampMs === 1) throw new Error("bad audio fixture");
      received.push(message.timestampMs);
    },
    () => {},
    12,
    (error) => errors.push(error.message),
  );
  queue.enqueue(audioPacket(1));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  queue.enqueue(audioPacket(2));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(errors, ["bad audio fixture"]);
  assert.deepEqual(received, [2]);
  queue.close();
  queue.enqueue(audioPacket(3));
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assert.deepEqual(received, [2]);
});

test("audio worklet trims low-rate AAC without falling below its prime target", async (t) => {
  interface Processor {
    bufferedFrames: number;
    primed: boolean;
    receive(message: unknown): void;
    process(inputs: unknown[], outputs: Float32Array[][]): boolean;
  }
  let ProcessorClass: (new () => Processor) | undefined;
  const processorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "AudioWorkletProcessor");
  const registerDescriptor = Object.getOwnPropertyDescriptor(globalThis, "registerProcessor");
  const rateDescriptor = Object.getOwnPropertyDescriptor(globalThis, "sampleRate");
  t.after(() => {
    restoreGlobal("AudioWorkletProcessor", processorDescriptor);
    restoreGlobal("registerProcessor", registerDescriptor);
    restoreGlobal("sampleRate", rateDescriptor);
  });
  class FakeAudioWorkletProcessor {
    port = { onmessage: null, postMessage() {} };
  }
  Object.defineProperty(globalThis, "AudioWorkletProcessor", {
    value: FakeAudioWorkletProcessor,
    configurable: true,
  });
  Object.defineProperty(globalThis, "registerProcessor", {
    value: (_name: string, value: new () => Processor) => {
      ProcessorClass = value;
    },
    configurable: true,
  });
  Object.defineProperty(globalThis, "sampleRate", { value: 8_000, configurable: true });
  await import("../src/app/rfb/audio-worklet.js");
  assert.ok(ProcessorClass);
  const processor = new ProcessorClass();
  processor.receive({ kind: "configure", channels: 1, sampleRate: 8_000 });
  processor.receive({
    kind: "pcm",
    channels: 1,
    samples: new Float32Array(1_024).fill(1).buffer,
  });
  assert.equal(processor.bufferedFrames, 960);
  const output = new Float32Array(128);
  processor.receive({ kind: "mute", muted: false });
  assert.equal(processor.process([], [[output]]), true);
  assert.equal(processor.primed, true);
  assert.ok(output.every((sample) => sample === 1));
});

function audioPacket(timestampMs: number): Extract<RFBAudioMessage, { kind: "packet" }> {
  return { kind: "packet", timestampMs, payload: new Uint8Array([1]) };
}

async function parseHostMessage(frame: Uint8Array): Promise<RFBAudioMessage> {
  assert.equal(frame[0], 200);
  return await readRFBAudioMessage(new ByteTransport(frame.subarray(1)));
}

function restoreGlobal(name: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

function saveGlobals(...names: string[]): Map<string, PropertyDescriptor | undefined> {
  return new Map(names.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
}

function restoreGlobals(descriptors: ReadonlyMap<string, PropertyDescriptor | undefined>): void {
  for (const [name, descriptor] of descriptors) restoreGlobal(name, descriptor);
}

class ByteTransport implements RFBTransport {
  #bytes: Uint8Array;
  #offset = 0;

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes;
  }

  async readExactly(count: number): Promise<Uint8Array> {
    if (this.#offset + count > this.#bytes.byteLength) throw new Error("fixture ended");
    const result = this.#bytes.slice(this.#offset, this.#offset + count);
    this.#offset += count;
    return result;
  }

  send(): void {}
  close(): void {}
}
