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
    socket.send(message);
    forwarded += 1;
  }
  return forwarded;
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
