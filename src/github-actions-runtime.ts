export const githubActionsRuntime = "github_actions" as const;

export type GitHubActionsWorkState =
  | "registered"
  | "running"
  | "completed"
  | "blocked"
  | "failed"
  | "canceled";

export type GitHubActionsRelayRole = "runner" | "viewer";

export type GitHubActionsRelaySocket = {
  readyState: number;
  send(message: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  serializeAttachment?(attachment: unknown): void;
  deserializeAttachment?(): unknown;
};

export type GitHubActionsRelayInputAcknowledgement = {
  accepted: boolean;
  error?: string;
  generation?: string;
  inputId: string;
};

export type GitHubActionsRelayInput = {
  generation?: string;
  inputId: string;
  payload: ArrayBuffer;
};

export const githubActionsFramedRunnerCapability = "cfr1-framed-io-v1";
export const githubActionsGenerationFencedCapability = "cfr1-framed-io-v2";
export const githubActionsRunnerProtocolQuery = "runnerProtocol";
export const githubActionsViewerProtocolQuery = "viewerProtocol";
export const githubActionsViewerProtocolHeader = "x-crabfleet-viewer-protocol";
export const githubActionsViewerGenerationHeader = "x-crabfleet-runner-generation";
export type GitHubActionsRelayProtocol =
  | typeof githubActionsFramedRunnerCapability
  | typeof githubActionsGenerationFencedCapability;
export type GitHubActionsRunnerProtocol = GitHubActionsRelayProtocol;
export type GitHubActionsViewerProtocol = GitHubActionsRelayProtocol;

export const githubActionsCapabilities = {
  terminal: true,
  takeover: true,
  vnc: false,
  desktop: false,
  logs: true,
  artifacts: false,
} as const;

const workStates = new Set<GitHubActionsWorkState>([
  "registered",
  "running",
  "completed",
  "blocked",
  "failed",
  "canceled",
]);

const terminalWorkStates = new Set<GitHubActionsWorkState>([
  "completed",
  "blocked",
  "failed",
  "canceled",
]);

const webSocketOpen = 1;
const relayInputRejectedError = "GitHub Actions runner did not accept terminal input";
const relayFrameMagic = new Uint8Array([0x43, 0x46, 0x52, 0x31]);
const relayFrameHeaderBytes = relayFrameMagic.byteLength + 2;
const relayInputFrameType = 1;
const relayInputAcknowledgementFrameType = 2;
const relayEventFrameType = 3;
const relayOutputFrameType = 4;
const relayGenerationInputFrameType = 5;
const relayGenerationInputAcknowledgementFrameType = 6;
const relayGenerationEventFrameType = 7;
const relayInputIdMaximumBytes = 80;
const relayInputIdPattern = /^[A-Za-z0-9_-]+$/;
const relayGenerationMaximumBytes = 80;
const relayGenerationPattern = /^[A-Za-z0-9_-]+$/;
export const githubActionsLegacyRelayGeneration = "legacy";
const relayEventCodes = {
  runner_connected: 1,
  runner_disconnected: 2,
  runner_waiting: 3,
} as const;
const relayEvents = new Map<number, keyof typeof relayEventCodes>(
  Object.entries(relayEventCodes).map(([event, code]) => [
    code,
    event as keyof typeof relayEventCodes,
  ]),
);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type GitHubActionsRelayAttachment = {
  generation?: string;
  protocol?: GitHubActionsRelayProtocol;
};

export function githubActionsRuntimeLabel(runtime: unknown): string {
  return runtime === githubActionsRuntime ? "GitHub Actions" : "";
}

export function buildGitHubActionsRunnerPtyUrl(
  origin: string,
  sessionId: string,
  agentToken: string,
): string {
  const url = new URL(
    `/api/agent/interactive-sessions/${encodeURIComponent(sessionId)}/runner-pty`,
    origin,
  );
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("agentToken", agentToken);
  return url.toString();
}

export function buildGitHubActionsViewerRelayUrl(): string {
  const url = new URL("https://crabfleet.internal/api/session-control/github-actions/viewer");
  url.searchParams.set(githubActionsViewerProtocolQuery, githubActionsGenerationFencedCapability);
  return url.toString();
}

export function gitHubActionsViewerResponseUsesFramedProtocol(response: Response): boolean {
  return isGitHubActionsRelayProtocol(response.headers.get(githubActionsViewerProtocolHeader));
}

export function gitHubActionsViewerResponseUsesGenerations(response: Response): boolean {
  return (
    response.headers.get(githubActionsViewerProtocolHeader) ===
    githubActionsGenerationFencedCapability
  );
}

export function gitHubActionsViewerResponseGeneration(response: Response): string | null {
  const generation = response.headers.get(githubActionsViewerGenerationHeader);
  return isGitHubActionsRelayGeneration(generation) ? generation : null;
}

export function parseGitHubActionsWorkState(value: unknown): GitHubActionsWorkState | null {
  const state = String(value ?? "").trim() as GitHubActionsWorkState;
  return workStates.has(state) ? state : null;
}

export function isTerminalGitHubActionsWorkState(
  state: GitHubActionsWorkState | null | undefined,
): boolean {
  return Boolean(state && terminalWorkStates.has(state));
}

export function gitHubActionsSessionStatus(
  state: GitHubActionsWorkState,
): "ready" | "stopped" | "failed" {
  if (state === "failed") return "failed";
  if (isTerminalGitHubActionsWorkState(state)) return "stopped";
  return "ready";
}

export function gitHubActionsWorkEvent(state: GitHubActionsWorkState, phase: string): string {
  return phase ? `${state}: ${phase}` : state;
}

export function githubActionsRelayRole(tags: readonly string[]): GitHubActionsRelayRole | null {
  if (tags.includes("github-actions-runner")) return "runner";
  if (tags.includes("github-actions-viewer")) return "viewer";
  return null;
}

export function replaceGitHubActionsRunner(
  currentRunners: readonly GitHubActionsRelaySocket[],
  code = 1012,
  reason = "runner replaced",
): number {
  let replaced = 0;
  for (const socket of currentRunners) {
    if (socket.readyState > webSocketOpen) continue;
    socket.close(code, reason);
    replaced += 1;
  }
  return replaced;
}

export function forwardGitHubActionsRelayMessage(
  sender: GitHubActionsRelayRole,
  message: string | ArrayBuffer,
  runners: readonly GitHubActionsRelaySocket[],
  viewers: readonly GitHubActionsRelaySocket[],
): number {
  const targets =
    sender === "runner"
      ? viewers
      : runners.filter((socket) => socket.readyState === webSocketOpen).slice(0, 1);
  let forwarded = 0;
  for (const socket of targets) {
    if (socket.readyState !== webSocketOpen) continue;
    try {
      socket.send(message);
      forwarded += 1;
    } catch {
      // The caller uses the forwarded count to reject undelivered viewer input.
    }
  }
  return forwarded;
}

export function relayGitHubActionsWebSocketMessage(
  sender: GitHubActionsRelayRole,
  senderSocket: GitHubActionsRelaySocket,
  message: string | ArrayBuffer,
  runners: readonly GitHubActionsRelaySocket[],
  viewers: readonly GitHubActionsRelaySocket[],
): number {
  if (sender === "viewer") {
    if (isGitHubActionsViewerControlMessage(message)) return 0;
    const framedViewer = gitHubActionsViewerUsesFramedProtocol(senderSocket);
    const input = framedViewer ? parseGitHubActionsRelayInput(message) : null;
    if (framedViewer && !input) return 0;
    const runner = runners.find((socket) => socket.readyState === webSocketOpen);
    if (!runner) {
      sendGitHubActionsViewerInputAcknowledgement(
        senderSocket,
        input?.inputId ?? null,
        false,
        input?.generation,
      );
      return 0;
    }
    const generation = gitHubActionsRelayGeneration(runner) ?? githubActionsLegacyRelayGeneration;
    if (
      gitHubActionsRelayUsesGenerations(senderSocket) &&
      (!input?.generation || input.generation !== generation)
    ) {
      sendGitHubActionsViewerInputAcknowledgement(
        senderSocket,
        input?.inputId ?? null,
        false,
        input?.generation,
      );
      return 0;
    }
    const framed = gitHubActionsRunnerUsesFramedProtocol(runner);
    try {
      if (framed) {
        runner.send(
          encodeGitHubActionsRelayInput(
            input?.inputId ?? createGitHubActionsRelayInputId(),
            input?.payload ?? message,
            gitHubActionsRelayUsesGenerations(runner) ? generation : undefined,
          ),
        );
      } else {
        runner.send(framedViewer ? input!.payload : message);
      }
      if (!framedViewer || !framed) {
        sendGitHubActionsViewerInputAcknowledgement(
          senderSocket,
          input?.inputId ?? null,
          true,
          input?.generation,
        );
      }
      return 1;
    } catch {
      sendGitHubActionsViewerInputAcknowledgement(
        senderSocket,
        input?.inputId ?? null,
        false,
        input?.generation,
      );
      return 0;
    }
  }

  if (runners.find((socket) => socket.readyState === webSocketOpen) !== senderSocket) {
    return 0;
  }

  if (gitHubActionsRunnerUsesFramedProtocol(senderSocket)) {
    const acknowledgement = parseGitHubActionsRelayInputAcknowledgement(message);
    const output = parseGitHubActionsRelayOutput(message);
    if (!acknowledgement && !output) return 0;
    const generation = gitHubActionsRelayGeneration(senderSocket);
    if (
      acknowledgement &&
      gitHubActionsRelayUsesGenerations(senderSocket) &&
      acknowledgement.generation !== generation
    ) {
      return 0;
    }
    let forwarded = 0;
    for (const viewer of viewers) {
      if (viewer.readyState !== webSocketOpen) continue;
      if (acknowledgement && !gitHubActionsViewerUsesFramedProtocol(viewer)) continue;
      try {
        viewer.send(
          acknowledgement
            ? encodeGitHubActionsRelayInputAcknowledgement({
                ...acknowledgement,
                ...(gitHubActionsRelayUsesGenerations(viewer) && generation ? { generation } : {}),
              })
            : gitHubActionsViewerUsesFramedProtocol(viewer)
              ? message
              : output!,
        );
        forwarded += 1;
      } catch {
        // A failed viewer does not prevent delivery to the remaining viewers.
      }
    }
    return forwarded;
  }

  let forwarded = 0;
  for (const viewer of viewers) {
    if (viewer.readyState !== webSocketOpen) continue;
    try {
      viewer.send(
        gitHubActionsViewerUsesFramedProtocol(viewer)
          ? encodeGitHubActionsRelayOutput(message)
          : message,
      );
      forwarded += 1;
    } catch {
      // A failed viewer does not prevent delivery to the remaining viewers.
    }
  }
  return forwarded;
}

export function sendGitHubActionsRelayInputAcknowledgement(
  viewer: GitHubActionsRelaySocket,
  acknowledgement: GitHubActionsRelayInputAcknowledgement,
): boolean {
  if (viewer.readyState !== webSocketOpen) return false;
  try {
    viewer.send(encodeGitHubActionsRelayInputAcknowledgement(acknowledgement));
    return true;
  } catch {
    return false;
  }
}

export function parseGitHubActionsRelayInputAcknowledgement(
  message: string | ArrayBuffer,
): GitHubActionsRelayInputAcknowledgement | null {
  const legacyFrame = decodeGitHubActionsRelayFrame(message, relayInputAcknowledgementFrameType);
  const generatedFrame = decodeGitHubActionsRelayFrame(
    message,
    relayGenerationInputAcknowledgementFrameType,
  );
  const decoded = generatedFrame
    ? decodeGitHubActionsRelayGeneration(generatedFrame.payload)
    : null;
  const frame = legacyFrame ?? (decoded ? { ...generatedFrame!, payload: decoded.payload } : null);
  if (!frame?.inputId || frame.payload.byteLength < 1) return null;
  const acceptedByte = frame.payload[0];
  if (acceptedByte !== 0 && acceptedByte !== 1) return null;
  const accepted = acceptedByte === 1;
  if (accepted) {
    return {
      inputId: frame.inputId,
      accepted: true,
      ...(decoded ? { generation: decoded.generation } : {}),
    };
  }
  const error = decoder.decode(frame.payload.subarray(1)).trim();
  return {
    inputId: frame.inputId,
    accepted: false,
    error: error || relayInputRejectedError,
    ...(decoded ? { generation: decoded.generation } : {}),
  };
}

export function createGitHubActionsRelayInputId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

export function encodeGitHubActionsRelayInput(
  inputId: string,
  payload: string | ArrayBuffer | ArrayBufferView,
  generation?: string,
): ArrayBuffer {
  requireGitHubActionsRelayInputId(inputId);
  return encodeGitHubActionsRelayFrame(
    generation ? relayGenerationInputFrameType : relayInputFrameType,
    inputId,
    generation
      ? encodeGitHubActionsRelayGeneration(generation, messageBytes(payload))
      : messageBytes(payload),
  );
}

export function encodeGitHubActionsRelayOutput(
  payload: string | ArrayBuffer | ArrayBufferView,
): ArrayBuffer {
  return encodeGitHubActionsRelayFrame(relayOutputFrameType, "", messageBytes(payload));
}

export function parseGitHubActionsRelayOutput(message: string | ArrayBuffer): ArrayBuffer | null {
  const frame = decodeGitHubActionsRelayFrame(message, relayOutputFrameType);
  if (!frame || frame.inputId) return null;
  return Uint8Array.from(frame.payload).buffer;
}

export function parseGitHubActionsRelayInput(
  message: string | ArrayBuffer,
): GitHubActionsRelayInput | null {
  const legacyFrame = decodeGitHubActionsRelayFrame(message, relayInputFrameType);
  const generatedFrame = decodeGitHubActionsRelayFrame(message, relayGenerationInputFrameType);
  const decoded = generatedFrame
    ? decodeGitHubActionsRelayGeneration(generatedFrame.payload)
    : null;
  const frame = legacyFrame ?? (decoded ? { ...generatedFrame!, payload: decoded.payload } : null);
  if (!frame?.inputId) return null;
  return {
    inputId: frame.inputId,
    payload: Uint8Array.from(frame.payload).buffer,
    ...(decoded ? { generation: decoded.generation } : {}),
  };
}

export function parseGitHubActionsRunnerProtocol(
  value: string | null,
): GitHubActionsRunnerProtocol | null {
  return isGitHubActionsRelayProtocol(value) ? value : null;
}

export function parseGitHubActionsViewerProtocol(
  value: string | null,
): GitHubActionsViewerProtocol | null {
  return isGitHubActionsRelayProtocol(value) ? value : null;
}

export function attachGitHubActionsRunnerProtocol(
  socket: GitHubActionsRelaySocket,
  protocol: GitHubActionsRunnerProtocol | null,
  generation?: string,
): void {
  socket.serializeAttachment?.(
    protocol || generation
      ? ({
          ...(protocol ? { protocol } : {}),
          ...(generation ? { generation } : {}),
        } satisfies GitHubActionsRelayAttachment)
      : {},
  );
}

export function attachGitHubActionsViewerProtocol(
  socket: GitHubActionsRelaySocket,
  protocol: GitHubActionsViewerProtocol | null,
): void {
  socket.serializeAttachment?.(
    protocol ? ({ protocol } satisfies GitHubActionsRelayAttachment) : {},
  );
}

export function encodeGitHubActionsRelayInputAcknowledgement(
  acknowledgement: GitHubActionsRelayInputAcknowledgement,
): ArrayBuffer {
  requireGitHubActionsRelayInputId(acknowledgement.inputId);
  const error =
    acknowledgement.accepted || !acknowledgement.error
      ? new Uint8Array()
      : encoder.encode(acknowledgement.error.trim());
  const payload = new Uint8Array(1 + error.byteLength);
  payload[0] = acknowledgement.accepted ? 1 : 0;
  payload.set(error, 1);
  return encodeGitHubActionsRelayFrame(
    acknowledgement.generation
      ? relayGenerationInputAcknowledgementFrameType
      : relayInputAcknowledgementFrameType,
    acknowledgement.inputId,
    acknowledgement.generation
      ? encodeGitHubActionsRelayGeneration(acknowledgement.generation, payload)
      : payload,
  );
}

export function parseGitHubActionsRelayEvent(
  message: string | ArrayBuffer,
): { generation?: string; type: keyof typeof relayEventCodes } | null {
  const legacyFrame = decodeGitHubActionsRelayFrame(message, relayEventFrameType);
  const generatedFrame = decodeGitHubActionsRelayFrame(message, relayGenerationEventFrameType);
  const decoded = generatedFrame
    ? decodeGitHubActionsRelayGeneration(generatedFrame.payload)
    : null;
  const frame = legacyFrame ?? (decoded ? { ...generatedFrame!, payload: decoded.payload } : null);
  if (!frame || frame.inputId || frame.payload.byteLength !== 1) return null;
  const type = relayEvents.get(frame.payload[0] ?? 0);
  return type ? { type, ...(decoded ? { generation: decoded.generation } : {}) } : null;
}

export function isGitHubActionsViewerControlMessage(message: string | ArrayBuffer): boolean {
  if (typeof message !== "string") return false;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    return (
      parsed.type === "resize" && Number.isInteger(parsed.cols) && Number.isInteger(parsed.rows)
    );
  } catch {
    return false;
  }
}

