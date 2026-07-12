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
  expectedRevisions: number[];
  events: string[];
  operations: string[];
} {
  const updates: GitHubActionsRunnerConnectionUpdate[] = [];
  const expectedRevisions: number[] = [];
  const events: string[] = [];
  const operations: string[] = [];
  return {
    updates,
    expectedRevisions,
    events,
    operations,
    store: {
      now: () => 700,
      persist: async (_id, values, expectedRevision) => {
        operations.push("persist");
        updates.push(values);
        expectedRevisions.push(expectedRevision);
      },
      appendEvent: async (_id, message) => {
        operations.push("event");
        events.push(message);
      },
    },
  };
}

test("waiting runners become active with durable connection evidence", async () => {
  const { store, updates, expectedRevisions, events, operations } = connectionStore();
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
  assert.deepEqual(expectedRevisions, [session({ status: "provisioning" }).updatedAt]);
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

test("runner connections retain the exact revision authenticated before a token rotation", async () => {
  const { store, expectedRevisions } = connectionStore();

  await new GitHubActionsRunnerConnectionService(store).connect(session({ updated_at: 400 }));

  assert.deepEqual(expectedRevisions, [400]);
});

test("runner connections advance revisions when the authenticated clock is ahead", async () => {
  const { store, updates, expectedRevisions } = connectionStore();

  await new GitHubActionsRunnerConnectionService(store).connect(session({ updated_at: 800 }));

  assert.deepEqual(expectedRevisions, [800]);
  assert.equal(updates[0]?.updated_at, 801);
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
