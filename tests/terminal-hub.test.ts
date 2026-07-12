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
import {
  attachGitHubActionsViewerProtocol,
  encodeGitHubActionsRelayInputAcknowledgement,
  encodeGitHubActionsRelayOutput,
  githubActionsFramedRunnerCapability,
  githubActionsGenerationFencedCapability,
  notifyGitHubActionsViewers,
  parseGitHubActionsRelayInput,
} from "../src/github-actions-runtime.ts";
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
  private attachment: unknown;
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

  serializeAttachment(attachment: unknown): void {
    this.attachment = attachment;
  }

  deserializeAttachment(): unknown {
    return this.attachment;
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

function relayInput(value: string | ArrayBuffer | ArrayBufferView | Blob) {
  assert.ok(value instanceof ArrayBuffer);
  const input = parseGitHubActionsRelayInput(value);
  assert.ok(input);
  return {
    inputId: input.inputId,
    generation: input.generation,
    text: new TextDecoder().decode(input.payload),
  };
}

function emitRelayAcknowledgement(
  upstream: TestSocket,
  inputId: string,
  accepted: boolean,
  generation?: string,
): void {
  upstream.emit("message", {
    data: encodeGitHubActionsRelayInputAcknowledgement({
      inputId,
      accepted,
      ...(generation ? { generation } : {}),
    }),
  });
}

function emitRelayEvent(
  upstream: TestSocket,
  type: "runner_connected" | "runner_disconnected" | "runner_waiting",
  generation?: string,
): void {
  const source = socket();
  attachGitHubActionsViewerProtocol(
    source,
    generation ? githubActionsGenerationFencedCapability : githubActionsFramedRunnerCapability,
  );
  notifyGitHubActionsViewers([source], type, generation);
  upstream.emit("message", { data: source.sent[0] });
}

async function flushQueues(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function waitForInputPayloads(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
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

const githubActionsSession = interactiveSession(
  sessionRow({
    adapter: null,
    adapter_workspace_id: null,
    capabilities_json: JSON.stringify(containerCapabilities),
    runtime: "github_actions",
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
    releaseInputState() {},
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
  const releasedInputStates: string[] = [];
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
      releaseInputState(sessionId) {
        releasedInputStates.push(sessionId);
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
    inputAcknowledgements: true,
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
  const inputAccepted = frame(server.sent.at(-1)!);
  assert.equal(inputAccepted.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(inputAccepted.payload), { type: "input-accepted" });

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Unsubscribe,
      sessionId: session.id,
    }),
  });
  await flushQueues();
  assert.deepEqual(upstream.closed, [{ code: 1000, reason: "unsubscribed" }]);
  assert.deepEqual(releasedInputStates, [session.id]);
  server.emit("close");
});

test("duplicate subscriptions preserve the current input capability", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let upstreamOpens = 0;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      inputGrant: () => async () => false,
      async openUpstream() {
        upstreamOpens += 1;
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
  const subscribe = encodeTerminalFrame({
    type: TerminalMessageType.Subscribe,
    sessionId: session.id,
    payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
  });

  server.emit("message", { data: subscribe });
  await flushQueues();
  await flushQueues();
  server.emit("message", { data: subscribe });
  await flushQueues();
  await flushQueues();

  assert.equal(upstreamOpens, 1);
  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "subscribed",
    canInput: false,
  });
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
  assert.equal(frame(server.sent.at(-2)!).type, TerminalMessageType.ControlRevoked);
  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-rejected",
    error: "terminal control is not granted",
  });
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
  assert.equal(
    server.sent.map((payload) => frame(payload).type).at(-2),
    TerminalMessageType.ControlGranted,
  );
  assert.equal(new TextDecoder().decode(upstream.sent.at(-1) as Uint8Array), "allowed");
  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-accepted",
  });
  server.emit("close");
});