export function notifyGitHubActionsViewers(
  viewers: readonly GitHubActionsRelaySocket[],
  type: "runner_connected" | "runner_disconnected" | "runner_waiting",
  generation?: string,
): number {
  let notified = 0;
  for (const socket of viewers) {
    if (socket.readyState !== webSocketOpen) continue;
    const usesGenerations = gitHubActionsRelayUsesGenerations(socket);
    const framedPayload = encodeGitHubActionsRelayFrame(
      usesGenerations ? relayGenerationEventFrameType : relayEventFrameType,
      "",
      usesGenerations
        ? encodeGitHubActionsRelayGeneration(
            generation ?? "none",
            new Uint8Array([relayEventCodes[type]]),
          )
        : new Uint8Array([relayEventCodes[type]]),
    );
    socket.send(
      gitHubActionsViewerUsesFramedProtocol(socket) ? framedPayload : JSON.stringify({ type }),
    );
    notified += 1;
  }
  return notified;
}

function encodeGitHubActionsRelayFrame(
  type: number,
  inputId: string,
  payload: Uint8Array,
): ArrayBuffer {
  const inputIdBytes = encoder.encode(inputId);
  if (
    inputIdBytes.byteLength > relayInputIdMaximumBytes ||
    (inputId && !relayInputIdPattern.test(inputId))
  ) {
    throw new Error("invalid GitHub Actions relay input id");
  }
  const frame = new Uint8Array(
    relayFrameHeaderBytes + inputIdBytes.byteLength + payload.byteLength,
  );
  frame.set(relayFrameMagic, 0);
  frame[relayFrameMagic.byteLength] = type;
  frame[relayFrameMagic.byteLength + 1] = inputIdBytes.byteLength;
  frame.set(inputIdBytes, relayFrameHeaderBytes);
  frame.set(payload, relayFrameHeaderBytes + inputIdBytes.byteLength);
  return frame.buffer;
}

