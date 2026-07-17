class CrabfleetRemoteAudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.channels = 2;
    this.sampleRateHz = 48_000;
    this.chunks = [];
    this.bufferedFrames = 0;
    this.primed = false;
    this.muted = true;
    this.droppedPackets = 0;
    this.reportCountdown = 0;
    this.sourcePosition = 0;
    this.port.onmessage = (event) => this.receive(event.data);
  }

  receive(message) {
    if (!message || typeof message !== "object") return;
    if (message.kind === "mute") {
      this.muted = Boolean(message.muted);
      return;
    }
    if (message.kind === "reset") {
      this.reset();
      return;
    }
    if (message.kind === "configure") {
      this.reset();
      this.channels = message.channels === 1 ? 1 : 2;
      this.sampleRateHz = Math.max(8_000, Math.min(192_000, Number(message.sampleRate) || 48_000));
      return;
    }
    if (message.kind !== "pcm" || !(message.samples instanceof ArrayBuffer)) return;
    const samples = new Float32Array(message.samples);
    const channels = message.channels === 1 ? 1 : 2;
    if (!samples.length || samples.length % channels) return;
    this.channels = channels;
    this.chunks.push({ samples, offset: 0 });
    this.bufferedFrames += samples.length / channels;
    const maximumFrames = Math.round(this.sampleRateHz * 0.12);
    const excessFrames = this.bufferedFrames - maximumFrames;
    if (excessFrames > 0) {
      this.discardFrames(excessFrames);
      this.droppedPackets += 1;
    }
  }

  reset() {
    this.chunks.length = 0;
    this.bufferedFrames = 0;
    this.primed = false;
    this.sourcePosition = 0;
  }

  sampleAt(frameOffset, channel) {
    let remaining = frameOffset;
    for (const chunk of this.chunks) {
      const frames = (chunk.samples.length - chunk.offset) / this.channels;
      if (remaining < frames)
        return chunk.samples[chunk.offset + remaining * this.channels + channel] || 0;
      remaining -= frames;
    }
    return 0;
  }

  discardFrames(count) {
    let remaining = Math.min(count, this.bufferedFrames);
    while (remaining > 0 && this.chunks.length) {
      const chunk = this.chunks[0];
      const frames = (chunk.samples.length - chunk.offset) / this.channels;
      const consumed = Math.min(remaining, frames);
      chunk.offset += consumed * this.channels;
      this.bufferedFrames -= consumed;
      remaining -= consumed;
      if (chunk.offset >= chunk.samples.length) this.chunks.shift();
    }
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output?.length) return true;
    const frames = output[0].length;
    const outputRate = Number(globalThis.sampleRate) || 48_000;
    const sourceFramesPerOutputFrame = this.sampleRateHz / outputRate;
    if (!this.primed && this.bufferedFrames >= Math.round(this.sampleRateHz * 0.1))
      this.primed = true;
    for (let frame = 0; frame < frames; frame += 1) {
      if (!this.primed || !this.chunks.length) {
        this.primed = false;
        for (const channel of output) channel[frame] = 0;
        continue;
      }
      for (let channel = 0; channel < output.length; channel += 1) {
        const sourceChannel = Math.min(channel, this.channels - 1);
        const first = this.sampleAt(0, sourceChannel);
        const second = this.sampleAt(1, sourceChannel);
        const sample = first + (second - first) * this.sourcePosition;
        output[channel][frame] = this.muted ? 0 : sample;
      }
      this.sourcePosition += sourceFramesPerOutputFrame;
      const consumed = Math.floor(this.sourcePosition);
      this.sourcePosition -= consumed;
      this.discardFrames(consumed);
    }
    this.reportCountdown -= frames;
    if (this.reportCountdown <= 0) {
      this.port.postMessage({
        kind: "stats",
        depthMs: (this.bufferedFrames * 1_000) / this.sampleRateHz,
        droppedPackets: this.droppedPackets,
      });
      this.droppedPackets = 0;
      this.reportCountdown = Math.round(outputRate / 4);
    }
    return true;
  }
}

registerProcessor("crabfleet-remote-audio", CrabfleetRemoteAudioProcessor);
