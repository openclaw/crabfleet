import assert from "node:assert/strict";
import test from "node:test";

import {
  TerminalMessageType,
  TerminalSubscribeFlags,
  decodeJsonPayload,
  decodeTerminalFrame,
  encodeAckPayload,
  encodeSubscribePayload,
  encodeTerminalFrame,
} from "@openclaw/libterminal/protocol";
import type { User } from "../src/worker/models.ts";
import { containerCapabilities, interactiveSession } from "../src/worker/session-model.ts";
import { TerminalHub, type TerminalHubDependencies } from "../src/worker/terminal-hub.ts";
import { sessionRow } from "./helpers/session-row.ts";

type Listener = (event: Event & { data?: unknown; code?: number; reason?: string }) => void;

class TestSocket {
  readyState = WebSocket.OPEN;
  readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
  readonly closed: Array<{ code?: number; reason?: string }> = [];
  accepted = false;
  private readonly listeners = new Map<string, Listener[]>();

  accept(): void {
    this.accepted = true;
  }

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  send(data: string | ArrayBuffer | ArrayBufferView | Blob): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closed.push({ code, reason });
    this.readyState = WebSocket.CLOSED;
  }

  emit(type: string, values: Record<string, unknown> = {}): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(Object.assign(new Event(type), values));
    }
  }
}

function socket(): WebSocket & TestSocket {
  return new TestSocket() as WebSocket & TestSocket;
}

function frame(value: string | ArrayBuffer | ArrayBufferView | Blob) {
  assert.ok(value instanceof Uint8Array);
  const decoded = decodeTerminalFrame(value);
  assert.ok(decoded);
  return decoded;
}

async function flushQueues(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const user: User = {
  subject: "github:42",
  login: "operator",
  email: null,
  name: null,
  role: "owner",
  allowed: true,
  teams: [],
};

const session = interactiveSession(
  sessionRow({
    adapter: "runtime-v1",
    adapter_workspace_id: "workspace-1",
    capabilities_json: JSON.stringify(containerCapabilities),
    status: "ready",
  }),
);

function dependencies(
  client: WebSocket,
  server: WebSocket,
  upstream: WebSocket,
  overrides: Partial<TerminalHubDependencies> = {},
): TerminalHubDependencies {
  return {
    createSocketPair: () => ({ client, server }),
    upgradeResponse: () => new Response(null, { status: 200 }),
    async canOpenAnonymous() {
      return false;
    },
    async canViewShared() {
      return false;
    },
    async readSession() {
      return session;
    },
    async canViewSession() {
      return true;
    },
    inputGrant: () => async () => true,
    viewGrant: () => async () => true,
    reconcileSubscription: () => () => undefined,
    async openUpstream() {
      return {
        socket: upstream,
        outputAcknowledgements: true,
        async markConnected() {},
      };
    },
    async inputPayloads(_subscription, _user, payload) {
      return [payload];
    },
    async markConnectionFailure() {},
    async markDetached() {},
    ...overrides,
  };
}

test("terminal hub requires an upgrade and authenticated or shared access", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(dependencies(client, server, upstream));

  await assert.rejects(hub.open(new Request("https://fleet.example/api/terminal/ws"), user), {
    message: "websocket upgrade required",
  });
  await assert.rejects(
    hub.open(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { upgrade: "websocket" },
      }),
      null,
    ),
    { message: "unauthorized" },
  );
  assert.equal(server.accepted, false);
});

test("terminal subscriptions conceal hidden lifecycle state like missing sessions", async () => {
  const messages: unknown[] = [];
  for (const visibleSession of [
    null,
    interactiveSession(sessionRow({ id: "hidden", status: "stopped" }), []),
  ]) {
    const client = socket();
    const server = socket();
    const upstream = socket();
    const hub = new TerminalHub(
      dependencies(client, server, upstream, {
        async readSession() {
          return visibleSession;
        },
        async canViewSession() {
          return false;
        },
      }),
    );
    await hub.open(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { upgrade: "websocket" },
      }),
      user,
    );
    server.emit("message", {
      data: encodeTerminalFrame({
        type: TerminalMessageType.Subscribe,
        sessionId: visibleSession?.id ?? "missing",
        payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
      }),
    });
    await flushQueues();
    await flushQueues();
    const error = frame(server.sent.at(-1)!);
    assert.equal(error.type, TerminalMessageType.Error);
    messages.push(decodeJsonPayload(error.payload));
    server.emit("close");
  }

  assert.deepEqual(messages, [
    { error: "interactive session not found" },
    { error: "interactive session not found" },
  ]);
});

