import {
	bridgeWebSockets as bridgeSharedWebSockets,
	decodeOutputAcknowledgement,
	normalizeWebSocketMessageData,
	sendOutputAcknowledgement,
	terminalMessageByteLength,
	terminalOutputAcknowledgements,
	type WebSocketBridge,
	type WebSocketBridgeOptions,
} from "@openclaw/libterminal/worker";

import { redactedAdapterMessage } from "../runtime-adapter.ts";

export type TerminalWebSocketBridgeOptions = Omit<WebSocketBridgeOptions, "sanitizeCloseReason">;

export function bridgeWebSockets(
	left: WebSocket,
	right: WebSocket,
	options: TerminalWebSocketBridgeOptions = {},
): WebSocketBridge {
	return bridgeSharedWebSockets(left, right, {
		...options,
		sanitizeCloseReason: (reason) => redactedAdapterMessage(reason, "detached"),
	});
}

export const terminalOutputAcknowledgement = decodeOutputAcknowledgement;
export const sendTerminalOutputAcknowledgement = sendOutputAcknowledgement;
export const webSocketMessageData = normalizeWebSocketMessageData;
export { terminalMessageByteLength, terminalOutputAcknowledgements };