test("terminal hub never acknowledges input after its upstream closes", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let resolvePayloads: ((payloads: Uint8Array[]) => void) | undefined;
  const payloads = new Promise<Uint8Array[]>((resolve) => {
    resolvePayloads = resolve;
  });
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async inputPayloads() {
        return payloads;
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

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: session.id,
      payload: new TextEncoder().encode("dropped"),
    }),
  });
  await flushQueues();
  upstream.close(1011, "upstream failed");
  resolvePayloads?.([new TextEncoder().encode("dropped")]);
  await flushQueues();

  assert.deepEqual(upstream.sent, []);
  const messages = server.sent.map((payload) => frame(payload));
  assert.equal(
    messages.some(
      (message) =>
        message.type === TerminalMessageType.Event &&
        (decodeJsonPayload(message.payload) as { type?: string }).type === "input-accepted",
    ),
    false,
  );
  assert.deepEqual(decodeJsonPayload(messages.at(-1)!.payload), {
    error: "terminal upstream is not open",
  });
  server.emit("close");
});

test("GitHub Actions input waits for the correlated runner acknowledgement", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("steer\r"),
    }),
  });
  await flushQueues();

  const input = relayInput(upstream.sent.at(-1)!);
  assert.equal(input.text, "steer\r");
  assert.equal(
    server.sent.some(
      (payload) =>
        frame(payload).type === TerminalMessageType.Event &&
        (decodeJsonPayload(frame(payload).payload) as { type?: string }).type === "input-accepted",
    ),
    false,
  );

  emitRelayAcknowledgement(upstream, input.inputId, true);
  await flushQueues();
  await flushQueues();

  const accepted = frame(server.sent.at(-1)!);
  assert.equal(accepted.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(accepted.payload), { type: "input-accepted" });
  server.emit("close");
});

test("GitHub Actions falls back to raw relay input when viewer negotiation is absent", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async openUpstream() {
        return {
          socket: upstream,
          inputAcknowledgements: false,
          outputAcknowledgements: false,
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("legacy"),
    }),
  });
  await flushQueues();
  await flushQueues();

  assert.equal(new TextDecoder().decode(upstream.sent.at(-1) as Uint8Array), "legacy");
  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-accepted",
  });
  server.emit("close");
});

test("GitHub Actions relay rejection is request-scoped", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("dropped"),
    }),
  });
  await flushQueues();

  const input = relayInput(upstream.sent.at(-1)!);
  emitRelayAcknowledgement(upstream, input.inputId, false);
  await flushQueues();
  await flushQueues();

  const messages = server.sent.map((payload) => frame(payload));
  assert.equal(
    messages.some(
      (message) =>
        message.type === TerminalMessageType.Event &&
        (decodeJsonPayload(message.payload) as { type?: string }).type === "input-accepted",
    ),
    false,
  );
  const rejected = messages.at(-1)!;
  assert.equal(rejected.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(rejected.payload), {
    type: "input-rejected",
    error: "GitHub Actions runner did not accept terminal input",
  });
  assert.equal(upstream.closed.length, 0);

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("retry"),
    }),
  });
  await flushQueues();
  const retry = relayInput(upstream.sent.at(-1)!);
  emitRelayAcknowledgement(upstream, retry.inputId, true);
  await flushQueues();
  await flushQueues();

  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-accepted",
  });
  server.emit("close");
});

test("GitHub Actions input acknowledgements correlate overlapping payloads out of order", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async inputPayloads() {
        return [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("input"),
    }),
  });
  await waitForInputPayloads();

  const inputs = upstream.sent.map(relayInput);
  assert.deepEqual(
    inputs.map((input) => input.text),
    ["first", "second"],
  );
  assert.notEqual(inputs[0]!.inputId, inputs[1]!.inputId);

  emitRelayAcknowledgement(upstream, inputs[1]!.inputId, true);
  emitRelayAcknowledgement(upstream, "stale-input-id", true);
  await flushQueues();
  assert.equal(
    server.sent
      .map((payload) => frame(payload))
      .filter((message) => message.type === TerminalMessageType.Output).length,
    0,
  );
  assert.notDeepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-accepted",
  });

  emitRelayAcknowledgement(upstream, inputs[0]!.inputId, true);
  await flushQueues();
  await flushQueues();

  assert.deepEqual(decodeJsonPayload(frame(server.sent.at(-1)!).payload), {
    type: "input-accepted",
  });
  server.emit("close");
});

