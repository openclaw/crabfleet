import assert from "node:assert/strict";
import { test } from "node:test";

import {
  acceptGitHubActionsRunnerInput,
  gitHubActionsRunnerProtocolAccepted,
  negotiateGitHubActionsRunnerProtocol,
  sendGitHubActionsRunnerOutput,
} from "../src/github-actions-runner.ts";
import {
  encodeGitHubActionsRelayInput,
  parseGitHubActionsRelayOutput,
  parseGitHubActionsRunnerCapabilities,
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

test("runner rejects failed framed writes and accepts legacy input during negotiation", async () => {
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
  let legacyInput = "";
  assert.equal(
    await acceptGitHubActionsRunnerInput(socket, "raw input", async (payload) => {
      legacyInput = new TextDecoder().decode(payload);
    }),
    true,
  );
  assert.equal(legacyInput, "raw input");
  assert.equal(socket.sent.length, 1);
});

test("runner helpers stay raw until negotiation is accepted, then envelope PTY output", async () => {
  const socket = relaySocket();

  negotiateGitHubActionsRunnerProtocol(socket);
  assert.deepEqual(parseGitHubActionsRunnerCapabilities(socket.sent[0]!), ["cfr1-framed-io-v1"]);

  sendGitHubActionsRunnerOutput(socket, "early", false);
  assert.equal(socket.sent[1], "early");

  const accepted = JSON.stringify({
    type: "crabfleet_runner_capabilities",
    accepted: ["cfr1-framed-io-v1"],
  });
  assert.equal(gitHubActionsRunnerProtocolAccepted(accepted), true);
  assert.equal(
    await acceptGitHubActionsRunnerInput(socket, accepted, async () => {
      assert.fail("capability acceptance must not reach the PTY");
    }),
    false,
  );

  const collision = encodeGitHubActionsRelayInput("looks-like-input", "terminal bytes");
  sendGitHubActionsRunnerOutput(socket, collision);
  assert.deepEqual(
    new Uint8Array(parseGitHubActionsRelayOutput(socket.sent[2]!)!),
    new Uint8Array(collision),
  );
});
