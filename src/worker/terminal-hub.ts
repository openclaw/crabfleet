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
import {
  createGitHubActionsRelayInputId,
  encodeGitHubActionsRelayInput,
  githubActionsRuntime,
  parseGitHubActionsRelayInputAcknowledgement,
  parseGitHubActionsRelayOutput,
  parseGitHubActionsRelayEvent,
  type GitHubActionsRelayInputAcknowledgement,
} from "../github-actions-runtime.ts";
import { redactedAdapterMessage } from "../runtime-adapter.ts";
import { badRequest, unauthorized } from "./http.ts";
import type { User } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

const encoder = new TextEncoder();
const terminalMaxFrameBytes = 16 * 1024 * 1024;
const terminalFrameLimits = { maxFrameBytes: terminalMaxFrameBytes };
const terminalInputQueueMaxBytes = terminalMaxFrameBytes;
const terminalInputQueueMaxFrames = 32;
const terminalInputAcknowledgementTimeoutMs = 5_000;
const terminalPreAuthorizationRelayEventMax = 32;

type PendingTerminalInputAcknowledgement = {
  inputId: string;
  runnerGeneration: number | string;
  promise: Promise<TerminalInputAcknowledgementResult>;
  resolve(result: TerminalInputAcknowledgementResult): void;
  timeout: ReturnType<typeof setTimeout>;
};

type TerminalInputAcknowledgementResult = GitHubActionsRelayInputAcknowledgement & {
  deliveryUnknown?: boolean;
};

export type TerminalUpstream = {
  socket: WebSocket;
  markConnected: () => Promise<void>;
  inputAcknowledgements?: boolean;
  inputGenerations?: boolean;
  initialRunnerGeneration?: string | null;
  outputAcknowledgements: boolean;
};

export type TerminalHubSubscription = {
  session: InteractiveSession;
  upstream: WebSocket;
  canView: () => Promise<boolean>;
  canInput: () => Promise<boolean>;
  canInputGranted: boolean;
  markClosing: (reason: string) => void;
  viewCheck: ReturnType<typeof setInterval> | null;
  cols: number;
  rows: number;
  inputAcknowledgements: boolean;
  inputQueue: Promise<void>;
  inputQueueBytes: number;
  inputQueueFrames: number;
  inputQueueRejections: number;
  inputQueueRejectionScheduled: boolean;
  inputGenerations: boolean;
  pendingInputAcknowledgements: Map<string, PendingTerminalInputAcknowledgement>;
  runnerGeneration: number | string;
  outputAcknowledgements: boolean;
  outputAcknowledgementBytes: number;
};

