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
};

export type GitHubActionsRelayInputAcknowledgement = {
  accepted: boolean;
  error?: string;
};

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
const relayInputAcknowledgementType = "github_actions_input_ack";
const relayInputRejectedError = "GitHub Actions runner did not accept terminal input";

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
  if (sender === "viewer" && isGitHubActionsViewerControlMessage(message)) return 0;
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
  const viewerInput = sender === "viewer" && !isGitHubActionsViewerControlMessage(message);
  const forwarded = forwardGitHubActionsRelayMessage(sender, message, runners, viewers);
  if (viewerInput) {
    sendGitHubActionsRelayInputAcknowledgement(senderSocket, forwarded === 1);
  }
  return forwarded;
}

export function sendGitHubActionsRelayInputAcknowledgement(
  viewer: GitHubActionsRelaySocket,
  accepted: boolean,
): boolean {
  if (viewer.readyState !== webSocketOpen) return false;
  try {
    viewer.send(
      JSON.stringify({
        type: relayInputAcknowledgementType,
        accepted,
        ...(accepted ? {} : { error: relayInputRejectedError }),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function parseGitHubActionsRelayInputAcknowledgement(
  message: string | ArrayBuffer,
): GitHubActionsRelayInputAcknowledgement | null {
  if (typeof message !== "string") return null;
  try {
    const parsed = JSON.parse(message) as Record<string, unknown>;
    if (parsed.type !== relayInputAcknowledgementType || typeof parsed.accepted !== "boolean") {
      return null;
    }
    if (parsed.accepted) return { accepted: true };
    return {
      accepted: false,
      error:
        typeof parsed.error === "string" && parsed.error.trim()
          ? parsed.error.trim()
          : relayInputRejectedError,
    };
  } catch {
    return null;
  }
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
): number {
  const payload = JSON.stringify({ type });
  let notified = 0;
  for (const socket of viewers) {
    if (socket.readyState !== webSocketOpen) continue;
    socket.send(payload);
    notified += 1;
  }
  return notified;
}
