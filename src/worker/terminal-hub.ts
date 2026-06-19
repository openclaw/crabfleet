import {
  TERMINAL_WS_VERSION,
  TerminalMessageType,
  TerminalSubscribeFlags,
  decodeAckPayload,
  decodeResizePayload,
  decodeSubscribePayload,
  encodeJsonPayload,
  encodeTerminalFrame,
  tryDecodeTerminalFrame,
} from "@openclaw/libterminal/protocol";
import {
  normalizeWebSocketMessageData,
  sendOutputAcknowledgement,
} from "@openclaw/libterminal/worker";
import { redactedAdapterMessage } from "../runtime-adapter.ts";
import { badRequest, unauthorized } from "./http.ts";
import type { User } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

const encoder = new TextEncoder();
const terminalFrameLimits = { maxFrameBytes: 16 * 1024 * 1024 };

export type TerminalUpstream = {
  socket: WebSocket;
  markConnected: () => Promise<void>;
  outputAcknowledgements: boolean;
};

export type TerminalHubSubscription = {
  session: InteractiveSession;
  upstream: WebSocket;
  canView: () => Promise<boolean>;
  canInput: () => Promise<boolean>;
  markClosing: (reason: string) => void;
  viewCheck: ReturnType<typeof setInterval> | null;
  cols: number;
  rows: number;
  outputAcknowledgements: boolean;
  outputAcknowledgementBytes: number;
};

export type TerminalHubDependencies = {
  createSocketPair(): { client: WebSocket; server: WebSocket };
  upgradeResponse(client: WebSocket): Response;
  canOpenAnonymous(request: Request): Promise<boolean>;
  canViewShared(request: Request, sessionId: string): Promise<boolean>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  canViewSession(
    request: Request,
    user: User | null,
    session: InteractiveSession,
  ): Promise<boolean>;
  inputGrant(
    request: Request,
    user: User | null,
    session: InteractiveSession,
  ): () => Promise<boolean>;
  viewGrant(
    request: Request,
    user: User | null,
    session: InteractiveSession,
  ): () => Promise<boolean>;
  reconcileSubscription(sessionId: string): () => void;
  openUpstream(
    request: Request,
    user: User | null,
    session: InteractiveSession,
    cols: number,
    rows: number,
  ): Promise<TerminalUpstream>;
  inputPayloads(
    subscription: TerminalHubSubscription,
    user: User | null,
    payload: Uint8Array,
  ): Promise<Array<string | ArrayBuffer | ArrayBufferView>>;
  markConnectionFailure(
    user: User | null,
    session: InteractiveSession,
    message: string,
  ): Promise<void>;
  markDetached(user: User | null, sessionId: string, message: string): Promise<void>;
};

type PendingTerminalSubscription = {
  unsubscribeRequested: boolean;
};

export class TerminalHub {
  private readonly dependencies: TerminalHubDependencies;

  constructor(dependencies: TerminalHubDependencies) {
    this.dependencies = dependencies;
  }

  async open(request: Request, user: User | null): Promise<Response> {
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
      throw badRequest("websocket upgrade required");
    }
    if (!user && !(await this.dependencies.canOpenAnonymous(request))) {
      throw unauthorized();
    }

    const { client, server } = this.dependencies.createSocketPair();
    const subscriptions = new Map<string, TerminalHubSubscription>();
    const pendingSubscriptions = new Map<string, PendingTerminalSubscription>();
    let queue = Promise.resolve();
    let hubClosed = false;

    server.accept();
    sendTerminalJson(server, TerminalMessageType.Welcome, "", {
      ok: true,
      version: TERMINAL_WS_VERSION,
      multiplex: true,
    });

    const closeSubscription = (id: string, code = 1000, reason = "unsubscribed") => {
      const subscription = subscriptions.get(id);
      if (!subscription) return;
      subscriptions.delete(id);
      subscription.markClosing(reason);
      if (subscription.viewCheck !== null) clearInterval(subscription.viewCheck);
      if (subscription.upstream.readyState < WebSocket.CLOSING) {
        subscription.upstream.close(code, reason);
      }
    };

    const closeAll = (code = 1000, reason = "client closed") => {
      for (const id of subscriptions.keys()) closeSubscription(id, code, reason);
    };