function decodeGitHubActionsRelayFrame(
  message: string | ArrayBuffer,
  expectedType: number,
): { inputId: string; payload: Uint8Array } | null {
  if (typeof message === "string") return null;
  const frame = new Uint8Array(message);
  if (frame.byteLength < relayFrameHeaderBytes) return null;
  for (const [index, value] of relayFrameMagic.entries()) {
    if (frame[index] !== value) return null;
  }
  if (frame[relayFrameMagic.byteLength] !== expectedType) return null;
  const inputIdBytes = frame[relayFrameMagic.byteLength + 1] ?? 0;
  if (
    inputIdBytes > relayInputIdMaximumBytes ||
    relayFrameHeaderBytes + inputIdBytes > frame.byteLength
  ) {
    return null;
  }
  const inputId = decoder.decode(
    frame.subarray(relayFrameHeaderBytes, relayFrameHeaderBytes + inputIdBytes),
  );
  if (inputId && !relayInputIdPattern.test(inputId)) return null;
  return {
    inputId,
    payload: frame.subarray(relayFrameHeaderBytes + inputIdBytes),
  };
}

function messageBytes(message: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof message === "string") return encoder.encode(message);
  if (ArrayBuffer.isView(message)) {
    return new Uint8Array(message.buffer, message.byteOffset, message.byteLength);
  }
  return new Uint8Array(message);
}

