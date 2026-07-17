const maximumBufferedBytes = 32 * 1_024 * 1_024;
const maximumMessageBytes = 512 * 1_024;
const sendChunkBytes = 256 * 1_024;

export class WebSocketByteStream {
  readonly socket: WebSocket;
  #chunks: Uint8Array[] = [];
  #bufferedBytes = 0;
  #waiters: Array<() => void> = [];
  #failure: Error | null = null;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event) => this.#receive(event.data));
    socket.addEventListener("close", (event) => {
      this.#fail(new Error(event.reason || `desktop relay closed (${event.code})`));
    });
    socket.addEventListener("error", () => this.#fail(new Error("desktop relay failed")));
  }

  async readExactly(count: number): Promise<Uint8Array> {
    if (!Number.isInteger(count) || count < 0) throw new Error("invalid RFB read size");
    while (this.#bufferedBytes < count) {
      if (this.#failure) throw this.#failure;
      await new Promise<void>((resolve) => this.#waiters.push(resolve));
    }
    const result = new Uint8Array(count);
    let offset = 0;
    while (offset < count) {
      const chunk = this.#chunks[0];
      if (!chunk) throw new Error("RFB stream underflow");
      const take = Math.min(chunk.byteLength, count - offset);
      result.set(chunk.subarray(0, take), offset);
      offset += take;
      this.#bufferedBytes -= take;
      if (take === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(take);
    }
    return result;
  }

  send(data: Uint8Array): void {
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error("desktop relay is not open");
    for (let offset = 0; offset < data.byteLength; offset += sendChunkBytes) {
      this.socket.send(data.slice(offset, offset + sendChunkBytes));
    }
  }

  close(code = 1000, reason = "viewer disconnected"): void {
    const browserCode =
      code === 1000 || (code >= 3000 && code <= 4999)
        ? code
        : 4000 + Math.max(0, Math.min(999, code - 1000));
    if (this.socket.readyState < WebSocket.CLOSING) this.socket.close(browserCode, reason);
  }

  #receive(value: unknown): void {
    if (!(value instanceof ArrayBuffer)) {
      this.#fail(new Error("desktop relay sent a non-binary message"));
      this.close(1003, "binary RFB required");
      return;
    }
    const chunk = new Uint8Array(value);
    if (chunk.byteLength > maximumMessageBytes) {
      this.#fail(new Error("desktop relay message exceeded 512 KiB"));
      this.close(1009, "RFB message exceeded");
      return;
    }
    if (this.#bufferedBytes + chunk.byteLength > maximumBufferedBytes) {
      this.#fail(new Error("desktop relay receive buffer exceeded 32 MiB"));
      this.close(1009, "RFB receive buffer exceeded");
      return;
    }
    if (chunk.byteLength) {
      this.#chunks.push(chunk);
      this.#bufferedBytes += chunk.byteLength;
    }
    this.#wake();
  }

  #fail(error: Error): void {
    if (!this.#failure) this.#failure = error;
    this.#wake();
  }

  #wake(): void {
    for (const resolve of this.#waiters.splice(0)) resolve();
  }
}
