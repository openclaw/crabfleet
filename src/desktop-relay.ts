export type DesktopRelayRole = "host" | "viewer";

export type DesktopRelaySocket = {
  readyState: number;
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment(attachment: unknown): void;
  deserializeAttachment(): unknown;
};

export const desktopRelayMaximumMessageBytes = 512 * 1_024;
export const desktopRelayMaximumBufferedBytes = 8 * 1_024;

const webSocketOpen = 1;

type DesktopRelayAttachment = {
  pending: ArrayBuffer[];
  propagateClose: boolean;
  role: DesktopRelayRole;
};

export function attachDesktopRelayPeer(socket: DesktopRelaySocket, role: DesktopRelayRole): void {
  socket.serializeAttachment({ pending: [], propagateClose: true, role });
}

export function desktopRelayRole(tags: readonly string[]): DesktopRelayRole | null {
  if (tags.includes("desktop-relay-host")) return "host";
  if (tags.includes("desktop-relay-viewer")) return "viewer";
  return null;
}

export function replaceDesktopRelayPeer(
  peers: readonly DesktopRelaySocket[],
  role: DesktopRelayRole,
): number {
  let replaced = 0;
  for (const peer of peers) {
    if (peer.readyState > webSocketOpen) continue;
    setDesktopRelayClosePropagation(peer, false);
    peer.close(1000, `${role} replaced`);
    replaced += 1;
  }
  return replaced;
}

export function relayDesktopMessage(
  sender: DesktopRelaySocket,
  message: string | ArrayBuffer,
  targets: readonly DesktopRelaySocket[],
): number {
  if (typeof message === "string") {
    sender.close(1003, "binary messages required");
    return 0;
  }
  if (message.byteLength > desktopRelayMaximumMessageBytes) {
    sender.close(1009, "relay message exceeds 512 KiB");
    return 0;
  }

  const target = targets.find((peer) => peer.readyState === webSocketOpen);
  if (!target) {
    bufferDesktopRelayMessage(sender, message);
    return 0;
  }
  try {
    target.send(message);
    return 1;
  } catch {
    target.close(1011, "relay send failed");
    return 0;
  }
}

export function closeDesktopRelayPeers(
  peers: readonly DesktopRelaySocket[],
  role: DesktopRelayRole,
): number {
  let closed = 0;
  for (const peer of peers) {
    if (peer.readyState > webSocketOpen) continue;
    setDesktopRelayClosePropagation(peer, false);
    peer.close(1000, `${role} disconnected`);
    closed += 1;
  }
  return closed;
}

export function desktopRelayShouldPropagateClose(socket: DesktopRelaySocket): boolean {
  return desktopRelayAttachment(socket)?.propagateClose === true;
}

export function flushDesktopRelayBuffer(
  source: DesktopRelaySocket,
  target: DesktopRelaySocket,
): number {
  const attachment = desktopRelayAttachment(source);
  if (!attachment?.pending.length || target.readyState !== webSocketOpen) return 0;
  let sent = 0;
  try {
    for (const message of attachment.pending) {
      target.send(message);
      sent += 1;
    }
  } catch {
    target.close(1011, "relay send failed");
    return 0;
  }
  source.serializeAttachment({ ...attachment, pending: [] });
  return sent;
}

function bufferDesktopRelayMessage(socket: DesktopRelaySocket, message: ArrayBuffer): void {
  const attachment = desktopRelayAttachment(socket);
  if (!attachment) {
    socket.close(1008, "unknown relay peer");
    return;
  }
  const pendingBytes = attachment.pending.reduce((total, value) => total + value.byteLength, 0);
  if (pendingBytes + message.byteLength > desktopRelayMaximumBufferedBytes) {
    socket.close(1009, "relay pre-peer buffer exceeded");
    return;
  }
  try {
    socket.serializeAttachment({
      ...attachment,
      pending: [...attachment.pending, message.slice(0)],
    });
  } catch {
    socket.close(1011, "relay buffer failed");
  }
}

function setDesktopRelayClosePropagation(socket: DesktopRelaySocket, enabled: boolean): void {
  const attachment = desktopRelayAttachment(socket);
  if (attachment) socket.serializeAttachment({ ...attachment, propagateClose: enabled });
}

function desktopRelayAttachment(socket: DesktopRelaySocket): DesktopRelayAttachment | null {
  const value = socket.deserializeAttachment();
  if (!value || typeof value !== "object") return null;
  const attachment = value as Partial<DesktopRelayAttachment>;
  if (
    (attachment.role !== "host" && attachment.role !== "viewer") ||
    typeof attachment.propagateClose !== "boolean" ||
    !Array.isArray(attachment.pending) ||
    attachment.pending.some((message) => !(message instanceof ArrayBuffer))
  ) {
    return null;
  }
  return attachment as DesktopRelayAttachment;
}
