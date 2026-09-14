import { deferred, request, state } from "./state.js";

export class RFBClient {
  width = 800;
  height = 600;
  finished = deferred();

  constructor(stream, callbacks) {
    this.host = stream.socket.host;
    this.callbacks = callbacks;
    state.clients.push(this);
  }

  start() {
    this.callbacks.onServerInit({
      name: `Desktop ${this.host}`,
      codec: "JPEG",
      width: 800,
      height: 600,
    });
    this.callbacks.onState("Connected");
    this.callbacks.onReady();
    this.callbacks.onFileSharing({ displayName: "Synthetic folder", allowWrites: true });
    if (state.media) this.callbacks.onAudio({ kind: "config" });
    state.nextReady.resolve();
    return this.finished.promise;
  }

  disconnect() {
    this.finished.resolve();
  }

  resize() {}

  setQualityMode(mode) {
    this.quality = mode;
  }

  listFiles(path) {
    return request("list", this.host, path);
  }

  uploadFile(path) {
    return request("upload", this.host, path);
  }

  downloadFile(path) {
    return request("download", this.host, path);
  }

  createDirectory(path) {
    return request("mkdir", this.host, path);
  }

  sendClipboardText(text) {
    return request("send", this.host, text);
  }
}
