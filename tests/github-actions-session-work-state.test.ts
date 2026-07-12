import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveSessionRow } from "../src/worker/database.ts";
import {
  GitHubActionsWorkStateService,
  type GitHubActionsWorkStateStore,
  type GitHubActionsWorkStateUpdate,
} from "../src/worker/github-actions-session-work-state.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type WorkStateStoreState = {
  row: InteractiveSessionRow | null;
  update: GitHubActionsWorkStateUpdate | null;
  expectedRevision: number | undefined;
  expectedTerminalStatus: InteractiveSessionRow["status"] | undefined;
  events: string[];
  operations: string[];
  disconnectError: unknown;
};

function workSession(values: Partial<InteractiveSessionRow> = {}): InteractiveSession {
  return interactiveSession(
    sessionRow({
      id: "IS-work",
      runtime: "github_actions",
      work_key: "issue:123",
      work_kind: "issue",
      work_state: "registered",
      work_phase: "waiting_for_runner",
      ...values,
    }),
    [],
  );
}

function workStateStore(values: Partial<InteractiveSessionRow> = {}): {
  store: GitHubActionsWorkStateStore;
  state: WorkStateStoreState;
} {
  const state: WorkStateStoreState = {
    row: sessionRow({
      id: "IS-work",
      runtime: "github_actions",
      work_key: "issue:123",
      work_kind: "issue",
      work_state: "registered",
      work_phase: "waiting_for_runner",
      ...values,
    }),
    update: null,
    expectedRevision: undefined,
    expectedTerminalStatus: undefined,
    events: [],
    operations: [],
    disconnectError: null,
  };
  const store: GitHubActionsWorkStateStore = {
    now: () => 500,
    readRow: async () => state.row,
    persist: async (_id, update, expectedRevision, expectedTerminalStatus) => {
      state.operations.push("persist");
      state.update = update;
      state.expectedRevision = expectedRevision;
      state.expectedTerminalStatus = expectedTerminalStatus;
      if (state.row) state.row = { ...state.row, ...update };
    },
    appendEvent: async (_id, message) => {
      state.operations.push("event");
      state.events.push(message);
    },
    disconnectRunner: async () => {
      state.operations.push("disconnect");
      if (state.disconnectError) throw state.disconnectError;
    },
    readSession: async () => {
      state.operations.push("read");
      return state.row ? interactiveSession(state.row, []) : null;
    },
  };
  return { store, state };
}

test("active work-state updates project fields and clear stale completion", async () => {
  const { store, state } = workStateStore({
    status: "provisioning",
    completion_reason: "stale terminal reason",
  });
  const result = await new GitHubActionsWorkStateService(store).update(workSession(), {
    state: "running",
    phase: "codex_turn",
    summary: " working ",
    codexThreadId: " thread-1 ",
    codexTurnId: "",
  });

  assert.equal(result.status, "ready");
  assert.deepEqual(state.update, {
    status: "ready",
    summary: "working",
    work_state: "running",
    work_phase: "codex_turn",
    codex_thread_id: "thread-1",
    codex_turn_id: null,
    last_heartbeat_at: 500,
    completion_reason: null,
    last_event: "running: codex_turn",
    last_seen_at: 500,
    updated_at: 500,
    stopped_at: null,
  });
  assert.deepEqual(state.events, ["running: codex_turn"]);
  assert.equal(state.expectedRevision, workSession().updatedAt);
  assert.deepEqual(state.operations, ["persist", "event", "read"]);
});

test("unchanged work-state heartbeats persist without duplicate events", async () => {
  const { store, state } = workStateStore({
    status: "attached",
    work_state: "running",
    work_phase: "codex_turn",
    summary: "working",
  });
  await new GitHubActionsWorkStateService(store).update(workSession(), {
    state: "running",
    phase: "codex_turn",
    summary: "working",
  });

  assert.equal(state.update?.status, "attached");
  assert.deepEqual(state.events, []);
  assert.deepEqual(state.operations, ["persist", "read"]);
});

test("terminal work-state updates stop the session and disconnect the runner", async () => {
  const { store, state } = workStateStore({
    work_state: "running",
    work_phase: "tests",
    completion_reason: "existing reason",
  });
  const result = await new GitHubActionsWorkStateService(store).update(workSession(), {
    state: "failed",
  });

  assert.equal(result.status, "failed");
  assert.equal(state.update?.completion_reason, "existing reason");
  assert.equal(state.update?.stopped_at, 500);
  assert.equal(state.expectedTerminalStatus, "ready");
  assert.equal(state.expectedRevision, workSession().updatedAt);
  assert.deepEqual(state.events, ["failed: tests"]);
  assert.deepEqual(state.operations, ["persist", "event", "disconnect", "read"]);
});

test("terminal work-state updates carry the status observed before persistence", async () => {
  const { store, state } = workStateStore({
    status: "attached",
    work_state: "running",
  });

  await new GitHubActionsWorkStateService(store).update(workSession(), {
    state: "completed",
  });

  assert.equal(state.expectedTerminalStatus, "attached");
});

test("work-state updates retain the exact revision authenticated before a token rotation", async () => {
  const authenticated = workSession({ updated_at: 400 });
  const { store, state } = workStateStore({ updated_at: 401, work_state: "registered" });
  store.persist = async (_id, _update, expectedRevision) => {
    state.expectedRevision = expectedRevision;
    if (state.row?.updated_at !== expectedRevision) {
      throw new Error("GitHub Actions session changed; retry");
    }
  };

  await assert.rejects(
    new GitHubActionsWorkStateService(store).update(authenticated, {
      state: "running",
    }),
    { message: "GitHub Actions session changed; retry" },
  );

  assert.equal(state.expectedRevision, 400);
});

test("work-state updates advance revisions when the authenticated clock is ahead", async () => {
  const authenticated = workSession({ updated_at: 800 });
  const { store, state } = workStateStore({ updated_at: 800 });

  await new GitHubActionsWorkStateService(store).update(authenticated, {
    state: "running",
  });

  assert.equal(state.expectedRevision, 800);
  assert.equal(state.update?.updated_at, 801);
});

test("terminal runner disconnect races remain best effort", async () => {
  const { store, state } = workStateStore();
  state.disconnectError = new Error("runner already disconnected");
  await assert.doesNotReject(() =>
    new GitHubActionsWorkStateService(store).update(workSession(), {
      state: "completed",
      completionReason: "done",
    }),
  );
  assert.equal(state.update?.completion_reason, "done");
  assert.deepEqual(state.operations, ["persist", "event", "disconnect", "read"]);
});

test("work-state updates reject invalid sessions, states, and missing rows", async () => {
  const { store, state } = workStateStore();
  const service = new GitHubActionsWorkStateService(store);
  await assert.rejects(
    () => service.update(workSession({ runtime: "container" }), { state: "running" }),
    { message: "session is not a GitHub Actions work session" },
  );
  await assert.rejects(() => service.update(workSession(), { state: "unknown" }), {
    message: "invalid work state",
  });
  state.row = null;
  await assert.rejects(() => service.update(workSession(), { state: "running" }), {
    message: "interactive session not found",
  });
});
