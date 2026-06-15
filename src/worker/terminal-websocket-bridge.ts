import { redactedAdapterMessage } from "../runtime-adapter.ts";

const encoder = new TextEncoder();

export type TerminalWebSocketBridgeOptions = {
  canSendLeft?: () => Promise<boolean>;
  reconcileSubscription?: () => void;
  deniedReason?: string;
  forwardRightOutputAcknowledgements?: boolean;
  acknowledgeRightOutputImmediately?: boolean;
};

export function bridgeWebSockets(
  left: WebSocket,
  right: WebSocket,
  options: TerminalWebSocketBridgeOptions = {},
): void {
  const {
    canSendLeft,
    reconcileSubscription,
    deniedReason = "terminal control revoked",
    forwardRightOutputAcknowledgements = false,
    acknowledgeRightOutputImmediately = false,
  } = options;
  let leftInputQueue = Promise.resolve();
  let rightOutputQueue = Promise.resolve();
  let controlCheckTimer: ReturnType<typeof setInterval> | undefined;
  let controlCheckInFlight: Promise<void> | undefined;
  let leftCanSend = true;
  let rightOutputAcknowledgementBytes = 0;
  const stopControlCheck = () => {
    if (controlCheckTimer !== undefined) clearInterval(controlCheckTimer);
    controlCheckTimer = undefined;
  };
  const verifyControl = async () => {
    const canSend = canSendLeft ? await canSendLeft().catch(() => false) : true;
    leftCanSend = canSend;
    if (!canSend) {
      stopControlCheck();
      closePair(left, right, 1008, deniedReason);
      return false;
    }
    return true;
  };
  const scheduleControlCheck = () => {
    reconcileSubscription?.();
    if (controlCheckInFlight) return;
    controlCheckInFlight = verifyControl()
      .then(() => undefined)
      .finally(() => {
        controlCheckInFlight = undefined;
      });
  };
  if (canSendLeft) {
    controlCheckTimer = setInterval(() => {
      scheduleControlCheck();
    }, 5000);
    scheduleControlCheck();
  }
  left.addEventListener("message", (event) => {
    const data = event.data;
    leftInputQueue = leftInputQueue
      .catch(() => undefined)
      .then(async () => {
        if (left.readyState !== WebSocket.OPEN || right.readyState !== WebSocket.OPEN) return;
        if (!leftCanSend || !(await verifyControl())) {
          closePair(left, right, 1008, deniedReason);
          return;
        }
        const forwarded = await webSocketMessageData(data);
        const acknowledgedBytes = forwardRightOutputAcknowledgements
          ? terminalOutputAcknowledgement(forwarded)
          : null;
        if (acknowledgedBytes !== null) {
          if (acknowledgedBytes <= rightOutputAcknowledgementBytes) {
            rightOutputAcknowledgementBytes -= acknowledgedBytes;
            sendTerminalOutputAcknowledgement(right, acknowledgedBytes);
          }
          return;
        }
        right.send(forwarded);
      });
  });
  right.addEventListener("message", (event) => {
    const data = event.data;
    rightOutputQueue = rightOutputQueue
      .catch(() => undefined)
      .then(async () => {
        if (left.readyState !== WebSocket.OPEN || right.readyState !== WebSocket.OPEN) return;
        const forwarded = await webSocketMessageData(data);
        left.send(forwarded);
        if (forwardRightOutputAcknowledgements) {
          rightOutputAcknowledgementBytes += terminalMessageByteLength(forwarded);
        } else if (acknowledgeRightOutputImmediately) {
          sendTerminalOutputAcknowledgement(right, terminalMessageByteLength(forwarded));
        }
      });
  });
  left.addEventListener("close", (event) => {
    stopControlCheck();
    closePeer(event, right);
  });
  right.addEventListener("close", (event) => {
    stopControlCheck();
    closePeer(event, left);
  });
  left.addEventListener("error", () => {
    stopControlCheck();
    closePair(left, right, 1011, "peer error");
  });
  right.addEventListener("error", () => {
    stopControlCheck();
    closePair(right, left, 1011, "peer error");
  });
}

export function terminalOutputAcknowledgements(value: string): boolean {
  try {
    return new URL(value).searchParams.get("flow") === "ack-v1";
  } catch {
    return false;
  }
}

export function terminalOutputAcknowledgement(value: string | ArrayBuffer): number | null {
  if (typeof value !== "string" || !value.startsWith("{") || value.length > 100) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const bytes = parsed.bytes;
    return parsed.type === "ack" &&
      Number.isInteger(bytes) &&
      Number(bytes) > 0 &&
      Number(bytes) <= 1024 * 1024
      ? Number(bytes)
      : null;
  } catch {
    return null;
  }
}

export function terminalMessageByteLength(value: string | ArrayBuffer): number {
  return typeof value === "string" ? encoder.encode(value).byteLength : value.byteLength;
}

export function sendTerminalOutputAcknowledgement(socket: WebSocket, bytes: number): void {
  if (bytes > 0 && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ack", bytes }));
  }
}

export async function webSocketMessageData(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    return new Uint8Array(data).buffer;
  }
  if (data instanceof Blob) return await data.arrayBuffer();
  if (
    data &&
    typeof data === "object" &&
    "arrayBuffer" in data &&
    typeof data.arrayBuffer === "function"
  ) {
    return await data.arrayBuffer();
  }
  return String(data);
}

function closePeer(event: CloseEvent, to: WebSocket): void {
  if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) {
    to.close(
      event.code || 1000,
      clean(event.reason ? redactedAdapterMessage(event.reason, "detached") : "peer closed", 120),
    );
  }
}

function closePair(left: WebSocket, right: WebSocket, code: number, reason: string): void {
  if (left.readyState === WebSocket.OPEN || left.readyState === WebSocket.CONNECTING) {
    left.close(code, reason);
  }
  if (right.readyState === WebSocket.OPEN || right.readyState === WebSocket.CONNECTING) {
    right.close(code, reason);
  }
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