test("GitHub Actions serializes completion events for overlapping client inputs", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  for (const text of ["first", "second"]) {
    server.emit("message", {
      data: encodeTerminalFrame({
        type: TerminalMessageType.Input,
        sessionId: githubActionsSession.id,
        payload: new TextEncoder().encode(text),
      }),
    });
  }
  await flushQueues();
  await flushQueues();

  assert.equal(upstream.sent.length, 1);
  const first = relayInput(upstream.sent[0]!);
  assert.equal(first.text, "first");
  emitRelayAcknowledgement(upstream, first.inputId, false);
  await flushQueues();
  await flushQueues();

  assert.equal(upstream.sent.length, 2);
  const second = relayInput(upstream.sent[1]!);
  assert.equal(second.text, "second");
  emitRelayAcknowledgement(upstream, second.inputId, true);
  await flushQueues();
  await flushQueues();

  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(
    completions.map((message) => message.type),
    ["input-rejected", "input-accepted"],
  );
  server.emit("close");
});

test("terminal input queue rejects excess frames after earlier completions", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let releaseFirstInput: (() => void) | undefined;
  const firstInput = new Promise<void>((resolve) => {
    releaseFirstInput = resolve;
  });
  let inputCalls = 0;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async inputPayloads(_subscription, _user, payload) {
        inputCalls += 1;
        if (inputCalls === 1) await firstInput;
        return [payload];
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

  for (let index = 0; index < 128; index += 1) {
    server.emit("message", {
      data: encodeTerminalFrame({
        type: TerminalMessageType.Input,
        sessionId: session.id,
        payload: new Uint8Array([index]),
      }),
    });
  }
  await flushQueues();
  await flushQueues();

  assert.equal(inputCalls, 1);
  assert.equal(upstream.sent.length, 0);
  assert.equal(
    server.sent.some(
      (payload) =>
        (decodeJsonPayload(frame(payload).payload) as { error?: string }).error ===
        "terminal input backlog exceeded",
    ),
    false,
  );

  releaseFirstInput?.();
  await flushQueues();
  await flushQueues();
  await flushQueues();

  assert.equal(inputCalls, 32);
  assert.equal(upstream.sent.length, 32);
  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string; error?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.equal(completions.length, 128);
  assert.deepEqual(completions.slice(0, 32), Array(32).fill({ type: "input-accepted" }));
  assert.deepEqual(
    completions.slice(32),
    Array(96).fill({
      type: "input-rejected",
      error: "terminal input backlog exceeded",
    }),
  );
  server.emit("close");
});

test("terminal input queue enforces the protocol-sized byte budget", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let releaseFirstInput: (() => void) | undefined;
  const firstInput = new Promise<void>((resolve) => {
    releaseFirstInput = resolve;
  });
  let inputCalls = 0;
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async inputPayloads(_subscription, _user, payload) {
        inputCalls += 1;
        if (inputCalls === 1) await firstInput;
        return [payload];
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

  for (const payload of [new Uint8Array(9 * 1024 * 1024), new Uint8Array(8 * 1024 * 1024)]) {
    server.emit("message", {
      data: encodeTerminalFrame(
        {
          type: TerminalMessageType.Input,
          sessionId: session.id,
          payload,
        },
        { maxFrameBytes: 16 * 1024 * 1024 },
      ),
    });
  }
  await flushQueues();
  await flushQueues();
  assert.equal(inputCalls, 1);

  releaseFirstInput?.();
  await flushQueues();
  await flushQueues();

  assert.equal(inputCalls, 1);
  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string; error?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(completions, [
    { type: "input-accepted" },
    { type: "input-rejected", error: "terminal input backlog exceeded" },
  ]);
  server.emit("close");
});

test("GitHub Actions framed output preserves control-shaped terminal bytes", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  const collision = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "stale-input-id",
    accepted: true,
  });
  upstream.emit("message", { data: encodeGitHubActionsRelayOutput(collision) });
  await flushQueues();

  const output = frame(server.sent.at(-1)!);
  assert.equal(output.type, TerminalMessageType.Output);
  assert.deepEqual(output.payload, new Uint8Array(collision));
  server.emit("close");
});

