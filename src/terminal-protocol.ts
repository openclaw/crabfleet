export const TERMINAL_WS_MAGIC = 0x5943;
export const TERMINAL_WS_VERSION = 1;

export const TerminalMessageType = {
  Hello: 1,
  Welcome: 2,
  Subscribe: 10,
  Unsubscribe: 11,
  Output: 20,
  Snapshot: 21,
  Event: 22,
  Error: 23,
  Input: 30,
  Key: 31,
  Resize: 32,
  Stop: 33,
  ControlRequest: 50,
  ControlDecision: 51,
  ControlGranted: 52,
  ControlRevoked: 53,
  Ping: 60,
  Pong: 61,
  Ack: 62,
} as const;

export type TerminalMessageType = (typeof TerminalMessageType)[keyof typeof TerminalMessageType];

export const TerminalSubscribeFlags = {
  Output: 1 << 0,
  Snapshot: 1 << 1,
  Events: 1 << 2,
  OutputAcknowledgements: 1 << 3,
} as const;

export type TerminalFrame = {
  type: TerminalMessageType;
  sessionId: string;
  payload: Uint8Array;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeTerminalFrame(params: {
  type: TerminalMessageType;
  sessionId?: string;
  payload?: Uint8Array;
}): Uint8Array {
  const sessionId = params.sessionId ?? "";
  const sessionIdBytes = textEncoder.encode(sessionId);
  const payload = params.payload ?? new Uint8Array();
  const headerLength = 2 + 1 + 1 + 4 + sessionIdBytes.length + 4;
  const frame = new Uint8Array(headerLength + payload.length);
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  let offset = 0;
  view.setUint16(offset, TERMINAL_WS_MAGIC, true);
  offset += 2;
  view.setUint8(offset, TERMINAL_WS_VERSION);
  offset += 1;
  view.setUint8(offset, params.type);
  offset += 1;
  view.setUint32(offset, sessionIdBytes.length, true);
  offset += 4;
  frame.set(sessionIdBytes, offset);
  offset += sessionIdBytes.length;
  view.setUint32(offset, payload.length, true);
  offset += 4;
  frame.set(payload, offset);
  return frame;
}

export function decodeTerminalFrame(data: Uint8Array): TerminalFrame | null {
  if (data.byteLength < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let offset = 0;
  if (view.getUint16(offset, true) !== TERMINAL_WS_MAGIC) return null;
  offset += 2;
  if (view.getUint8(offset) !== TERMINAL_WS_VERSION) return null;
  offset += 1;
  const type = view.getUint8(offset) as TerminalMessageType;
  offset += 1;
  const sessionIdLength = view.getUint32(offset, true);
  offset += 4;
  if (offset + sessionIdLength + 4 > data.byteLength) return null;
  const sessionId = textDecoder.decode(data.subarray(offset, offset + sessionIdLength));
  offset += sessionIdLength;
  const payloadLength = view.getUint32(offset, true);
  offset += 4;
  if (offset + payloadLength > data.byteLength) return null;
  return {
    type,
    sessionId,
    payload: data.subarray(offset, offset + payloadLength),
  };
}

export function encodeSubscribePayload(params: {
  flags: number;
  snapshotMinIntervalMs?: number;
  snapshotMaxIntervalMs?: number;
  cols?: number;
  rows?: number;
}): Uint8Array {
  const hasSize = params.cols !== undefined && params.rows !== undefined;
  const payload = new Uint8Array(hasSize ? 20 : 12);
  const view = new DataView(payload.buffer);
  view.setUint32(0, params.flags >>> 0, true);
  view.setUint32(4, (params.snapshotMinIntervalMs ?? 0) >>> 0, true);
  view.setUint32(8, (params.snapshotMaxIntervalMs ?? 0) >>> 0, true);
  if (hasSize) {
    view.setUint32(12, params.cols ?? 0, true);
    view.setUint32(16, params.rows ?? 0, true);
  }
  return payload;
}

export function decodeSubscribePayload(payload: Uint8Array): {
  flags: number;
  snapshotMinIntervalMs: number;
  snapshotMaxIntervalMs: number;
  cols: number | null;
  rows: number | null;
} | null {
  if (payload.byteLength < 12) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    flags: view.getUint32(0, true),
    snapshotMinIntervalMs: view.getUint32(4, true),
    snapshotMaxIntervalMs: view.getUint32(8, true),
    cols: payload.byteLength >= 20 ? view.getUint32(12, true) : null,
    rows: payload.byteLength >= 20 ? view.getUint32(16, true) : null,
  };
}

export function encodeResizePayload(cols: number, rows: number): Uint8Array {
  const payload = new Uint8Array(8);
  const view = new DataView(payload.buffer);
  view.setUint32(0, cols >>> 0, true);
  view.setUint32(4, rows >>> 0, true);
  return payload;
}

export function decodeResizePayload(payload: Uint8Array): { cols: number; rows: number } | null {
  if (payload.byteLength < 8) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { cols: view.getUint32(0, true), rows: view.getUint32(4, true) };
}

export function encodeAckPayload(bytes: number): Uint8Array {
  const payload = new Uint8Array(4);
  new DataView(payload.buffer).setUint32(0, bytes >>> 0, true);
  return payload;
}

export function decodeAckPayload(payload: Uint8Array): number | null {
  if (payload.byteLength < 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(0, true);
}

export function encodeJsonPayload(value: unknown): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

export function decodeJsonPayload<T>(payload: Uint8Array): T | null {
  try {
    return JSON.parse(textDecoder.decode(payload)) as T;
  } catch {
    return null;
  }
}
