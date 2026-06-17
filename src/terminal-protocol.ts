import {
  TERMINAL_WS_MAGIC,
  TERMINAL_WS_VERSION,
  TerminalMessageType as SharedTerminalMessageTypes,
  TerminalSubscribeFlags as SharedTerminalSubscribeFlags,
  decodeAckPayload as decodeSharedAckPayload,
  decodeJsonPayload as decodeSharedJsonPayload,
  decodeResizePayload as decodeSharedResizePayload,
  decodeSubscribePayload as decodeSharedSubscribePayload,
  encodeAckPayload,
  encodeJsonPayload,
  encodeResizePayload as encodeSharedResizePayload,
  encodeSubscribePayload as encodeSharedSubscribePayload,
  encodeTerminalFrame as encodeSharedTerminalFrame,
  tryDecodeTerminalFrame,
  type TerminalFrame,
  type TerminalMessageType as SharedTerminalMessageType,
} from "@openclaw/libterminal/protocol";

export { TERMINAL_WS_MAGIC, TERMINAL_WS_VERSION, encodeAckPayload, encodeJsonPayload };

export const TerminalMessageType = SharedTerminalMessageTypes;
export const TerminalSubscribeFlags = SharedTerminalSubscribeFlags;
export type TerminalMessageType = SharedTerminalMessageType;
export type { TerminalFrame };

const crabfleetFrameLimits = {
  maxFrameBytes: 16 * 1024 * 1024,
} as const;

export function encodeTerminalFrame(params: {
  type: TerminalMessageType;
  sessionId?: string;
  payload?: Uint8Array;
}): Uint8Array {
  return encodeSharedTerminalFrame(params, crabfleetFrameLimits);
}

export function decodeTerminalFrame(data: Uint8Array): TerminalFrame | null {
  return tryDecodeTerminalFrame(data, crabfleetFrameLimits);
}

export function encodeSubscribePayload(params: {
  flags: number;
  snapshotMinIntervalMs?: number;
  snapshotMaxIntervalMs?: number;
  cols: number;
  rows: number;
}): Uint8Array {
  return encodeSharedSubscribePayload({
    flags: params.flags,
    ...(params.snapshotMinIntervalMs === undefined
      ? {}
      : { snapshotMinIntervalMs: params.snapshotMinIntervalMs }),
    ...(params.snapshotMaxIntervalMs === undefined
      ? {}
      : { snapshotMaxIntervalMs: params.snapshotMaxIntervalMs }),
    columns: params.cols,
    rows: params.rows,
  });
}

export function decodeSubscribePayload(payload: Uint8Array): {
  flags: number;
  snapshotMinIntervalMs: number;
  snapshotMaxIntervalMs: number;
  cols: number;
  rows: number;
} | null {
  return nullable(() => {
    const decoded = decodeSharedSubscribePayload(payload);
    return {
      flags: decoded.flags,
      snapshotMinIntervalMs: decoded.snapshotMinIntervalMs,
      snapshotMaxIntervalMs: decoded.snapshotMaxIntervalMs,
      cols: decoded.columns,
      rows: decoded.rows,
    };
  });
}

export function encodeResizePayload(cols: number, rows: number): Uint8Array {
  return encodeSharedResizePayload({ columns: cols, rows });
}

export function decodeResizePayload(payload: Uint8Array): { cols: number; rows: number } | null {
  return nullable(() => {
    const decoded = decodeSharedResizePayload(payload);
    return { cols: decoded.columns, rows: decoded.rows };
  });
}

export function decodeAckPayload(payload: Uint8Array): number | null {
  return nullable(() => decodeSharedAckPayload(payload));
}

export function decodeJsonPayload<T>(payload: Uint8Array): T | null {
  return nullable(() => decodeSharedJsonPayload(payload) as T);
}

function nullable<T>(decode: () => T): T | null {
  try {
    return decode();
  } catch {
    return null;
  }
}