    server.addEventListener("message", (event) => {
      queue = queue
        .catch(() => undefined)
        .then(async () => {
          const data = await normalizeWebSocketMessageData(event.data);
          const bytes =
            typeof data === "string" ? encoder.encode(data) : new Uint8Array(data.slice(0));
          const frame = tryDecodeTerminalFrame(bytes, terminalFrameLimits);
          if (!frame) {
            sendTerminalJson(server, TerminalMessageType.Error, "", { error: "invalid frame" });
            return;
          }
          if (frame.type === TerminalMessageType.Hello) {
            sendTerminalJson(server, TerminalMessageType.Welcome, "", {
              ok: true,
              version: TERMINAL_WS_VERSION,
              multiplex: true,
            });
            return;
          }
          if (frame.type === TerminalMessageType.Ping) {
            sendTerminalFrame(server, TerminalMessageType.Pong, frame.sessionId, frame.payload);
            return;
          }
          if (frame.type === TerminalMessageType.Subscribe) {
            if (frame.sessionId) {
              const existingPending = pendingSubscriptions.get(frame.sessionId);
              if (existingPending && !existingPending.unsubscribeRequested) {
                sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
                  type: "subscribing",
                });
                return;
              }
            }
            const pending = { unsubscribeRequested: false };
            if (frame.sessionId) pendingSubscriptions.set(frame.sessionId, pending);
            void this.subscribe(
              request,
              user,
              server,
              subscriptions,
              frame,
              () => !hubClosed && !pending.unsubscribeRequested,
            ).finally(() => {
              if (frame.sessionId && pendingSubscriptions.get(frame.sessionId) === pending) {
                pendingSubscriptions.delete(frame.sessionId);
              }
            });
            return;
          }
          if (frame.type === TerminalMessageType.Unsubscribe) {
            const pending = pendingSubscriptions.get(frame.sessionId);
            if (pending) {
              pending.unsubscribeRequested = true;
              return;
            }
            closeSubscription(frame.sessionId);
            return;
          }

          if (pendingSubscriptions.has(frame.sessionId)) {
            sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
              type: "subscribing",
            });
            return;
          }

