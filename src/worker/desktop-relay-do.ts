import { DurableObject } from "cloudflare:workers";

import {
  attachDesktopRelayPeer,
  closeDesktopRelayPeers,
  desktopRelayRole,
  desktopRelayShouldPropagateClose,
  flushDesktopRelayBuffer,
  relayDesktopMessage,
  replaceDesktopRelayPeer,
  type DesktopRelayRole,
} from "../desktop-relay.ts";
import type { RuntimeEnv } from "./env.ts";
import { json } from "./http.ts";

export class DesktopRelayDO extends DurableObject<RuntimeEnv> {
  override fetch(request: Request): Response {
    const url = new URL(request.url);
    if (request.method !== "GET") return json({ error: "not found" }, { status: 404 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket upgrade required" }, { status: 400 });
    }
    if (url.pathname === "/api/desktop-relay/host") return this.open("host");
    if (url.pathname === "/api/desktop-relay/viewer") return this.open("viewer");
    return json({ error: "not found" }, { status: 404 });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role = desktopRelayRole(this.ctx.getTags(socket));
    if (!role) {
      socket.close(1008, "unknown relay peer");
      return;
    }
    relayDesktopMessage(socket, message, this.ctx.getWebSockets(this.oppositeTag(role)));
  }

  override webSocketClose(socket: WebSocket): void {
    const role = desktopRelayRole(this.ctx.getTags(socket));
    if (!role || !desktopRelayShouldPropagateClose(socket)) return;
    closeDesktopRelayPeers(this.ctx.getWebSockets(this.oppositeTag(role)), role);
  }

  override webSocketError(socket: WebSocket): void {
    const role = desktopRelayRole(this.ctx.getTags(socket));
    if (role) closeDesktopRelayPeers(this.ctx.getWebSockets(this.oppositeTag(role)), role);
    socket.close(1011, "relay peer error");
  }

  private open(role: DesktopRelayRole): Response {
    const replaced = replaceDesktopRelayPeer(this.ctx.getWebSockets(this.tag(role)), role);
    if (replaced > 0) {
      closeDesktopRelayPeers(this.ctx.getWebSockets(this.oppositeTag(role)), role);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    attachDesktopRelayPeer(server, role);
    this.ctx.acceptWebSocket(server, [this.tag(role)]);
    const opposite = this.ctx
      .getWebSockets(this.oppositeTag(role))
      .find((socket) => socket.readyState === WebSocket.OPEN);
    if (opposite) flushDesktopRelayBuffer(opposite, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private tag(role: DesktopRelayRole): string {
    return `desktop-relay-${role}`;
  }

  private oppositeTag(role: DesktopRelayRole): string {
    return this.tag(role === "host" ? "viewer" : "host");
  }
}