test("a stalled GitHub Actions acknowledgement does not block other sessions or ping", async () => {
  const client = socket();
  const server = socket();
  const firstUpstream = socket();
  const secondUpstream = socket();
  const secondSession = interactiveSession(
    sessionRow({
      id: "IS-actions-second",
      adapter: null,
      adapter_workspace_id: null,
      capabilities_json: JSON.stringify(containerCapabilities),
      runtime: "github_actions",
      status: "ready",
    }),
  );
  const hub = new TerminalHub(
    dependencies(client, server, firstUpstream, {
      async readSession(_request, _user, id) {
        return id === secondSession.id ? secondSession : githubActionsSession;
      },
      async openUpstream(_request, _user, selectedSession) {
        return {
          socket: selectedSession.id === secondSession.id ? secondUpstream : firstUpstream,
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
  for (const selectedSession of [githubActionsSession, secondSession]) {
    server.emit("message", {
      data: encodeTerminalFrame({
        type: TerminalMessageType.Subscribe,
        sessionId: selectedSession.id,
        payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
      }),
    });
  }
  await flushQueues();
  await flushQueues();

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("stalled"),
    }),
  });
  await flushQueues();
  assert.equal(relayInput(firstUpstream.sent[0]!).text, "stalled");

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Ping,
      sessionId: "",
      payload: new TextEncoder().encode("still-live"),
    }),
  });
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: secondSession.id,
      payload: new TextEncoder().encode("independent"),
    }),
  });
  await flushQueues();
  await flushQueues();

  assert.equal(relayInput(secondUpstream.sent[0]!).text, "independent");
  assert.equal(
    server.sent.some((payload) => {
      const message = frame(payload);
      return (
        message.type === TerminalMessageType.Pong &&
        new TextDecoder().decode(message.payload) === "still-live"
      );
    }),
    true,
  );

  const secondInput = relayInput(secondUpstream.sent[0]!);
  emitRelayAcknowledgement(secondUpstream, secondInput.inputId, true);
  await flushQueues();
  assert.equal(
    server.sent.some((payload) => {
      const message = frame(payload);
      return (
        message.type === TerminalMessageType.Event &&
        message.sessionId === secondSession.id &&
        (decodeJsonPayload(message.payload) as { type?: string }).type === "input-accepted"
      );
    }),
    true,
  );

  server.emit("close");
});

test("GitHub Actions send failure removes only its own acknowledgement waiter", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const send = upstream.send.bind(upstream);
  let sendCount = 0;
  upstream.send = (payload) => {
    sendCount += 1;
    if (sendCount === 2) throw new Error("runner disconnected");
    send(payload);
  };
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async inputPayloads() {
        return [new TextEncoder().encode("delivered"), new TextEncoder().encode("failed")];
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("input"),
    }),
  });
  await waitForInputPayloads();
  const input = relayInput(upstream.sent[0]!);
  assert.equal(input.text, "delivered");
  emitRelayAcknowledgement(upstream, input.inputId, true);
  await flushQueues();
  await flushQueues();

  const rejected = frame(server.sent.at(-1)!);
  assert.equal(rejected.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(rejected.payload), {
    type: "input-rejected",
    error: "terminal upstream send failed",
  });
  server.emit("close");
});

test("generation-fenced send failure completes its matching acknowledgement", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async openUpstream() {
        return {
          socket: upstream,
          inputAcknowledgements: true,
          inputGenerations: true,
          outputAcknowledgements: false,
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  emitRelayEvent(upstream, "runner_connected", "generation-one");
  await flushQueues();
  await flushQueues();

  upstream.send = () => {
    throw new Error("runner disconnected");
  };
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("input"),
    }),
  });
  await waitForInputPayloads();
  await flushQueues();

  const rejected = frame(server.sent.at(-1)!);
  assert.equal(rejected.type, TerminalMessageType.Event);
  assert.deepEqual(decodeJsonPayload(rejected.payload), {
    type: "input-rejected",
    error: "terminal upstream send failed",
  });
  assert.deepEqual(upstream.closed, []);
  server.emit("close");
});

