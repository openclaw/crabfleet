import assert from "node:assert/strict";
import { test } from "node:test";
import {
  attachGitHubActionsRunnerProtocol,
  attachGitHubActionsViewerProtocol,
  buildGitHubActionsRunnerPtyUrl,
  buildGitHubActionsViewerRelayUrl,
  createGitHubActionsRelayGeneration,
  encodeGitHubActionsRelayInput,
  encodeGitHubActionsRelayInputAcknowledgement,
  encodeGitHubActionsRelayOutput,
  gitHubActionsRelayGeneration,
  gitHubActionsRelayUsesGenerations,
  gitHubActionsSessionStatus,
  githubActionsCapabilities,
  githubActionsFramedRunnerCapability,
  githubActionsGenerationFencedCapability,
  githubActionsRelayRole,
  githubActionsRunnerProtocolQuery,
  githubActionsRuntimeLabel,
  githubActionsViewerProtocolHeader,
  githubActionsViewerProtocolQuery,
  gitHubActionsViewerResponseUsesFramedProtocol,
  gitHubActionsViewerResponseUsesGenerations,
  gitHubActionsRunnerUsesFramedProtocol,
  gitHubActionsViewerUsesFramedProtocol,
  isGitHubActionsViewerControlMessage,
  isTerminalGitHubActionsWorkState,
  notifyGitHubActionsViewers,
  parseGitHubActionsRelayEvent,
  parseGitHubActionsRelayInput,
  parseGitHubActionsRelayInputAcknowledgement,
  parseGitHubActionsRelayOutput,
  parseGitHubActionsRunnerProtocol,
  parseGitHubActionsViewerProtocol,
  parseGitHubActionsWorkState,
  relayGitHubActionsWebSocketMessage,
  replaceGitHubActionsRunner,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "../src/github-actions-runtime.ts";

function relaySocket(readyState = 1): GitHubActionsRelaySocket & {
  attachment: unknown;
  closed: Array<[number | undefined, string | undefined]>;
  sent: Array<string | ArrayBuffer>;
} {
  return {
    readyState,
    attachment: null,
    sent: [],
    closed: [],
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
      this.readyState = 3;
    },
    serializeAttachment(attachment) {
      this.attachment = attachment;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function framedViewer() {
  const viewer = relaySocket();
  attachGitHubActionsViewerProtocol(viewer, githubActionsFramedRunnerCapability);
  return viewer;
}

function generatedViewer() {
  const viewer = relaySocket();
  attachGitHubActionsViewerProtocol(viewer, githubActionsGenerationFencedCapability);
  return viewer;
}

test("github_actions exposes steerable terminal capabilities and label", () => {
  assert.equal(githubActionsRuntimeLabel("github_actions"), "GitHub Actions");
  assert.equal(githubActionsRuntimeLabel("container"), "");
  assert.deepEqual(githubActionsCapabilities, {
    terminal: true,
    takeover: true,
    vnc: false,
    desktop: false,
    logs: true,
    artifacts: false,
  });
});

test("runner URL works without custom WebSocket headers", () => {
  assert.equal(
    buildGitHubActionsRunnerPtyUrl("https://crabfleet.openclaw.ai", "IS-123", "token with spaces"),
    "wss://crabfleet.openclaw.ai/api/agent/interactive-sessions/IS-123/runner-pty?agentToken=token+with+spaces",
  );
  assert.equal(parseGitHubActionsRunnerProtocol(null), null);
  assert.equal(
    parseGitHubActionsRunnerProtocol(githubActionsGenerationFencedCapability),
    githubActionsGenerationFencedCapability,
  );
  assert.equal(
    parseGitHubActionsRunnerProtocol(githubActionsFramedRunnerCapability),
    githubActionsFramedRunnerCapability,
  );
  assert.equal(githubActionsRunnerProtocolQuery, "runnerProtocol");
  assert.equal(
    buildGitHubActionsViewerRelayUrl(),
    "https://crabfleet.internal/api/session-control/github-actions/viewer?viewerProtocol=cfr1-framed-io-v2",
  );
  assert.equal(parseGitHubActionsViewerProtocol(null), null);
  assert.equal(
    parseGitHubActionsViewerProtocol(githubActionsFramedRunnerCapability),
    githubActionsFramedRunnerCapability,
  );
  assert.equal(
    parseGitHubActionsViewerProtocol(githubActionsGenerationFencedCapability),
    githubActionsGenerationFencedCapability,
  );
  assert.equal(githubActionsViewerProtocolQuery, "viewerProtocol");
  assert.equal(githubActionsViewerProtocolHeader, "x-crabfleet-viewer-protocol");
  assert.equal(
    gitHubActionsViewerResponseUsesFramedProtocol(
      new Response(null, {
        headers: {
          [githubActionsViewerProtocolHeader]: githubActionsFramedRunnerCapability,
        },
      }),
    ),
    true,
  );
  assert.equal(gitHubActionsViewerResponseUsesFramedProtocol(new Response()), false);
  const generatedResponse = new Response(null, {
    headers: {
      [githubActionsViewerProtocolHeader]: githubActionsGenerationFencedCapability,
    },
  });
  assert.equal(gitHubActionsViewerResponseUsesFramedProtocol(generatedResponse), true);
  assert.equal(gitHubActionsViewerResponseUsesGenerations(generatedResponse), true);
});

test("work states preserve running phases and map terminal outcomes", () => {
  assert.equal(parseGitHubActionsWorkState("running"), "running");
  assert.equal(parseGitHubActionsWorkState("unknown"), null);
  assert.equal(isTerminalGitHubActionsWorkState("running"), false);
  assert.equal(isTerminalGitHubActionsWorkState("completed"), true);
  assert.equal(isTerminalGitHubActionsWorkState("blocked"), true);
  assert.equal(gitHubActionsSessionStatus("running"), "ready");
  assert.equal(gitHubActionsSessionStatus("completed"), "stopped");
  assert.equal(gitHubActionsSessionStatus("failed"), "failed");
});

test("relay replaces the current runner and frames legacy raw runner output", () => {
  const oldRunner = relaySocket();
  const runner = relaySocket();
  const viewerOne = framedViewer();
  const viewerTwo = framedViewer();

  assert.equal(replaceGitHubActionsRunner([oldRunner]), 1);
  assert.deepEqual(oldRunner.closed, [[1012, "runner replaced"]]);
  const stoppedRunner = relaySocket();
  assert.equal(replaceGitHubActionsRunner([stoppedRunner], 1000, "runner disconnected"), 1);
  assert.deepEqual(stoppedRunner.closed, [[1000, "runner disconnected"]]);

  assert.equal(
    relayGitHubActionsWebSocketMessage(
      "runner",
      runner,
      "output",
      [runner],
      [viewerOne, viewerTwo],
    ),
    2,
  );
  assert.equal(
    new TextDecoder().decode(parseGitHubActionsRelayOutput(viewerOne.sent[0]!)!),
    "output",
  );
  assert.equal(
    new TextDecoder().decode(parseGitHubActionsRelayOutput(viewerTwo.sent[0]!)!),
    "output",
  );

  const oldCapabilityMessage =
    '{"type":"crabfleet_runner_capabilities","capabilities":["cfr1-framed-io-v1"]}';
  assert.equal(
    relayGitHubActionsWebSocketMessage(
      "runner",
      runner,
      oldCapabilityMessage,
      [runner],
      [viewerOne],
    ),
    1,
  );
  assert.equal(
    new TextDecoder().decode(parseGitHubActionsRelayOutput(viewerOne.sent[1]!)!),
    oldCapabilityMessage,
  );
  assert.equal(gitHubActionsRunnerUsesFramedProtocol(runner), false);
});

test("legacy runners receive raw input and the relay acknowledges delivery", () => {
  const runner = relaySocket();
  const viewer = framedViewer();
  const input = encodeGitHubActionsRelayInput("input-legacy", "steer");

  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, input, [runner], []), 1);
  assert.equal(new TextDecoder().decode(runner.sent[0] as ArrayBuffer), "steer");
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    inputId: "input-legacy",
    accepted: true,
  });
});

