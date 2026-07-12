import {
  encodeGitHubActionsRelayOutput,
  encodeGitHubActionsRunnerCapabilities,
  parseGitHubActionsRunnerCapabilitiesAccepted,
  parseGitHubActionsRelayInput,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "./github-actions-runtime.ts";

export function negotiateGitHubActionsRunnerProtocol(socket: GitHubActionsRelaySocket): void {
  socket.send(encodeGitHubActionsRunnerCapabilities());
}

export function sendGitHubActionsRunnerOutput(
  socket: GitHubActionsRelaySocket,
  output: string | ArrayBuffer | ArrayBufferView,
  framed = true,
): void {
  if (framed) {
    socket.send(encodeGitHubActionsRelayOutput(output));
    return;
  }
  socket.send(
    typeof output === "string" || output instanceof ArrayBuffer
      ? output
      : Uint8Array.from(new Uint8Array(output.buffer, output.byteOffset, output.byteLength)).buffer,
  );
}

export function gitHubActionsRunnerProtocolAccepted(message: string | ArrayBuffer): boolean {
  return (
    parseGitHubActionsRunnerCapabilitiesAccepted(message)?.includes("cfr1-framed-io-v1") ?? false
  );
}

export async function acceptGitHubActionsRunnerInput(
  socket: GitHubActionsRelaySocket,
  message: string | ArrayBuffer,
  writeToPty: (payload: ArrayBuffer) => void | Promise<void>,
): Promise<boolean> {
  const input = parseGitHubActionsRelayInput(message);
  if (!input) {
    if (parseGitHubActionsRunnerCapabilitiesAccepted(message)) return false;
    try {
      const payload =
        typeof message === "string"
          ? Uint8Array.from(new TextEncoder().encode(message)).buffer
          : message;
      await writeToPty(payload);
    } catch {
      // Legacy delivery is acknowledged by the relay after the WebSocket send.
    }
    return true;
  }
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