test("GitHub Actions close rejects every pending input acknowledgement", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async inputPayloads() {
        return [new TextEncoder().encode("first"), new TextEncoder().encode("second")];
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("input"),
    }),
  });
  await waitForInputPayloads();
  upstream.emit("close", { code: 1011, reason: "runner disconnected" });
  await flushQueues();
  await flushQueues();

  const messages = server.sent.map((payload) => frame(payload));
  assert.equal(
    messages.some(
      (message) =>
        message.type === TerminalMessageType.Event &&
        (decodeJsonPayload(message.payload) as { type?: string }).type === "input-accepted",
    ),
    false,
  );
  assert.equal(
    messages.some(
      (message) =>
        message.type === TerminalMessageType.Event &&
        (decodeJsonPayload(message.payload) as { type?: string; error?: string }).type ===
          "input-rejected" &&
        (decodeJsonPayload(message.payload) as { error?: string }).error ===
          "terminal upstream closed before accepting input",
    ),
    true,
  );
  server.emit("close");
});

test("GitHub Actions runner disconnect rejects pending input without closing the viewer relay", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("pending"),
    }),
  });
  await flushQueues();

  emitRelayEvent(upstream, "runner_disconnected");
  await flushQueues();
  await flushQueues();
  await flushQueues();

  assert.deepEqual(upstream.closed, []);
  const disconnectEvents = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload));
  assert.equal(
    disconnectEvents.some(
      (event) =>
        (event as { type?: string }).type === "input-rejected" &&
        (event as { error?: string }).error ===
          "GitHub Actions runner disconnected before accepting input",
    ),
    true,
    JSON.stringify(disconnectEvents),
  );
  server.emit("close");
});

test("GitHub Actions runner replacement rejects old input and accepts new input", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("old runner"),
    }),
  });
  await flushQueues();
  const oldInput = relayInput(upstream.sent.at(-1)!);

  emitRelayEvent(upstream, "runner_connected");
  await flushQueues();
  await flushQueues();
  await flushQueues();
  assert.deepEqual(upstream.closed, []);
  const replacementEvents = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload));
  assert.equal(
    replacementEvents.some(
      (event) =>
        (event as { type?: string }).type === "input-rejected" &&
        (event as { error?: string }).error ===
          "GitHub Actions runner was replaced before accepting input",
    ),
    true,
    JSON.stringify(replacementEvents),
  );

  emitRelayAcknowledgement(upstream, oldInput.inputId, true);
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("new runner"),
    }),
  });
  await flushQueues();
  await flushQueues();
  const newInput = relayInput(upstream.sent.at(-1)!);
  assert.equal(newInput.text, "new runner");
  emitRelayAcknowledgement(upstream, newInput.inputId, true);
  await flushQueues();
  await flushQueues();

  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(
    completions.map((message) => message.type),
    ["input-rejected", "input-accepted"],
  );
  assert.deepEqual(upstream.closed, []);
  server.emit("close");
});

test("queued runner replacement rejects only acknowledgements sent to the old generation", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let releaseBlockedOutput: ((output: ArrayBuffer) => void) | undefined;
  const blockedOutput = new Promise<ArrayBuffer>((resolve) => {
    releaseBlockedOutput = resolve;
  });
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async inputPayloads() {
        return [new TextEncoder().encode("old runner"), new TextEncoder().encode("new runner")];
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();

  upstream.emit("message", { data: { arrayBuffer: () => blockedOutput } });
  const send = upstream.send.bind(upstream);
  upstream.send = (data) => {
    send(data);
    if (upstream.sent.length === 1) emitRelayEvent(upstream, "runner_connected");
  };
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("split input"),
    }),
  });
  await waitForInputPayloads();

  assert.equal(upstream.sent.length, 2);
  const oldInput = relayInput(upstream.sent[0]!);
  const replacementInput = relayInput(upstream.sent[1]!);
  releaseBlockedOutput?.(encodeGitHubActionsRelayOutput("blocked output"));
  await flushQueues();
  await flushQueues();
  await flushQueues();

  emitRelayAcknowledgement(upstream, oldInput.inputId, true);
  await flushQueues();
  assert.equal(
    server.sent
      .map((payload) => frame(payload))
      .filter((message) => message.type === TerminalMessageType.Event)
      .map((message) => decodeJsonPayload(message.payload) as { type?: string })
      .some((message) => message.type === "input-accepted" || message.type === "input-rejected"),
    false,
  );

  emitRelayAcknowledgement(upstream, replacementInput.inputId, true);
  await flushQueues();
  await flushQueues();

  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string; error?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(completions, [
    {
      type: "input-rejected",
      error: "GitHub Actions runner was replaced before accepting input",
    },
  ]);
  assert.deepEqual(upstream.closed, []);
  server.emit("close");
});