test("connection-time opt-in frames the first input without a pending handshake", () => {
  const closedRunner = relaySocket(3);
  const openRunner = relaySocket();
  const laterRunner = relaySocket();
  const viewer = framedViewer();
  const input = encodeGitHubActionsRelayInput("input-one", "steer");

  attachGitHubActionsRunnerProtocol(openRunner, githubActionsFramedRunnerCapability);
  assert.equal(gitHubActionsRunnerUsesFramedProtocol(openRunner), true);
  assert.equal(
    relayGitHubActionsWebSocketMessage(
      "viewer",
      viewer,
      input,
      [closedRunner, openRunner, laterRunner],
      [],
    ),
    1,
  );
  assert.deepEqual(closedRunner.sent, []);
  assert.deepEqual(openRunner.sent, [input]);
  assert.deepEqual(laterRunner.sent, []);
  assert.deepEqual(viewer.sent, []);
  assert.deepEqual(parseGitHubActionsRelayInput(openRunner.sent[0]!), {
    inputId: "input-one",
    payload: new TextEncoder().encode("steer").buffer,
  });
});

test("relay rejects framed input only when no runner accepts the frame", () => {
  const runner = relaySocket();
  runner.send = () => {
    throw new Error("runner disconnected");
  };
  const viewer = framedViewer();
  const input = encodeGitHubActionsRelayInput("input-failed", "steer");

  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, input, [runner], []), 0);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    inputId: "input-failed",
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });

  const waitingViewer = framedViewer();
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", waitingViewer, input, [], []), 0);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(waitingViewer.sent[0]!), {
    inputId: "input-failed",
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });
});

