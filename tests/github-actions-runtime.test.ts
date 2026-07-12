import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildGitHubActionsRunnerPtyUrl,
  forwardGitHubActionsRelayMessage,
  gitHubActionsSessionStatus,
  githubActionsCapabilities,
  githubActionsRelayRole,
  githubActionsRuntimeLabel,
  isGitHubActionsViewerControlMessage,
  isTerminalGitHubActionsWorkState,
  notifyGitHubActionsViewers,
  parseGitHubActionsRelayInputAcknowledgement,
  parseGitHubActionsWorkState,
  relayGitHubActionsWebSocketMessage,
  replaceGitHubActionsRunner,
  sendGitHubActionsRelayInputAcknowledgement,
  type GitHubActionsRelaySocket,
} from "../src/github-actions-runtime.ts";

function relaySocket(readyState = 1): GitHubActionsRelaySocket & {
  closed: Array<[number | undefined, string | undefined]>;
  sent: Array<string | ArrayBuffer>;
} {
  return {
    readyState,
    sent: [],
    closed: [],
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
      this.readyState = 3;
    },
  };
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

test("relay replaces the current runner and routes messages by role", () => {
  const oldRunner = relaySocket();
  const runner = relaySocket();
  const viewerOne = relaySocket();
  const viewerTwo = relaySocket();

  assert.equal(replaceGitHubActionsRunner([oldRunner]), 1);
  assert.deepEqual(oldRunner.closed, [[1012, "runner replaced"]]);
  const stoppedRunner = relaySocket();
  assert.equal(replaceGitHubActionsRunner([stoppedRunner], 1000, "runner disconnected"), 1);
  assert.deepEqual(stoppedRunner.closed, [[1000, "runner disconnected"]]);

  assert.equal(
    forwardGitHubActionsRelayMessage("runner", "output", [runner], [viewerOne, viewerTwo]),
    2,
  );
  assert.deepEqual(viewerOne.sent, ["output"]);
  assert.deepEqual(viewerTwo.sent, ["output"]);

  assert.equal(
    forwardGitHubActionsRelayMessage("viewer", "input", [runner], [viewerOne, viewerTwo]),
    1,
  );
  assert.deepEqual(runner.sent, ["input"]);
});

test("relay sends viewer input to the first open runner", () => {
  const closedRunner = relaySocket(3);
  const openRunner = relaySocket();
  const laterRunner = relaySocket();

  assert.equal(
    forwardGitHubActionsRelayMessage(
      "viewer",
      "input",
      [closedRunner, openRunner, laterRunner],
      [],
    ),
    1,
  );
  assert.deepEqual(closedRunner.sent, []);
  assert.deepEqual(openRunner.sent, ["input"]);
  assert.deepEqual(laterRunner.sent, []);
});

test("relay reports runner delivery failures instead of claiming forwarded input", () => {
  const runner = relaySocket();
  runner.send = () => {
    throw new Error("runner disconnected");
  };

  assert.equal(forwardGitHubActionsRelayMessage("viewer", "input", [runner], []), 0);
});

test("relay input acknowledgements distinguish accepted and rejected delivery", () => {
  const viewer = relaySocket();

  assert.equal(sendGitHubActionsRelayInputAcknowledgement(viewer, true), true);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    accepted: true,
  });

  assert.equal(sendGitHubActionsRelayInputAcknowledgement(viewer, false), true);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[1]!), {
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });
  assert.equal(parseGitHubActionsRelayInputAcknowledgement('{"type":"runner_waiting"}'), null);
  assert.equal(sendGitHubActionsRelayInputAcknowledgement(relaySocket(3), false), false);
});

test("viewer relay acknowledges only input delivered to an open runner", () => {
  const runner = relaySocket();
  const viewer = relaySocket();

  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, "input", [runner], []), 1);
  assert.deepEqual(runner.sent, ["input"]);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    accepted: true,
  });

  const waitingViewer = relaySocket();
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", waitingViewer, "input", [], []), 0);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(waitingViewer.sent[0]!), {
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });

  const failedRunner = relaySocket();
  failedRunner.send = () => {
    throw new Error("runner disconnected");
  };
  const failedViewer = relaySocket();
  assert.equal(
    relayGitHubActionsWebSocketMessage("viewer", failedViewer, "input", [failedRunner], []),
    0,
  );
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(failedViewer.sent[0]!), {
    accepted: false,
    error: "GitHub Actions runner did not accept terminal input",
  });
});

test("relay consumes viewer resize controls without corrupting raw runner input", () => {
  const runner = relaySocket();
  const viewer = relaySocket();
  const resize = JSON.stringify({ type: "resize", cols: 120, rows: 40 });
  const typedJson = new TextEncoder().encode(resize).buffer;

  assert.equal(isGitHubActionsViewerControlMessage(resize), true);
  assert.equal(isGitHubActionsViewerControlMessage(typedJson), false);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, resize, [runner], []), 0);
  assert.deepEqual(runner.sent, []);
  assert.deepEqual(viewer.sent, []);
  assert.equal(relayGitHubActionsWebSocketMessage("viewer", viewer, typedJson, [runner], []), 1);
  assert.deepEqual(runner.sent, [typedJson]);
  assert.deepEqual(parseGitHubActionsRelayInputAcknowledgement(viewer.sent[0]!), {
    accepted: true,
  });
});

test("relay tags and runner lifecycle notifications stay explicit", () => {
  const viewer = relaySocket();
  assert.equal(githubActionsRelayRole(["github-actions-runner"]), "runner");
  assert.equal(githubActionsRelayRole(["github-actions-viewer"]), "viewer");
  assert.equal(githubActionsRelayRole([]), null);
  assert.equal(notifyGitHubActionsViewers([viewer], "runner_waiting"), 1);
  assert.deepEqual(viewer.sent, ['{"type":"runner_waiting"}']);
});
