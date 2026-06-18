import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubActionsRunnerConnectionService,
  githubActionsRunnerConnectedEvent,
  type GitHubActionsRunnerConnectionStore,
  type GitHubActionsRunnerConnectionUpdate,
} from "../src/worker/github-actions-runner-connection.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function session(values: Parameters<typeof sessionRow>[0] = {}) {
  return interactiveSession(
    sessionRow({
      id: "IS-runner",
      runtime: "github_actions",
      work_key: "issue:123",
      work_state: "registered",
      work_phase: "waiting_for_runner",
      ...values,
    }),
    [],
  );
}

function connectionStore(): {
  store: GitHubActionsRunnerConnectionStore;
  updates: GitHubActionsRunnerConnectionUpdate[];
  events: string[];
  operations: string[];
} {
  const updates: GitHubActionsRunnerConnectionUpdate[] = [];
  const events: string[] = [];
  const operations: string[] = [];
  return {
    updates,
    events,
    operations,
    store: {
      now: () => 700,
      persist: async (_id, values) => {
        operations.push("persist");
        updates.push(values);
      },
      appendEvent: async (_id, message) => {
        operations.push("event");
        events.push(message);
      },
    },
  };
}

test("waiting runners become active with durable connection evidence", async () => {
  const { store, updates, events, operations } = connectionStore();
  await new GitHubActionsRunnerConnectionService(store).connect(
    session({ status: "provisioning" }),
  );

  assert.deepEqual(updates, [
    {
      status: "ready",
      work_state: "running",
      work_phase: "runner_connected",
      last_heartbeat_at: 700,
      last_seen_at: 700,
      updated_at: 700,
      last_event: githubActionsRunnerConnectedEvent,
    },
  ]);
  assert.deepEqual(events, [githubActionsRunnerConnectedEvent]);
  assert.deepEqual(operations, ["persist", "event"]);
});

test("reconnecting runners preserve active status, state, and phase", async () => {
  const { store, updates } = connectionStore();
  await new GitHubActionsRunnerConnectionService(store).connect(
    session({
      status: "attached",
      work_state: "running",
      work_phase: "codex_turn",
    }),
  );

  assert.equal(updates[0]?.status, "attached");
  assert.equal(updates[0]?.work_state, "running");
  assert.equal(updates[0]?.work_phase, "codex_turn");
});

test("runner connections reject non-work sessions", async () => {
  const { store } = connectionStore();
  const service = new GitHubActionsRunnerConnectionService(store);
  await assert.rejects(() => service.connect(session({ runtime: "container" })), {
    message: "session is not a GitHub Actions work session",
  });
  await assert.rejects(() => service.connect(session({ work_key: null })), {
    message: "session is not a GitHub Actions work session",
  });
});