test("runner acknowledgements retain correlation and fan out to viewers", () => {
  const runner = relaySocket();
  const viewerOne = framedViewer();
  const viewerTwo = framedViewer();
  const acknowledgement = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "input-two",
    accepted: true,
  });
  attachGitHubActionsRunnerProtocol(runner, githubActionsFramedRunnerCapability);

  assert.equal(
    relayGitHubActionsWebSocketMessage(
      "runner",
      runner,
      acknowledgement,
      [runner],
      [viewerOne, viewerTwo],
    ),
    2,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewerOne.sent[0]!), {
    inputId: "input-two",
    accepted: true,
  });
  assert.deepEqual(viewerTwo.sent, [acknowledgement]);
});

test("relay-owned generations fence stale input and bridge framed protocol versions", () => {
  const runner = relaySocket();
  const viewer = generatedViewer();
  const generation = createGitHubActionsRelayGeneration();
  attachGitHubActionsRunnerProtocol(runner, githubActionsFramedRunnerCapability, generation);

  assert.equal(gitHubActionsRelayGeneration(runner), generation);
  assert.equal(gitHubActionsRelayUsesGenerations(runner), false);
  assert.equal(gitHubActionsRelayUsesGenerations(viewer), true);

  const staleInput = encodeGitHubActionsRelayInput("input-stale", "old", "old-generation");
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, staleInput, [runner], []), 0);
  assert.deepEqual(runner.sent, []);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    inputId: "input-stale",
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
    generation: "old-generation",
  });

  const currentInput = encodeGitHubActionsRelayInput("input-current", "new", generation);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, currentInput, [runner], []), 1);
  assert.deepEqual(parseGitHubActionsRelayInput(runner.sent[0]!), {
    inputId: "input-current",
    payload: new TextEncoder().encode("new").buffer,
  });

  const acknowledgement = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "input-current",
    accepted: true,
  });
  assert.equal(
    relayGitHubActionsWebSocketMessage("runner", runner, acknowledgement, [runner], [viewer]),
    1,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[1]!), {
    inputId: "input-current",
    accepted: true,
    generation,
  });
});

test("replacement relay drops acknowledgements from the superseded runner", () => {
  const oldRunner = relaySocket();
  const replacement = relaySocket();
  const viewer = generatedViewer();
  attachGitHubActionsRunnerProtocol(
    oldRunner,
    githubActionsGenerationFencedCapability,
    "old-generation",
  );
  attachGitHubActionsRunnerProtocol(
    replacement,
    githubActionsGenerationFencedCapability,
    "new-generation",
  );
  const acknowledgement = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "input-old",
    accepted: true,
    generation: "old-generation",
  });

  assert.equal(
    relayGitHubActionsWebSocketMessage(
      "runner",
      oldRunner,
      acknowledgement,
      [replacement],
      [viewer],
    ),
    0,
  );
  assert.deepEqual(viewer.sent, []);
});

test("generation-fenced runners echo only their relay-owned generation", () => {
  const runner = relaySocket();
  const viewer = generatedViewer();
  attachGitHubActionsRunnerProtocol(
    runner,
    githubActionsGenerationFencedCapability,
    "current-generation",
  );
  const input = encodeGitHubActionsRelayInput("input-current", "steer", "current-generation");

  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, input, [runner], []), 1);
  assert.deepEqual(parseGitHubActionsRelayInput(runner.sent[0]!), {
    inputId: "input-current",
    generation: "current-generation",
    payload: new TextEncoder().encode("steer").buffer,
  });

  const staleAcknowledgement = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "input-current",
    accepted: true,
    generation: "stale-generation",
  });
  assert.equal(
    relayGitHubActionsWebSocketMessage("runner", runner, staleAcknowledgement, [runner], [viewer]),
    0,
  );
  assert.deepEqual(viewer.sent, []);
});

test("negotiated runners frame output so control-shaped terminal bytes stay output", () => {
  const runner = relaySocket();
  const viewer = framedViewer();
  const controlShapedOutput = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: "collision",
    accepted: true,
  });

  attachGitHubActionsRunnerProtocol(runner, githubActionsFramedRunnerCapability);
  const output = encodeGitHubActionsRelayOutput(controlShapedOutput);
  assert.equal(relayGitHubActionsWebSocketMessage("runner", runner, output, [runner], [viewer]), 1);
  assert.deepEqual(
    new Uint8Array(parseGitHubActionsRelayOutput(viewer.sent[0]!)!),
    new Uint8Array(controlShapedOutput),
  );
});

