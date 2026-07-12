import {
  encodeGitHubActionsRelayOutput,
  parseGitHubActionsRelayInput,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "./github-actions-runtime.ts";

const runnerInputQueues = new WeakMap<GitHubActionsRelaySocket, Promise<void>>();

export function sendGitHubActionsRunnerOutput(
  socket: GitHubActionsRelaySocket,
  output: string | ArrayBuffer | ArrayBufferView,
): void {
  socket.send(encodeGitHubActionsRelayOutput(output));
}

export async function acceptGitHubActionsRunnerInput(
  socket: GitHubActionsRelaySocket,
  message: string | ArrayBuffer,
  writeToPty: (payload: ArrayBuffer) => void | Promise<void>,
): Promise<boolean> {
  const input = parseGitHubActionsRelayInput(message);
  if (!input) return false;

  const queued = (runnerInputQueues.get(socket) ?? Promise.resolve())
    .catch(() => undefined)
    .then(async () => {
      try {
        await writeToPty(input.payload);
        sendGitHubActionsRelayInputAcknowledgement(socket, {
          inputId: input.inputId,
          accepted: true,
          ...(input.generation ? { generation: input.generation } : {}),
        });
      } catch {
        sendGitHubActionsRelayInputAcknowledgement(socket, {
          inputId: input.inputId,
          accepted: false,
          ...(input.generation ? { generation: input.generation } : {}),
        });
      }
    });
  runnerInputQueues.set(socket, queued);
  try {
    await queued;
  } finally {
    if (runnerInputQueues.get(socket) === queued) {
      runnerInputQueues.delete(socket);
    }
  }
  return true;
}
