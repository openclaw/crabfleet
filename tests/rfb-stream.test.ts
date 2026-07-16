import assert from "node:assert/strict";
import test from "node:test";

import { WebSocketByteStream } from "../src/app/rfb/stream.ts";

test("WebSocket byte stream ignores message boundaries and chunks large sends", async () => {
  const socket = new FakeWebSocket();
  installWebSocketConstant();
  const stream = new WebSocketByteStream(socket as never);
  socket.emit("message", { data: new Uint8Array([1, 2]).buffer });
  socket.emit("message", { data: new Uint8Array([3, 4, 5]).buffer });

  assert.deepEqual(await stream.readExactly(4), new Uint8Array([1, 2, 3, 4]));
  assert.deepEqual(await stream.readExactly(1), new Uint8Array([5]));

  stream.send(new Uint8Array(512 * 1024 + 1));
  assert.deepEqual(
    socket.sent.map((part) => part.byteLength),
    [256 * 1024, 256 * 1024, 1],
  );
});

test("WebSocket byte stream closes oversized relay messages", () => {
  const socket = new FakeWebSocket();
  installWebSocketConstant();
  new WebSocketByteStream(socket as never);
  socket.emit("message", { data: new Uint8Array(512 * 1024 + 1).buffer });
  assert.deepEqual(socket.closed, { code: 4009, reason: "RFB message exceeded" });
});

function installWebSocketConstant(): void {
  Object.defineProperty(globalThis, "WebSocket", {
    configurable: true,
    value: { OPEN: 1, CLOSING: 2 },
  });
}

class FakeWebSocket {
  binaryType = "";
  readyState = 1;
  sent: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  #listeners = new Map<string, Array<(event: never) => void>>();

  addEventListener(type: string, listener: (event: never) => void): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
    this.readyState = 2;
  }

  emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event as never);
  }
}
