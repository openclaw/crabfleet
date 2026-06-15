import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveSessionCreationService,
  type InteractiveSessionCreationReservation,
  type InteractiveSessionCreationStore,
} from "../src/worker/session-creation.ts";
import type { InteractiveSession } from "../src/worker/session-model.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

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
    isConstraintError: () => false,
    readRequestReplay: async () => null,
    ...overrides,
  };
}

function session(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(sessionRow(values), []);
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

test("session creation recovers an idempotent replay after a reservation race", async () => {
  const replay = session({ id: "IS-9" });
  const service = new InteractiveSessionCreationService(
    creationStore({
      isConstraintError: () => true,
      readRequestReplay: async (requestId, requestHash) => {
        assert.equal(requestId, "request-1");
        assert.equal(requestHash, "hash-1");
        return replay;
      },
    }),
  );

  assert.equal(
    await service.recoverReservationFailure(new Error("unique"), {
      reservationInserted: false,
      attempt: 0,
      maximumAttempts: 3,
      requestId: "request-1",
      requestHash: "hash-1",
    }),
    replay,
  );
});

test("session creation retries only unowned constraint failures before the final attempt", async () => {
  const constraint = new Error("unique");
  const service = new InteractiveSessionCreationService(
    creationStore({
      isConstraintError: (error) => error === constraint,
    }),
  );
  const context = {
    reservationInserted: false,
    attempt: 0,
    maximumAttempts: 3,
    requestId: null,
    requestHash: null,
  };

  assert.equal(await service.recoverReservationFailure(constraint, context), null);
  await assert.rejects(
    service.recoverReservationFailure(constraint, {
      ...context,
      reservationInserted: true,
    }),
    constraint,
  );
  await assert.rejects(
    service.recoverReservationFailure(constraint, {
      ...context,
      attempt: 2,
    }),
    constraint,
  );
  await assert.rejects(
    service.recoverReservationFailure(new Error("provider"), context),
    /provider/,
  );
});
