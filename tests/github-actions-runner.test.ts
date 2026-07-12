import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptGitHubActionsRunnerInput,
  sendGitHubActionsRunnerOutput,
} from "../src/github-actions-runner.ts";
import {
  encodeGitHubActionsRelayInput,
  parseGitHubActionsRelayOutput,
  parseGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "../src/github-actions-runtime.ts";

function relaySocket(): GitHubActionsRelaySocket & { sent: Array<string | ArrayBuffer> } {
  return {
    readyState: WebSocket.OPEN,
    sent: [],
    send(message) {
      this.sent.push(message);
    },
    close() {},
  };
}

test("runner acknowledges input only after the PTY write completes", async () => {
  const socket = relaySocket();
  let completeWrite!: () => void;
  const write = new Promise<void>((resolve) => {
    completeWrite = resolve;
  });
  const handled = acceptGitHubActionsRunnerInput(
    socket,
    encodeGitHubActionsRelayInput("input-one", "steer"),
    async (payload) => {
      assert.equal(new TextDecoder().decode(payload), "steer");
      await write;
    },
  );

  await Promise.resolve();
  assert.deepEqual(socket.sent, []);
  completeWrite();
  assert.equal(await handled, true);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-one",
    accepted: true,
  });
});

test("runner copies the relay generation into its acknowledgement", async () => {
  const socket = relaySocket();

  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("input-generated", "steer", "generation-one"),
      async () => {},
    ),
    true,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-generated",
    accepted: true,
    generation: "generation-one",
  });
});

test("runner rejects failed writes and ignores unframed terminal data", async () => {
  const socket = relaySocket();

  assert.equal(
    await acceptGitHubActionsRunnerInput(
      socket,
      encodeGitHubActionsRelayInput("input-two", "steer"),
      async () => {
        throw new Error("PTY closed");
      },
    ),
    true,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(socket.sent[0]!), {
    inputId: "input-two",
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });
  assert.equal(await acceptGitHubActionsRunnerInput(socket, "raw input", async () => {}), false);
  assert.equal(socket.sent.length, 1);
});

test("runner output helper envelopes PTY bytes for connection-negotiated runners", () => {
  const socket = relaySocket();

  const collision = encodeGitHubActionsRelayInput("looks-like-input", "terminal bytes");
  sendGitHubActionsRunnerOutput(socket, collision);
  assert.deepEqual(
    new Uint8Array(parseGitHubActionsRelayOutput(socket.sent[0]!)!),
    new Uint8Array(collision),
  );
});