function requireGitHubActionsRelayInputId(inputId: string): void {
  if (!inputId) throw new Error("invalid GitHub Actions relay input id");
}

export function gitHubActionsRunnerUsesFramedProtocol(socket: GitHubActionsRelaySocket): boolean {
  return gitHubActionsRelayUsesFramedProtocol(socket);
}

export function gitHubActionsViewerUsesFramedProtocol(socket: GitHubActionsRelaySocket): boolean {
  return gitHubActionsRelayUsesFramedProtocol(socket);
}

export function gitHubActionsRelayGeneration(socket: GitHubActionsRelaySocket): string | undefined {
  const attachment = socket.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") return undefined;
  const generation = (attachment as GitHubActionsRelayAttachment).generation;
  return isGitHubActionsRelayGeneration(generation) ? generation : undefined;
}

export function gitHubActionsRelayUsesGenerations(socket: GitHubActionsRelaySocket): boolean {
  const attachment = socket.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") return false;
  return (
    (attachment as GitHubActionsRelayAttachment).protocol ===
    githubActionsGenerationFencedCapability
  );
}

export function createGitHubActionsRelayGeneration(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function gitHubActionsRelayUsesFramedProtocol(socket: GitHubActionsRelaySocket): boolean {
  const attachment = socket.deserializeAttachment?.();
  if (!attachment || typeof attachment !== "object") return false;
  return isGitHubActionsRelayProtocol((attachment as GitHubActionsRelayAttachment).protocol);
}

function sendGitHubActionsViewerInputAcknowledgement(
  viewer: GitHubActionsRelaySocket,
  inputId: string | null,
  accepted: boolean,
  generation?: string,
): boolean {
  if (inputId) {
    return sendGitHubActionsRelayInputAcknowledgement(viewer, {
      inputId,
      accepted,
      ...(gitHubActionsRelayUsesGenerations(viewer) ? { generation: generation ?? "none" } : {}),
    });
  }
  if (viewer.readyState !== webSocketOpen) return false;
  try {
    viewer.send(
      JSON.stringify({
        type: "github_actions_input_ack",
        accepted,
        ...(accepted ? {} : { error: relayInputRejectedError }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function isGitHubActionsRelayProtocol(value: unknown): value is GitHubActionsRelayProtocol {
  return (
    value === githubActionsFramedRunnerCapability ||
    value === githubActionsGenerationFencedCapability
  );
}

function isGitHubActionsRelayGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    encoder.encode(value).byteLength <= relayGenerationMaximumBytes &&
    relayGenerationPattern.test(value)
  );
}

function encodeGitHubActionsRelayGeneration(generation: string, payload: Uint8Array): Uint8Array {
  if (!isGitHubActionsRelayGeneration(generation)) {
    throw new Error("invalid GitHub Actions relay generation");
  }
  const generationBytes = encoder.encode(generation);
  const generatedPayload = new Uint8Array(1 + generationBytes.byteLength + payload.byteLength);
  generatedPayload[0] = generationBytes.byteLength;
  generatedPayload.set(generationBytes, 1);
  generatedPayload.set(payload, 1 + generationBytes.byteLength);
  return generatedPayload;
}

function decodeGitHubActionsRelayGeneration(
  payload: Uint8Array,
): { generation: string; payload: Uint8Array } | null {
  const generationBytes = payload[0] ?? 0;
  if (
    generationBytes === 0 ||
    generationBytes > relayGenerationMaximumBytes ||
    1 + generationBytes > payload.byteLength
  ) {
    return null;
  }
  const generation = decoder.decode(payload.subarray(1, 1 + generationBytes));
  if (!isGitHubActionsRelayGeneration(generation)) return null;
  return {
    generation,
    payload: payload.subarray(1 + generationBytes),
  };
}