test("terminal connection failures retain the original error for mutation policy", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const failure = Object.assign(new Error("owner reconnect required"), { status: 503 });
  let received: unknown;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async openUpstream() {
        throw failure;
      },
      async markConnectionFailure(_user, _session, _message, error) {
        received = error;
      },
    }),
  );
  await hub.open(
    new Request("https://fleet.example/api/terminal/ws", {
      headers: { upgrade: "websocket" },
    }),
    user,
  );
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Subscribe,
      sessionId: session.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  assert.equal(received, failure);
  const error = frame(server.sent.at(-1)!);
  assert.equal(error.type, TerminalMessageType.Error);
  assert.deepEqual(decodeJsonPayload(error.payload), {
    error: "terminal unavailable: owner reconnect required",
  });
  server.emit("close");
});

test("terminal hub routes multiplex frames and explicit output acknowledgements", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let upgraded = false;
  let connected = 0;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      upgradeResponse() {
        upgraded = true;
        return new Response(null, { status: 200 });
      },
      async openUpstream() {
        return {
          socket: upstream,
          outputAcknowledgements: true,
          async markConnected() {
            connected += 1;
          },
        };
      },
    }),
  );

  await hub.open(
    new Request("https://fleet.example/api/terminal/ws", {
      headers: { upgrade: "websocket" },
    }),
    user,
  );

  assert.equal(upgraded, true);
  assert.equal(server.accepted, true);
  const welcome = frame(server.sent[0]!);
  assert.equal(welcome.type, TerminalMessageType.Welcome);
  assert.deepEqual(decodeJsonPayload(welcome.payload), {
    ok: true,
    version: 2,
    multiplex: true,
  });

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Subscribe,
      sessionId: session.id,
      payload: encodeSubscribePayload({
        flags: TerminalSubscribeFlags.OutputAcknowledgements,
        columns: 140,
        rows: 40,
      }),
    }),
  });
  await flushQueues();
  await flushQueues();

  const subscribed = frame(server.sent.at(-1)!);
  assert.equal(subscribed.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(subscribed.payload), {
    type: "subscribed",
    canInput: true,
  });
  assert.equal(connected, 1);

  upstream.emit("message", { data: "output" });
  await flushQueues();
  const output = frame(server.sent.at(-1)!);
  assert.equal(output.type, TerminalMessageType.Output);
  assert.equal(new TextDecoder().decode(output.payload), "output");
  assert.deepEqual(upstream.sent, []);

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Ack,
      sessionId: session.id,
      payload: encodeAckPayload(output.payload.byteLength),
    }),
  });
  await flushQueues();
  assert.deepEqual(upstream.sent, ['{"type":"ack","bytes":6}']);

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Ack,
      sessionId: session.id,
      payload: new Uint8Array([0]),
    }),
  });
  await flushQueues();
  assert.deepEqual(upstream.sent, ['{"type":"ack","bytes":6}']);

  const inputPayload = new TextEncoder().encode("ls\r");
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: session.id,
      payload: inputPayload,
    }),
  });
  await flushQueues();
  assert.deepEqual(new Uint8Array(upstream.sent.at(-1) as Uint8Array), inputPayload);

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Unsubscribe,
      sessionId: session.id,
    }),
  });
  await flushQueues();
  assert.deepEqual(upstream.closed, [{ code: 1000, reason: "unsubscribed" }]);
  server.emit("close");
});

test("terminal hub publishes live controller downgrades and promotions", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let canInput = true;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      inputGrant: () => async () => canInput,
    }),
  );
  await hub.open(
    new Request("https://fleet.example/api/terminal/ws", {
      headers: { upgrade: "websocket" },
    }),
    user,
  );
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Subscribe,
      sessionId: session.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  canInput = false;
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: session.id,
      payload: new TextEncoder().encode("blocked"),
    }),
  });
  await flushQueues();
  assert.equal(frame(server.sent.at(-1)!).type, TerminalMessageType.ControlRevoked);
  assert.deepEqual(upstream.sent, []);

  canInput = true;
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: session.id,
      payload: new TextEncoder().encode("allowed"),
    }),
  });
  await flushQueues();
  assert.equal(frame(server.sent.at(-1)!).type, TerminalMessageType.ControlGranted);
  assert.equal(new TextDecoder().decode(upstream.sent.at(-1) as Uint8Array), "allowed");
  server.emit("close");
});

test("terminal hub immediately acknowledges upstream output when the client opts out", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let openedSize: { cols: number; rows: number } | null = null;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async openUpstream(_request, _user, _session, cols, rows) {
        openedSize = { cols, rows };
        return {
          socket: upstream,
          outputAcknowledgements: true,
          async markConnected() {},
        };
      },
    }),
  );

  await hub.open(
    new Request("https://fleet.example/api/terminal/ws", {
      headers: { upgrade: "websocket" },
    }),
    user,
  );
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Subscribe,
      sessionId: session.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 0, rows: 0 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  assert.deepEqual(openedSize, { cols: 120, rows: 34 });

  upstream.emit("message", { data: "abc" });
  await flushQueues();
  assert.deepEqual(upstream.sent, ['{"type":"ack","bytes":3}']);
  server.emit("close");
});