export type TerminalHubDependencies = {
  createSocketPair(): { client: WebSocket; server: WebSocket };
  upgradeResponse(client: WebSocket): Response;
  canOpenAnonymous(request: Request): Promise<boolean>;
  canViewShared(request: Request, sessionId: string): Promise<boolean>;
  readSession(
    request: Request,
    user: User | null,
    sessionId: string,
  ): Promise<InteractiveSession | null>;
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
  releaseInputState(sessionId: string): void;
  markConnectionFailure(
    user: User | null,
    session: InteractiveSession,
    message: string,
    error?: unknown,
  ): Promise<void>;
  markDetached(user: User | null, sessionId: string, message: string): Promise<void>;
  inputAcknowledgementTimeoutMs?: number;
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
      inputAcknowledgements: true,
    });

    const closeSubscription = (id: string, code = 1000, reason = "unsubscribed") => {
      const subscription = subscriptions.get(id);
      if (!subscription) return;
      subscriptions.delete(id);
      this.dependencies.releaseInputState(id);
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
              inputAcknowledgements: true,
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
            if (
              subscription.inputQueueFrames >= terminalInputQueueMaxFrames ||
              subscription.inputQueueBytes + frame.payload.byteLength > terminalInputQueueMaxBytes
            ) {
              scheduleTerminalInputBacklogRejection(server, subscription, frame.sessionId);
              return;
            }
            subscription.inputQueueBytes += frame.payload.byteLength;
            subscription.inputQueueFrames += 1;
            subscription.inputQueue = subscription.inputQueue
              .catch(() => undefined)
              .then(async () => {
                try {
                  const canInput = await subscription.canInput();
                  updateTerminalInputCapability(server, subscription, canInput);
                  if (!canInput) {
                    sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
                      type: "input-rejected",
                      error: "terminal control is not granted",
                    });
                    return;
                  }
                  if (subscription.upstream.readyState !== WebSocket.OPEN) {
                    sendTerminalJson(server, TerminalMessageType.Error, frame.sessionId, {
                      error: "terminal upstream is not open",
                    });
                    return;
                  }
                  const inputs = await this.dependencies.inputPayloads(
                    subscription,
                    user,
                    frame.payload,
                  );
                  const acknowledgements: PendingTerminalInputAcknowledgement[] = [];
                  for (const [index, input] of inputs.entries()) {
                    if (index > 0) await sleep(index === inputs.length - 1 ? 80 : 2);
                    if (
                      subscriptions.get(frame.sessionId) !== subscription ||
                      subscription.upstream.readyState !== WebSocket.OPEN
                    ) {
                      sendTerminalJson(server, TerminalMessageType.Error, frame.sessionId, {
                        error: "terminal upstream is not open",
                      });
                      return;
                    }
                    const inputId = subscription.inputAcknowledgements
                      ? createGitHubActionsRelayInputId()
                      : null;
                    const acknowledgement = inputId
                      ? beginTerminalInputAcknowledgement(
                          subscription,
                          inputId,
                          subscription.runnerGeneration,
                          this.dependencies.inputAcknowledgementTimeoutMs ??
                            terminalInputAcknowledgementTimeoutMs,
                        )
                      : null;
                    if (acknowledgement) acknowledgements.push(acknowledgement);
                    try {
                      subscription.upstream.send(
                        inputId
                          ? encodeGitHubActionsRelayInput(
                              inputId,
                              input,
                              subscription.inputGenerations
                                ? String(subscription.runnerGeneration)
                                : undefined,
                            )
                          : input,
                      );
                    } catch {
                      if (acknowledgement) {
                        completeTerminalInputAcknowledgement(
                          subscription,
                          acknowledgement.inputId,
                          {
                            inputId: acknowledgement.inputId,
                            accepted: false,
                            error: "terminal upstream send failed",
                            ...(subscription.inputGenerations
                              ? { generation: String(acknowledgement.runnerGeneration) }
                              : {}),
                          },
                        );
                        break;
                      }
                      sendTerminalJson(server, TerminalMessageType.Error, frame.sessionId, {
                        error: "terminal upstream send failed",
                      });
                      return;
                    }
                  }
                  await reportTerminalInputCompletion(
                    server,
                    frame.sessionId,
                    acknowledgements.map((acknowledgement) => acknowledgement.promise),
                  );
                } finally {
                  subscription.inputQueueBytes -= frame.payload.byteLength;
                  subscription.inputQueueFrames -= 1;
                }
              });
            return;
          }
          if (frame.type === TerminalMessageType.Resize) {
            const size = tryDecodeResizePayload(frame.payload);
            // Fork the canInput() authorization round-trip and the resize onto the per-subscription
            // queue, exactly as the Input path does. Awaiting canInput() inline here would hold the
            // shared per-connection queue for the duration of a DB call, head-of-line-blocking
            // Input/Subscribe/Stop for every other multiplexed session on this connection.
            subscription.inputQueue = subscription.inputQueue
              .catch(() => undefined)
              .then(async () => {
                const canInput = await subscription.canInput();
                updateTerminalInputCapability(server, subscription, canInput);
                if (!canInput) return;
                if (subscriptions.get(frame.sessionId) !== subscription) return;
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
    const existingSubscription = subscriptions.get(id);
    if (existingSubscription) {
      sendTerminalJson(client, TerminalMessageType.Event, id, {
        type: "subscribed",
        canInput: existingSubscription.canInputGranted,
      });
      return;
    }

    const session = await this.dependencies.readSession(request, user, id);
    if (!session) {
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: "interactive session not found",
      });
      return;
    }
    const canView = user
      ? await this.dependencies.canViewSession(request, user, session)
      : await this.dependencies.canViewShared(request, id);
    if (!canView) {
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
        await this.dependencies.markConnectionFailure(user, session, message, error);
        sendTerminalJson(client, TerminalMessageType.Error, id, { error: message });
        return;
      }
      const upstream = upstreamConnection.socket;
      const inputAcknowledgements =
        upstreamConnection.inputAcknowledgements ?? session.runtime === githubActionsRuntime;
      const inputGenerations = upstreamConnection.inputGenerations ?? false;
      let runnerGeneration: number | string = inputGenerations
        ? (upstreamConnection.initialRunnerGeneration ?? "none")
        : 0;
      const bufferedRelayEvents: Array<
        NonNullable<ReturnType<typeof parseGitHubActionsRelayEvent>>
      > = [];
      let captureRelayEvents = true;
      upstream.addEventListener("message", (event) => {
        if (!captureRelayEvents || !inputAcknowledgements) return;
        const relayEvent = parseSynchronousGitHubActionsRelayEvent(event.data);
        if (!relayEvent) return;
        if (bufferedRelayEvents.length === terminalPreAuthorizationRelayEventMax) {
          bufferedRelayEvents.shift();
        }
        bufferedRelayEvents.push(relayEvent);
        if (relayEvent.generation) {
          if (relayEvent.type === "runner_disconnected") {
            if (runnerGeneration === relayEvent.generation) runnerGeneration = "none";
          } else {
            runnerGeneration = relayEvent.generation;
          }
        } else if (relayEvent.type === "runner_connected" && !inputGenerations) {
          runnerGeneration = (runnerGeneration as number) + 1;
        }
      });
      let canViewNow: boolean;
      try {
        canViewNow = await canView();
      } catch (error) {
        captureRelayEvents = false;
        if (upstream.readyState < WebSocket.CLOSING) {
          upstream.close(1011, "view authorization failed");
        }
        throw error;
      }
      if (!canViewNow) {
        captureRelayEvents = false;
        if (upstream.readyState < WebSocket.CLOSING) upstream.close(1008, "share revoked");
        sendTerminalJson(client, TerminalMessageType.Error, id, {
          error: "interactive session not found",
        });
        return;
      }
      if (!isHubOpen() || client.readyState !== WebSocket.OPEN) {
        captureRelayEvents = false;
        if (upstream.readyState < WebSocket.CLOSING) upstream.close(1000, "client closed");
        return;
      }
      let viewGranted = true;
      let viewCheck: ReturnType<typeof setInterval> | null = null;
      const activeSubscription: TerminalHubSubscription = {
        session,
        upstream,
        canView,
        canInput,
        canInputGranted: canInputNow,
        markClosing,
        viewCheck,
        cols,
        rows,
        inputAcknowledgements,
        inputQueue: Promise.resolve(),
        inputQueueBytes: 0,
        inputQueueFrames: 0,
        inputQueueRejections: 0,
        inputQueueRejectionScheduled: false,
        inputGenerations,
        pendingInputAcknowledgements: new Map(),
        runnerGeneration,
        outputAcknowledgements: outputAcknowledgements && upstreamConnection.outputAcknowledgements,
        outputAcknowledgementBytes: 0,
      };
      const revokeView = () => {
        if (!viewGranted) return;
        viewGranted = false;
        if (viewCheck !== null) clearInterval(viewCheck);
        if (upstream.readyState === WebSocket.OPEN) upstream.close(1008, "share revoked");
        // A canView() from a prior interval tick can still be in flight and resolve here after this
        // subscription was replaced (unsubscribe -> resubscribe); clearInterval does not cancel that
        // pending promise. Don't let the stale closure evict the live resubscription or tell its
        // client the share was revoked — the same identity re-check the close/error handlers use.
        if (subscriptions.get(id) !== activeSubscription) return;
        subscriptions.delete(id);
        this.dependencies.releaseInputState(id);
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
        void canInput()
          .then((allowed) => {
            if (viewGranted) updateTerminalInputCapability(client, activeSubscription, allowed);
          })
          .catch(() => {
            if (viewGranted) updateTerminalInputCapability(client, activeSubscription, false);
          });
      }, 5000);
      activeSubscription.viewCheck = viewCheck;
      captureRelayEvents = false;
      subscriptions.set(id, activeSubscription);
      let outputQueue = Promise.resolve();
      sendTerminalJson(client, TerminalMessageType.Event, id, {
        type: "subscribed",
        canInput: canInputNow,
      });
      upstream.addEventListener("message", (event) => {
        const raw = event.data;
        const receivedRelayEvent = activeSubscription.inputAcknowledgements
          ? parseSynchronousGitHubActionsRelayEvent(raw)
          : null;
        let runnerGenerationAtReceipt = activeSubscription.runnerGeneration;
        if (receivedRelayEvent?.generation) {
          runnerGenerationAtReceipt = receivedRelayEvent.generation;
          if (receivedRelayEvent.type === "runner_disconnected") {
            if (activeSubscription.runnerGeneration === receivedRelayEvent.generation) {
              activeSubscription.runnerGeneration = "none";
            }
          } else {
            activeSubscription.runnerGeneration = receivedRelayEvent.generation;
          }
        } else if (
          receivedRelayEvent?.type === "runner_connected" &&
          !activeSubscription.inputGenerations
        ) {
          runnerGenerationAtReceipt = ++(activeSubscription.runnerGeneration as number);
        }
        outputQueue = outputQueue
          .catch(() => undefined)
          .then(async () => {
            const data = await normalizeWebSocketMessageData(raw);
            if (client.readyState !== WebSocket.OPEN || !viewGranted) return;
            if (activeSubscription.inputAcknowledgements && typeof data !== "string") {
              const inputAcknowledgement = parseGitHubActionsRelayInputAcknowledgement(data);
              if (inputAcknowledgement) {
                completeTerminalInputAcknowledgement(
                  activeSubscription,
                  inputAcknowledgement.inputId,
                  inputAcknowledgement,
                );
                return;
              }
              const relayEvent = receivedRelayEvent ?? parseGitHubActionsRelayEvent(data);
              if (relayEvent) {
                if (relayEvent.type === "runner_disconnected") {
                  if (relayEvent.generation && activeSubscription.inputGenerations) {
                    completeTerminalInputAcknowledgements(
                      activeSubscription,
                      (pending) => pending.runnerGeneration === relayEvent.generation,
                      {
                        accepted: false,
                        deliveryUnknown: true,
                        error:
                          "terminal input delivery outcome is unknown; the runner may still complete it",
                      },
                    );
                  } else {
                    completeAllTerminalInputAcknowledgements(activeSubscription, {
                      accepted: false,
                      deliveryUnknown: true,
                      error:
                        "terminal input delivery outcome is unknown; the runner may still complete it",
                    });
                  }
                } else if (relayEvent.type === "runner_connected") {
                  if (relayEvent.generation && activeSubscription.inputGenerations) {
                    runnerGenerationAtReceipt = relayEvent.generation;
                    activeSubscription.runnerGeneration = relayEvent.generation;
                    completeTerminalInputAcknowledgements(
                      activeSubscription,
                      (pending) => pending.runnerGeneration !== relayEvent.generation,
                      {
                        accepted: false,
                        deliveryUnknown: true,
                        error:
                          "terminal input delivery outcome is unknown; the runner may still complete it",
                      },
                    );
                  } else {
                    if (!receivedRelayEvent) {
                      runnerGenerationAtReceipt = ++(activeSubscription.runnerGeneration as number);
                    }
                    completeTerminalInputAcknowledgementsBeforeGeneration(
                      activeSubscription,
                      runnerGenerationAtReceipt as number,
                      {
                        accepted: false,
                        deliveryUnknown: true,
                        error:
                          "terminal input delivery outcome is unknown; the runner may still complete it",
                      },
                    );
                  }
                } else if (
                  relayEvent.type === "runner_waiting" &&
                  activeSubscription.inputGenerations
                ) {
                  activeSubscription.runnerGeneration = relayEvent.generation ?? "none";
                  completeAllTerminalInputAcknowledgements(activeSubscription, {
                    accepted: false,
                    error: "GitHub Actions runner disconnected before accepting input",
                  });
                }
                sendTerminalJson(client, TerminalMessageType.Event, id, relayEvent);
                return;
              }
              const relayOutput = parseGitHubActionsRelayOutput(data);
              if (!relayOutput) return;
              const output = new Uint8Array(relayOutput);
              sendTerminalFrame(client, TerminalMessageType.Output, id, output);
              if (activeSubscription.outputAcknowledgements) {
                activeSubscription.outputAcknowledgementBytes += output.byteLength;
              } else if (upstreamConnection.outputAcknowledgements) {
                sendOutputAcknowledgement(upstream, output.byteLength);
              }
              return;
            }
            if (typeof data === "string") {
              if (!activeSubscription.inputAcknowledgements) {
                const parsed = parseTerminalControlMessage(data);
                if (parsed) {
                  sendTerminalJson(client, TerminalMessageType.Event, id, parsed);
                  return;
                }
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
      for (const relayEvent of bufferedRelayEvents) {
        sendTerminalJson(client, TerminalMessageType.Event, id, relayEvent);
      }
      upstream.addEventListener("close", (event) => {
        completeAllTerminalInputAcknowledgements(activeSubscription, {
          accepted: false,
          deliveryUnknown: true,
          error: "terminal input delivery outcome is unknown; the runner may still complete it",
        });
        const closeReason = consumeCloseReason();
        const safeUpstreamReason = event.reason
          ? redactedAdapterMessage(
              event.reason,
              "detached",
              [session.adapterWorkspaceId, session.providerResourceId],
              [session.attachUrl],
            )
          : "";
        if (viewCheck !== null) clearInterval(viewCheck);
        // A newer subscription may already own this id (unsubscribe -> immediate resubscribe); this
        // stale upstream's close must not evict the live subscription, release its input state, mark
        // the session detached, or tell the client it closed — the same identity re-check the input
        // loop uses (subscriptions.get(id) !== subscription).
        if (subscriptions.get(id) !== activeSubscription) return;
        subscriptions.delete(id);
        this.dependencies.releaseInputState(id);
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
        completeAllTerminalInputAcknowledgements(activeSubscription, {
          accepted: false,
          deliveryUnknown: true,
          error: "terminal input delivery outcome is unknown; the runner may still complete it",
        });
        const closeReason = closingReason;
        if (viewCheck !== null) clearInterval(viewCheck);
        // A newer subscription may already own this id (unsubscribe -> immediate resubscribe); this
        // stale upstream's error must not evict the live subscription, release its input state, or
        // surface a failure for it — the same identity re-check the input loop uses.
        if (subscriptions.get(id) !== activeSubscription) return;
        subscriptions.delete(id);
        this.dependencies.releaseInputState(id);
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

function beginTerminalInputAcknowledgement(
  subscription: TerminalHubSubscription,
  inputId: string,
  runnerGeneration: number | string,
  timeoutMs: number,
): PendingTerminalInputAcknowledgement {
  let resolve!: (result: TerminalInputAcknowledgementResult) => void;
  const promise = new Promise<TerminalInputAcknowledgementResult>((complete) => {
    resolve = complete;
  });
  const pending: PendingTerminalInputAcknowledgement = {
    inputId,
    runnerGeneration,
    promise,
    resolve,
    timeout: setTimeout(() => {
      if (
        completeAllTerminalInputAcknowledgements(subscription, {
          accepted: false,
          deliveryUnknown: true,
          error: "terminal input delivery outcome is unknown; the runner may still complete it",
        }) === 0
      ) {
        return;
      }
      if (subscription.upstream.readyState === WebSocket.OPEN) {
        subscription.markClosing("input acknowledgement timed out");
        subscription.upstream.close(1011, "input acknowledgement timed out");
      }
    }, timeoutMs),
  };
  subscription.pendingInputAcknowledgements.set(inputId, pending);
  return pending;
}

function scheduleTerminalInputBacklogRejection(
  socket: WebSocket,
  subscription: TerminalHubSubscription,
  sessionId: string,
): void {
  subscription.inputQueueRejections += 1;
  if (subscription.inputQueueRejectionScheduled) return;
  subscription.inputQueueRejectionScheduled = true;
  subscription.inputQueue = subscription.inputQueue
    .catch(() => undefined)
    .then(() => {
      const rejections = subscription.inputQueueRejections;
      subscription.inputQueueRejections = 0;
      subscription.inputQueueRejectionScheduled = false;
      for (let index = 0; index < rejections; index += 1) {
        sendTerminalJson(socket, TerminalMessageType.Event, sessionId, {
          type: "input-rejected",
          error: "terminal input backlog exceeded",
        });
      }
    });
}

function completeTerminalInputAcknowledgement(
  subscription: TerminalHubSubscription,
  inputId: string,
  result: GitHubActionsRelayInputAcknowledgement,
): boolean {
  const pending = subscription.pendingInputAcknowledgements.get(inputId);
  if (!pending) return false;
  if (subscription.inputGenerations && result.generation !== String(pending.runnerGeneration)) {
    return false;
  }
  subscription.pendingInputAcknowledgements.delete(inputId);
  clearTimeout(pending.timeout);
  pending.resolve(result);
  return true;
}

function completeAllTerminalInputAcknowledgements(
  subscription: TerminalHubSubscription,
  result: Omit<TerminalInputAcknowledgementResult, "inputId">,
): number {
  return completeTerminalInputAcknowledgements(subscription, () => true, result);
}

function completeTerminalInputAcknowledgementsBeforeGeneration(
  subscription: TerminalHubSubscription,
  runnerGeneration: number,
  result: Omit<TerminalInputAcknowledgementResult, "inputId">,
): number {
  return completeTerminalInputAcknowledgements(
    subscription,
    (pending) => (pending.runnerGeneration as number) < runnerGeneration,
    result,
  );
}

function completeTerminalInputAcknowledgements(
  subscription: TerminalHubSubscription,
  matches: (pending: PendingTerminalInputAcknowledgement) => boolean,
  result: Omit<TerminalInputAcknowledgementResult, "inputId">,
): number {
  const pending = [...subscription.pendingInputAcknowledgements.values()].filter(matches);
  for (const acknowledgement of pending) {
    subscription.pendingInputAcknowledgements.delete(acknowledgement.inputId);
    clearTimeout(acknowledgement.timeout);
    acknowledgement.resolve({ inputId: acknowledgement.inputId, ...result });
  }
  return pending.length;
}

function parseSynchronousGitHubActionsRelayEvent(
  data: unknown,
): ReturnType<typeof parseGitHubActionsRelayEvent> {
  if (typeof data === "string" || data instanceof ArrayBuffer) {
    return parseGitHubActionsRelayEvent(data);
  }
  if (!ArrayBuffer.isView(data)) return null;
  const copied = new Uint8Array(data.byteLength);
  copied.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  return parseGitHubActionsRelayEvent(copied.buffer);
}

async function reportTerminalInputCompletion(
  socket: WebSocket,
  sessionId: string,
  acknowledgements: Promise<TerminalInputAcknowledgementResult>[],
): Promise<void> {
  if (acknowledgements.length === 0) {
    sendTerminalJson(socket, TerminalMessageType.Event, sessionId, {
      type: "input-accepted",
    });
    return;
  }
  const results = await Promise.all(acknowledgements);
  if (socket.readyState !== WebSocket.OPEN) return;
  const unknown = results.find((result) => result.deliveryUnknown);
  if (unknown) {
    sendTerminalJson(socket, TerminalMessageType.Event, sessionId, {
      type: "input-delivery-unknown",
      error: unknown.error ?? "terminal input delivery outcome is unknown",
    });
    return;
  }
  const rejection = results.find((result) => !result.accepted);
  if (rejection) {
    sendTerminalJson(socket, TerminalMessageType.Event, sessionId, {
      type: "input-rejected",
      error: rejection.error ?? "terminal input was not accepted",
    });
    return;
  }
  sendTerminalJson(socket, TerminalMessageType.Event, sessionId, {
    type: "input-accepted",
  });
}

function updateTerminalInputCapability(
  socket: WebSocket,
  subscription: TerminalHubSubscription,
  canInput: boolean,
): void {
  if (subscription.canInputGranted === canInput) return;
  subscription.canInputGranted = canInput;
  sendTerminalJson(
    socket,
    canInput ? TerminalMessageType.ControlGranted : TerminalMessageType.ControlRevoked,
    subscription.session.id,
    canInput ? { canInput: true } : { canInput: false, error: "terminal control revoked" },
  );
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
    reason === "unsubscribed" ||
    reason === "client closed" ||
    reason === "no terminals mounted" ||
    reason === "input acknowledgement timed out"
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