          const subscription = subscriptions.get(frame.sessionId);
          if (!subscription) {
            sendTerminalJson(server, TerminalMessageType.Error, frame.sessionId, {
              error: "session is not subscribed",
            });
            return;
          }
          if (frame.type === TerminalMessageType.Input || frame.type === TerminalMessageType.Key) {
            if (!(await subscription.canInput())) {
              sendTerminalJson(server, TerminalMessageType.ControlRevoked, frame.sessionId, {
                error: "terminal control has not been granted",
              });
              return;
            }
            if (subscription.upstream.readyState === WebSocket.OPEN) {
              const inputs = await this.dependencies.inputPayloads(
                subscription,
                user,
                frame.payload,
              );
              for (const [index, input] of inputs.entries()) {
                if (index > 0) await sleep(index === inputs.length - 1 ? 80 : 2);
                subscription.upstream.send(input);
              }
            }
            return;
          }
          if (frame.type === TerminalMessageType.Resize) {
            const size = tryDecodeResizePayload(frame.payload);
            if (!(await subscription.canInput())) {
              sendTerminalJson(server, TerminalMessageType.ControlRevoked, frame.sessionId, {
                error: "terminal control has not been granted",
              });
              return;
            }
            if (size) {
              subscription.cols = size.cols;
              subscription.rows = size.rows;
              if (subscription.upstream.readyState === WebSocket.OPEN) {
                subscription.upstream.send(JSON.stringify({ type: "resize", ...size }));
              }
            }
            sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
              type: "resize",
              cols: size?.cols ?? null,
              rows: size?.rows ?? null,
            });
            return;
          }
          if (frame.type === TerminalMessageType.Ack) {
            const bytes = tryDecodeAckPayload(frame.payload);
            if (
              bytes &&
              subscription.outputAcknowledgements &&
              bytes <= subscription.outputAcknowledgementBytes &&
              subscription.upstream.readyState === WebSocket.OPEN
            ) {
              subscription.outputAcknowledgementBytes -= bytes;
              sendOutputAcknowledgement(subscription.upstream, bytes);
            }
            return;
          }
          if (frame.type === TerminalMessageType.Stop) {
            closeSubscription(frame.sessionId, 1000, "stopped by client");
          }
        });
    });

    server.addEventListener("close", () => {
      hubClosed = true;
      closeAll();
    });
    server.addEventListener("error", () => {
      hubClosed = true;
      closeAll(1011, "client error");
    });

    return this.dependencies.upgradeResponse(client);
  }

  private async subscribe(
    request: Request,
    user: User | null,
    client: WebSocket,
    subscriptions: Map<string, TerminalHubSubscription>,
    frame: { sessionId: string; payload: Uint8Array },
    isHubOpen: () => boolean,
  ): Promise<void> {
    const id = frame.sessionId;
    if (!id) {
      sendTerminalJson(client, TerminalMessageType.Error, "", { error: "session id required" });
      return;
    }
    const requestedSubscription = tryDecodeSubscribePayload(frame.payload);
    if (!requestedSubscription) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: "invalid subscribe payload",
      });
      return;
    }
    if (subscriptions.has(id)) {
      sendTerminalJson(client, TerminalMessageType.Event, id, { type: "subscribed" });
      return;
    }

    if (!user && !(await this.dependencies.canViewShared(request, id))) {
      sendTerminalJson(client, TerminalMessageType.Error, id, { error: "unauthorized" });
      return;
    }

    const session = await this.dependencies.readSession(id);
    if (!session) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: "interactive session not found",
      });
      return;
    }
    if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: `session is ${session.status}`,
      });
      return;
    }
    if (!session.capabilities.terminal) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: "session does not advertise terminal access",
      });
      return;
    }
    if (!(await this.dependencies.canViewSession(request, user, session))) {
      sendTerminalJson(client, TerminalMessageType.Error, id, { error: "unauthorized" });
      return;
    }

    try {
      const canInput = this.dependencies.inputGrant(request, user, session);
      const canInputNow = await canInput();
      const canView = this.dependencies.viewGrant(request, user, session);
      const reconcileSubscription = this.dependencies.reconcileSubscription(id);
      const cols = canInputNow ? terminalDimension(requestedSubscription.columns, 120) : 120;
      const rows = canInputNow ? terminalDimension(requestedSubscription.rows, 34) : 34;
      const outputAcknowledgements = Boolean(
        requestedSubscription.flags & TerminalSubscribeFlags.OutputAcknowledgements,
      );
      let closingReason: string | undefined;
      const markClosing = (reason: string) => {
        closingReason = reason;
      };
      const consumeCloseReason = () => {
        const reason = closingReason;
        closingReason = undefined;
        return reason;
      };
      let upstreamConnection: TerminalUpstream;
      try {
        upstreamConnection = await this.dependencies.openUpstream(
          request,
          user,
          session,
          cols,
          rows,
        );
      } catch (error) {
        const message = redactedAdapterMessage(
          `terminal unavailable: ${
            error instanceof Error ? error.message : "terminal connection failed"
          }`,
          "failed",
          [session.adapterWorkspaceId, session.providerResourceId],
          [session.attachUrl],
        );
        await this.dependencies.markConnectionFailure(user, session, message);
        sendTerminalJson(client, TerminalMessageType.Error, id, { error: message });
        return;
      }
      const upstream = upstreamConnection.socket;
      if (!isHubOpen() || client.readyState !== WebSocket.OPEN) {
        if (upstream.readyState < WebSocket.CLOSING) upstream.close(1000, "client closed");
        return;
      }
      let viewGranted = true;
      let viewCheck: ReturnType<typeof setInterval> | null = null;
      const revokeView = () => {
        if (!viewGranted) return;
        viewGranted = false;
        subscriptions.delete(id);
        if (viewCheck !== null) clearInterval(viewCheck);
        if (upstream.readyState === WebSocket.OPEN) upstream.close(1008, "share revoked");
        sendTerminalJson(client, TerminalMessageType.Error, id, {
          error: "terminal share revoked",
        });
      };
      viewCheck = setInterval(() => {
        reconcileSubscription();
        void canView()
          .then((allowed) => {
            if (!allowed) revokeView();
          })
          .catch(() => revokeView());
      }, 5000);
      const activeSubscription: TerminalHubSubscription = {
        session,
        upstream,
        canView,
        canInput,
        markClosing,
        viewCheck,
        cols,
        rows,
        outputAcknowledgements: outputAcknowledgements && upstreamConnection.outputAcknowledgements,
        outputAcknowledgementBytes: 0,
      };
      subscriptions.set(id, activeSubscription);
      let outputQueue = Promise.resolve();
      sendTerminalJson(client, TerminalMessageType.Event, id, {
        type: "subscribed",
        canInput: canInputNow,
      });
      upstream.addEventListener("message", (event) => {
        const raw = event.data;
        outputQueue = outputQueue
          .catch(() => undefined)
          .then(async () => {
            const data = await normalizeWebSocketMessageData(raw);
            if (client.readyState !== WebSocket.OPEN || !viewGranted) return;
            if (typeof data === "string") {
              const parsed = parseTerminalControlMessage(data);
              if (parsed) {
                sendTerminalJson(client, TerminalMessageType.Event, id, parsed);
                return;
              }
              const output = encoder.encode(data);
              sendTerminalFrame(client, TerminalMessageType.Output, id, output);
              if (activeSubscription.outputAcknowledgements) {
                activeSubscription.outputAcknowledgementBytes += output.byteLength;
              } else if (upstreamConnection.outputAcknowledgements) {
                sendOutputAcknowledgement(upstream, output.byteLength);
              }
              return;
            }
            const output = new Uint8Array(data);
            sendTerminalFrame(client, TerminalMessageType.Output, id, output);
            if (activeSubscription.outputAcknowledgements) {
              activeSubscription.outputAcknowledgementBytes += output.byteLength;
            } else if (upstreamConnection.outputAcknowledgements) {
              sendOutputAcknowledgement(upstream, output.byteLength);
            }
          });
      });
      upstream.addEventListener("close", (event) => {
        const closeReason = consumeCloseReason();
        const safeUpstreamReason = event.reason
          ? redactedAdapterMessage(
              event.reason,
              "detached",
              [session.adapterWorkspaceId, session.providerResourceId],
              [session.attachUrl],
            )
          : "";
        subscriptions.delete(id);
        if (viewCheck !== null) clearInterval(viewCheck);
        if (!isPassiveTerminalClose(closeReason)) {
          const message = terminalCloseMessage(event.code, safeUpstreamReason);
          void this.dependencies.markDetached(user, id, message);
        }
        if (client.readyState === WebSocket.OPEN) {
          sendTerminalJson(client, TerminalMessageType.Event, id, {
            type: "closed",
            code: event.code,
            reason: closeReason || safeUpstreamReason,
          });
        }
      });
      upstream.addEventListener("error", () => {
        const closeReason = closingReason;
        subscriptions.delete(id);
        if (viewCheck !== null) clearInterval(viewCheck);
        const message = "terminal unavailable: upstream terminal error";
        if (!isPassiveTerminalClose(closeReason)) {
          void this.dependencies.markConnectionFailure(user, session, message);
          sendTerminalJson(client, TerminalMessageType.Error, id, { error: message });
        }
      });
      void upstreamConnection.markConnected().catch(() => {
        sendTerminalJson(client, TerminalMessageType.Event, id, {
          type: "warning",
          message: "terminal connection state update failed",
        });
      });
    } catch (error) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: redactedAdapterMessage(
          error instanceof Error ? error.message : "terminal subscription failed",
          "failed",
          [session.adapterWorkspaceId, session.providerResourceId],
          [session.attachUrl],
        ),
      });
    }
  }
}

