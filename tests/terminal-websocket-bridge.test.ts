import assert from "node:assert/strict";
import test from "node:test";

import {
	bridgeWebSockets,
	sendTerminalOutputAcknowledgement,
	terminalMessageByteLength,
	terminalOutputAcknowledgement,
	terminalOutputAcknowledgements,
	webSocketMessageData,
} from "../src/worker/terminal-websocket-bridge.ts";

type Listener = (event: Event & { data?: unknown; code?: number; reason?: string }) => void;

class TestSocket {
	readyState = WebSocket.OPEN;
	readonly sent: Array<string | ArrayBuffer | ArrayBufferView | Blob> = [];
	readonly closed: Array<{ code?: number; reason?: string }> = [];
	private readonly listeners = new Map<string, Listener[]>();

	addEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	removeEventListener(type: string, listener: Listener): void {
		const listeners = this.listeners.get(type) ?? [];
		this.listeners.set(
			type,
			listeners.filter((candidate) => candidate !== listener),
		);
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

async function flushQueues(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("terminal acknowledgement protocol is explicit and bounded", () => {
	assert.equal(terminalOutputAcknowledgements("wss://terminal.example?flow=ack-v1"), true);
	assert.equal(terminalOutputAcknowledgements("wss://terminal.example?flow=other"), false);
	assert.equal(terminalOutputAcknowledgements("not a url"), false);

	assert.equal(terminalOutputAcknowledgement('{"type":"ack","bytes":12}'), 12);
	assert.equal(terminalOutputAcknowledgement('{"type":"ack","bytes":0}'), null);
	assert.equal(terminalOutputAcknowledgement('{"type":"ack","bytes":1048577}'), null);
	assert.equal(terminalOutputAcknowledgement('{"type":"resize","bytes":12}'), null);
	assert.equal(terminalOutputAcknowledgement(new ArrayBuffer(4)), null);
	assert.equal(terminalMessageByteLength("€"), 3);
	assert.equal(terminalMessageByteLength(new ArrayBuffer(7)), 7);

	const open = socket();
	sendTerminalOutputAcknowledgement(open, 9);
	assert.deepEqual(open.sent, ['{"type":"ack","bytes":9}']);
	open.readyState = WebSocket.CLOSED;
	sendTerminalOutputAcknowledgement(open, 10);
	assert.equal(open.sent.length, 1);
});

test("WebSocket message data preserves text and normalizes binary views", async () => {
	assert.equal(await webSocketMessageData("text"), "text");
	const buffer = new Uint8Array([1, 2, 3]).buffer;
	assert.equal(await webSocketMessageData(buffer), buffer);
	assert.deepEqual(
		new Uint8Array((await webSocketMessageData(new Uint8Array([4, 5]))) as ArrayBuffer),
		new Uint8Array([4, 5]),
	);
	assert.deepEqual(
		new Uint8Array((await webSocketMessageData(new Blob([new Uint8Array([6, 7])]))) as ArrayBuffer),
		new Uint8Array([6, 7]),
	);
	assert.equal(await webSocketMessageData(42), "42");
});

test("terminal bridge queues both directions and forwards earned acknowledgements", async () => {
	const left = socket();
	const right = socket();
	bridgeWebSockets(left, right, { forwardRightOutputAcknowledgements: true });

	right.emit("message", { data: "output" });
	await flushQueues();
	assert.deepEqual(left.sent, ["output"]);

	left.emit("message", { data: '{"type":"ack","bytes":6}' });
	await flushQueues();
	assert.deepEqual(right.sent, ['{"type":"ack","bytes":6}']);

	left.emit("message", { data: "input" });
	await flushQueues();
	assert.deepEqual(right.sent, ['{"type":"ack","bytes":6}', "input"]);
});

test("terminal bridge handles immediate acknowledgements and authorization revocation", async () => {
	const immediateLeft = socket();
	const immediateRight = socket();
	bridgeWebSockets(immediateLeft, immediateRight, { acknowledgeRightOutputImmediately: true });
	immediateRight.emit("message", { data: new Uint8Array([1, 2, 3]) });
	await flushQueues();
	assert.deepEqual(immediateRight.sent, ['{"type":"ack","bytes":3}']);

	const deniedLeft = socket();
	const deniedRight = socket();
	let reconciliations = 0;
	bridgeWebSockets(deniedLeft, deniedRight, {
		canSendLeft: async () => false,
		reconcileSubscription: () => {
			reconciliations += 1;
		},
		deniedReason: "authorization revoked",
	});
	await flushQueues();
	assert.equal(reconciliations, 1);
	assert.deepEqual(deniedLeft.closed, [{ code: 1008, reason: "authorization revoked" }]);
	assert.deepEqual(deniedRight.closed, [{ code: 1008, reason: "authorization revoked" }]);
});

test("terminal bridge propagates sanitized close reasons and peer errors", () => {
	const left = socket();
	const right = socket();
	bridgeWebSockets(left, right);
	left.emit("close", {
		code: 1001,
		reason: "failed at wss://terminal.example/session?token=secret",
	});
	assert.deepEqual(right.closed, [{ code: 1001, reason: "failed at [connection]" }]);

	const errorLeft = socket();
	const errorRight = socket();
	bridgeWebSockets(errorLeft, errorRight);
	errorRight.emit("error");
	assert.deepEqual(errorLeft.closed, [{ code: 1011, reason: "terminal bridge error" }]);
	assert.deepEqual(errorRight.closed, [{ code: 1011, reason: "terminal bridge error" }]);
});
