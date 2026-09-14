// Local browser test fixture: generated pixels and silent audio only.
export class BrowserHost {
  constructor() {
    this.rtc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.signals = [];
    this.candidates = [];
    this.received = [];
    this.streams = [];
    this.opened = false;
    this.closed = false;
    this.rtc.onicecandidate = ({ candidate }) => {
      if (candidate) this.signals.push({ candidate: candidate.toJSON() });
    };
    this.rtc.ondatachannel = ({ channel }) => {
      if (channel.label !== "rtc" || this.channel) throw new Error("Unexpected test channel");
      this.channel = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => {
        this.opened = true;
      };
      channel.onmessage = ({ data }) => {
        const bytes = new Uint8Array(data);
        if (this.received.length + bytes.length > 1024 * 1024) {
          this.close();
          throw new Error("Test control limit exceeded");
        }
        for (const byte of bytes) this.received.push(byte);
        channel.send(data);
      };
    };
    this.deadline = setTimeout(() => this.close(), 60000);
  }

  async accept(kind, sdp) {
    await this.rtc.setRemoteDescription({ type: kind, sdp });
    for (const candidate of this.candidates.splice(0)) await this.rtc.addIceCandidate(candidate);
    if (kind === "offer") {
      await this.rtc.setLocalDescription(await this.rtc.createAnswer());
      this.signals.push({ description: this.rtc.localDescription.toJSON() });
    }
  }

  async candidate(candidate, index, mid) {
    const value = { candidate, sdpMLineIndex: index, sdpMid: mid || null };
    if (this.rtc.remoteDescription) await this.rtc.addIceCandidate(value);
    else this.candidates.push(value);
  }

  takeSignals() {
    return this.signals.splice(0);
  }
  receivedBytes() {
    return Uint8Array.from(this.received);
  }

  async addMedia() {
    const canvas = document.createElement("canvas");
    canvas.width = 320;
    canvas.height = 180;
    const paint = () => {
      const context = canvas.getContext("2d");
      context.fillStyle = "#ff0000";
      context.fillRect(0, 0, 320, 180);
    };
    paint();
    this.videoTimer = setInterval(paint, 50);
    const video = canvas.captureStream(15);
    this.streams.push(video);
    this.rtc.addTrack(video.getVideoTracks()[0], video);

    this.audio = new AudioContext({ sampleRate: 48000 });
    const destination = this.audio.createMediaStreamDestination();
    const oscillator = this.audio.createOscillator();
    const gain = this.audio.createGain();
    gain.gain.value = 0;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    this.oscillator = oscillator;
    this.streams.push(destination.stream);
    this.rtc.addTrack(destination.stream.getAudioTracks()[0], destination.stream);

    // Exercise normal browser activation instead of disabling autoplay policy.
    await new Promise((resolve, reject) => {
      const button = document.createElement("button");
      button.id = "start-synthetic-audio";
      button.textContent = "Start silent WebRTC test audio";
      document.body.append(button);
      this.audioButton = button;
      const timer = setTimeout(() => {
        button.remove();
        reject(new Error("Test audio gesture timed out"));
      }, 30000);
      button.onclick = () => {
        this.audio.resume().then(() => {
          clearTimeout(timer);
          button.remove();
          resolve();
        }, reject);
      };
    });
    await this.rtc.setLocalDescription(await this.rtc.createOffer());
    this.signals.push({ description: this.rtc.localDescription.toJSON() });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.deadline);
    clearInterval(this.videoTimer);
    this.audioButton?.remove();
    this.channel?.close();
    this.rtc.close();
    this.oscillator?.stop();
    for (const stream of this.streams) for (const track of stream.getTracks()) track.stop();
    if (this.audio) await this.audio.close();
  }
}

export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function decodedAudio(rtc) {
  let samples = 0;
  const stats = await rtc.getStats();
  for (const value of stats.values()) {
    if (value.type === "inbound-rtp" && value.kind === "audio") {
      const codec = stats.get(value.codecId);
      if (codec?.mimeType?.toLowerCase() === "audio/opus")
        samples += value.totalSamplesReceived || 0;
    }
  }
  return samples;
}

export function tracksStopped(stream) {
  return stream.getTracks().every((track) => track.readyState === "ended");
}