export function sendTerminalFrame(
  socket: WebSocket,
  type: TerminalMessageType,
  sessionId: string,
  payload?: Uint8Array,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      payload
        ? encodeTerminalFrame({ type, sessionId, payload }, terminalFrameLimits)
        : encodeTerminalFrame({ type, sessionId }, terminalFrameLimits),
    );
  }
}

export function sendTerminalJson(
  socket: WebSocket,
  type: TerminalMessageType,
  sessionId: string,
  payload: unknown,
): void {
  sendTerminalFrame(socket, type, sessionId, encodeJsonPayload(payload));
}

export function parseTerminalControlMessage(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
}

function tryDecodeResizePayload(payload: Uint8Array): { cols: number; rows: number } | null {
  try {
    const size = decodeResizePayload(payload);
    return { cols: size.columns, rows: size.rows };
  } catch {
    return null;
  }
}

function tryDecodeAckPayload(payload: Uint8Array): number | null {
  try {
    return decodeAckPayload(payload);
  } catch {
    return null;
  }
}

function tryDecodeSubscribePayload(
  payload: Uint8Array,
): ReturnType<typeof decodeSubscribePayload> | null {
  try {
    return decodeSubscribePayload(payload);
  } catch {
    return null;
  }
}

function terminalDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(300, Math.max(10, Math.trunc(value)));
}

function terminalCloseMessage(code: number, reason: string): string {
  const suffix = reason ? `: ${clean(redactedAdapterMessage(reason, "detached"), 120)}` : "";
  return `PTY detached ${code || 1000}${suffix}`;
}

function isPassiveTerminalClose(reason: string | undefined): boolean {
  return (
    reason === "unsubscribed" || reason === "client closed" || reason === "no terminals mounted"
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
