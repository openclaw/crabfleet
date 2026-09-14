import { request, state } from "./state.js";

export const supportsWebCodecsH264 = async () => state.media;
export const supportsWebCodecsHEVC = async () => state.media;
export const supportsWebCodecsHEVCRExt = async () => false;
export const supportsWebCodecsAudio = async () => state.media;

export class H264Decoder {
  closed = false;

  constructor() {
    state.decoders.push(this);
  }

  close() {
    this.closed = true;
  }
}

export class HEVCDecoder extends H264Decoder {}

export class RemoteAudioPlayer {
  closed = false;
  muted = true;

  constructor() {
    this.host = state.sockets.at(-1).host;
    state.players.push(this);
  }

  setMuted(muted) {
    this.muted = muted;
  }

  receive() {}

  enableFromGesture() {
    return request("audio", this.host);
  }

  async close() {
    this.closed = true;
  }
}