test("typed acknowledgements reject malformed ids and preserve collision-shaped terminal text", () => {
  const viewer = framedViewer();
  const runner = relaySocket();
  const collision = '{"type":"github_actions_input_ack","inputId":"input-three","accepted":true}';

  assert.equal(parseGitHubActionsRelayInputAcknowledgement(collision), null);
  assert.equal(
    relayGitHubActionsWebSocketMessage("runner", runner, collision, [runner], [viewer]),
    1,
  );
  assert.equal(
    new TextDecoder().decode(parseGitHubActionsRelayOutput(viewer.sent[0]!)!),
    collision,
  );
  assert.throws(() => encodeGitHubActionsRelayInput("bad id", "input"), {
    message: "invalid GitHub Actions relay input id",
  });
  assert.equal(
    sendGitHubActionsRelayInputAcknowledgement(relaySocket(3), {
      inputId: "input-three",
      accepted: false,
    }),
    false,
  );
});

test("relay consumes viewer resize controls and rejects unframed input", () => {
  const runner = relaySocket();
  const viewer = framedViewer();
  const resize = JSON.stringify({ type: "resize", cols: 120, rows: 40 });
  const typedJson = new TextEncoder().encode(resize).buffer;

  assert.equal(isGitHubActionsViewerControlMessage(resize), true);
  assert.equal(isGitHubActionsViewerControlMessage(typedJson), false);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, resize, [runner], []), 0);
  assert.deepEqual(runner.sent, []);
  assert.deepEqual(viewer.sent, []);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, typedJson, [runner], []), 0);
  assert.deepEqual(runner.sent, []);
});

test("relay tags and runner lifecycle notifications stay explicit", () => {
  const viewer = framedViewer();
  assert.equal(githubActionsRelayRole(["github-actions-runner"]), "runner");
  assert.equal(githubActionsRelayRole(["github-actions-viewer"]), "viewer");
  assert.equal(githubActionsRelayRole([]), null);
  assert.equal(notifyGitHubActionsViewers([viewer], "runner_waiting"), 1);
  assert.deepEqual(parseGitHubActionsRelayEvent(viewer.sent[0]!), {
    type: "runner_waiting",
  });
});

test("generation-fenced lifecycle events identify the relay runner", () => {
  const viewer = generatedViewer();
  assert.equal(notifyGitHubActionsViewers([viewer], "runner_connected", "generation-one"), 1);
  assert.deepEqual(parseGitHubActionsRelayEvent(viewer.sent[0]!), {
    type: "runner_connected",
    generation: "generation-one",
  });
  assert.equal(notifyGitHubActionsViewers([viewer], "runner_waiting"), 1);
  assert.deepEqual(parseGitHubActionsRelayEvent(viewer.sent[1]!), {
    type: "runner_waiting",
    generation: "none",
  });
});

test("unnegotiated viewers retain raw relay compatibility", () => {
  const runner = relaySocket();
  const viewer = relaySocket();

  assert.equal(gitHubActionsViewerUsesFramedProtocol(viewer), false);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, "steer", [runner], []), 1);
  assert.deepEqual(runner.sent, ["steer"]);
  assert.deepEqual(JSON.parse(viewer.sent[0] as string), {
    type: "github_actions_input_ack",
    accepted: true,
  });

  assert.equal(
    relayGitHubActionsWebSocketMessage("runner", runner, "output", [runner], [viewer]),
    1,
  );
  assert.equal(viewer.sent[1], "output");
  assert.equal(notifyGitHubActionsViewers([viewer], "runner_disconnected"), 1);
  assert.deepEqual(JSON.parse(viewer.sent[2] as string), {
    type: "runner_disconnected",
  });
});

test("raw viewers bridge through framed runners without receiving CFR1 controls", () => {
  const runner = relaySocket();
  const viewer = relaySocket();
  attachGitHubActionsRunnerProtocol(runner, githubActionsFramedRunnerCapability);

  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, "steer", [runner], []), 1);
  const input = parseGitHubActionsRelayInput(runner.sent[0]!);
  assert.ok(input);
  assert.equal(new TextDecoder().decode(input.payload), "steer");
  assert.deepEqual(JSON.parse(viewer.sent[0] as string), {
    type: "github_actions_input_ack",
    accepted: true,
  });

  const acknowledgement = encodeGitHubActionsRelayInputAcknowledgement({
    inputId: input.inputId,
    accepted: true,
  });
  assert.equal(
    relayGitHubActionsWebSocketMessage("runner", runner, acknowledgement, [runner], [viewer]),
    0,
  );
  assert.equal(viewer.sent.length, 1);

  const output = encodeGitHubActionsRelayOutput("output");
  assert.equal(relayGitHubActionsWebSocketMessage("runner", runner, output, [runner], [viewer]), 1);
  assert.equal(new TextDecoder().decode(viewer.sent[1] as ArrayBuffer), "output");
});
