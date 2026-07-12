import {
  parseGitHubActionsRelayInput,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "./github-actions-runtime.ts";

export async function acceptGitHubActionsRunnerInput(
  socket: GitHubActionsRelaySocket,
  message: string | ArrayBuffer,
  writeToPty: (payload: ArrayBuffer) => void | Promise<void>,
): Promise<boolean> {
  const input = parseGitHubActionsRelayInput(message);
  if (!input) return false;
  try {
    await writeToPty(input.payload);
    sendGitHubActionsRelayInputAcknowledgement(socket, {
      inputId: input.inputId,
      accepted: true,
    });
  } catch {
    sendGitHubActionsRelayInputAcknowledgement(socket, {
      inputId: input.inputId,
      accepted: false,
    });
  }
  return true;
}