test("relay generations bind interleaved replacement input before lifecycle processing", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let releaseBlockedOutput: ((output: ArrayBuffer) => void) | undefined;
  const blockedOutput = new Promise<ArrayBuffer>((resolve) => {
    releaseBlockedOutput = resolve;
  });
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      async readSession() {
        return githubActionsSession;
      },
      async openUpstream() {
        return {
          socket: upstream,
          inputAcknowledgements: true,
          inputGenerations: true,
          outputAcknowledgements: false,
          async markConnected() {},
        };
      },
      async inputPayloads() {
        return [new TextEncoder().encode("old runner"), new TextEncoder().encode("new runner")];
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  await flushQueues();
  emitRelayEvent(upstream, "runner_connected", "generation-old");
  await flushQueues();
  await flushQueues();

  upstream.emit("message", { data: { arrayBuffer: () => blockedOutput } });
  const send = upstream.send.bind(upstream);
  upstream.send = (data) => {
    send(data);
    if (upstream.sent.length === 1) {
      emitRelayEvent(upstream, "runner_connected", "generation-new");
    }
  };
  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("split input"),
    }),
  });
  await waitForInputPayloads();

  assert.equal(upstream.sent.length, 2);
  const oldInput = relayInput(upstream.sent[0]!);
  const replacementInput = relayInput(upstream.sent[1]!);
  assert.equal(oldInput.generation, "generation-old");
  assert.equal(replacementInput.generation, "generation-new");

  releaseBlockedOutput?.(encodeGitHubActionsRelayOutput("blocked output"));
  await flushQueues();
  await flushQueues();
  await flushQueues();
  assert.equal(
    server.sent
      .map((payload) => frame(payload))
      .filter((message) => message.type === TerminalMessageType.Event)
      .map((message) => decodeJsonPayload(message.payload) as { type?: string })
      .some((message) => message.type === "input-accepted" || message.type === "input-rejected"),
    false,
  );

  emitRelayAcknowledgement(upstream, replacementInput.inputId, true, "generation-new");
  await flushQueues();
  await flushQueues();

  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string; error?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(completions, [
    {
      type: "input-rejected",
      error: "GitHub Actions runner was replaced before accepting input",
    },
  ]);
  assert.deepEqual(upstream.closed, []);
  server.emit("close");
});

test("viewer carries its initial runner generation through authorization setup", async () => {
  const client = socket();
  const server = socket();
  const upstream = socket();
  let releaseView!: (allowed: boolean) => void;
  const viewAllowed = new Promise<boolean>((resolve) => {
    releaseView = resolve;
  });
  const hub = new TerminalHub(
    dependencies(client, server, upstream, {
      viewGrant: () => () => viewAllowed,
      async openUpstream() {
        return {
          socket: upstream,
          inputAcknowledgements: true,
          inputGenerations: true,
          initialRunnerGeneration: "generation-initial",
          outputAcknowledgements: false,
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
      sessionId: githubActionsSession.id,
      payload: encodeSubscribePayload({ flags: 0, columns: 120, rows: 34 }),
    }),
  });
  await flushQueues();
  emitRelayEvent(upstream, "runner_connected", "generation-initial");
  releaseView(true);
  await flushQueues();
  await flushQueues();

  server.emit("message", {
    data: encodeTerminalFrame({
      type: TerminalMessageType.Input,
      sessionId: githubActionsSession.id,
      payload: new TextEncoder().encode("first input"),
    }),
  });
  await waitForInputPayloads();

  const input = relayInput(upstream.sent.at(-1)!);
  assert.equal(input.generation, "generation-initial");
  emitRelayAcknowledgement(upstream, input.inputId, true, "generation-initial");
  await flushQueues();
  await flushQueues();

  const completions = server.sent
    .map((payload) => frame(payload))
    .filter((message) => message.type === TerminalMessageType.Event)
    .map((message) => decodeJsonPayload(message.payload) as { type?: string })
    .filter((message) => message.type === "input-accepted" || message.type === "input-rejected");
  assert.deepEqual(
    completions.map((message) => message.type),
    ["input-accepted"],
  );
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
