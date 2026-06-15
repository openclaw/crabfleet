import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveSessionCreationService,
  type InteractiveSessionCreationReservation,
  type InteractiveSessionCreationStore,
} from "../src/worker/session-creation.ts";

const reservation: InteractiveSessionCreationReservation = {
  id: "IS-2",
  insertedAt: 100,
  supervisedRootSessionId: "IS-1",
  requiresActivation: true,
  adapterWorkspaceId: "workspace-2",
};

function creationStore(
  overrides: Partial<InteractiveSessionCreationStore> = {},
): InteractiveSessionCreationStore {
  return {
    enforceSupervision: async () => undefined,
    rollbackReservation: async () => undefined,
    activateReservation: async () => undefined,
    recordRequest: async () => undefined,
    ...overrides,
  };
}

test("session creation orders supervision, preparation, activation, evidence, and provisioning", async () => {
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      enforceSupervision: async (rootId, sessionId, insertedAt) => {
        calls.push(`supervise:${rootId}:${sessionId}:${insertedAt}`);
      },
      activateReservation: async (sessionId, insertedAt, workspaceId) => {
        calls.push(`activate:${sessionId}:${insertedAt}:${workspaceId}`);
      },
      recordRequest: async (sessionId, insertedAt) => {
        calls.push(`record:${sessionId}:${insertedAt}`);
      },
    }),
  );

  const result = await service.provision(
    reservation,
    async () => {
      calls.push("prepare");
    },
    async () => {
      calls.push("provision");
      return "ready";
    },
  );

  assert.equal(result, "ready");
  assert.deepEqual(calls, [
    "supervise:IS-1:IS-2:100",
    "prepare",
    "activate:IS-2:100:workspace-2",
    "record:IS-2:100",
    "provision",
  ]);
});

test("session creation rolls back failed preparation before returning the error", async () => {
  const calls: string[] = [];
  const failure = new Error("branch preparation failed");
  const service = new InteractiveSessionCreationService(
    creationStore({
      enforceSupervision: async () => {
        calls.push("supervise");
      },
      rollbackReservation: async (sessionId, insertedAt) => {
        calls.push(`rollback:${sessionId}:${insertedAt}`);
      },
      activateReservation: async () => {
        calls.push("activate");
      },
      recordRequest: async () => {
        calls.push("record");
      },
    }),
  );

  await assert.rejects(
    service.provision(
      reservation,
      async () => {
        calls.push("prepare");
        throw failure;
      },
      async () => {
        calls.push("provision");
      },
    ),
    failure,
  );
  assert.deepEqual(calls, ["supervise", "prepare", "rollback:IS-2:100"]);
});

test("session creation skips optional supervision, preparation, and activation", async () => {
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      enforceSupervision: async () => {
        calls.push("supervise");
      },
      activateReservation: async () => {
        calls.push("activate");
      },
      recordRequest: async () => {
        calls.push("record");
      },
    }),
  );

  await service.provision(
    {
      ...reservation,
      supervisedRootSessionId: null,
      requiresActivation: false,
      adapterWorkspaceId: null,
    },
    undefined,
    async () => {
      calls.push("provision");
    },
  );
  assert.deepEqual(calls, ["record", "provision"]);
});
