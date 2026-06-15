import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveSession } from "../src/worker/session-model.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import {
  OpenClawSupervisionService,
  type OpenClawSupervisionStore,
} from "../src/worker/openclaw-supervision.ts";
import { sessionRow } from "./helpers/session-row.ts";

function session(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(sessionRow(values), []);
}

function supervisionStore(
  overrides: Partial<OpenClawSupervisionStore> = {},
): OpenClawSupervisionStore {
  return {
    readSession: async () => null,
    refreshSession: async () => null,
    readLineageSession: async () => null,
    rootAdmissionOpen: async () => true,
    roomReservationPosition: async () => 1,
    removeReservation: async () => true,
    activateReservation: async () => true,
    ...overrides,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("OpenClaw root-scoped reads authorize the complete chain before refreshing the target", async () => {
  const root = session({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
  });
  const child = session({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
  });
  const calls: string[] = [];
  const sessions = new Map([
    [root.id, root],
    [child.id, child],
  ]);
  const service = new OpenClawSupervisionService(
    supervisionStore({
      readSession: async (id) => {
        calls.push(`read:${id}`);
        return sessions.get(id) ?? null;
      },
      refreshSession: async (id) => {
        calls.push(`refresh:${id}`);
        return sessions.get(id) ?? null;
      },
    }),
  );

  assert.equal((await service.requireRootScopedSession("IS-2", "IS-1")).id, "IS-2");
  assert.deepEqual(calls, ["read:IS-2", "read:IS-1", "refresh:IS-2"]);

  calls.length = 0;
  sessions.set("IS-2", { ...child, createdBy: "github:42" });
  await assert.rejects(service.requireRootScopedSession("IS-2", "IS-1"), (error) => {
    assert.equal(status(error), 404);
    return true;
  });
  assert.deepEqual(calls, ["read:IS-2", "read:IS-1"]);
});

test("OpenClaw supervised lineage accepts exact descendants and fences closed roots", async () => {
  const root = session({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
  });
  const parent = session({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
  });
  const sessions = new Map([
    [root.id, root],
    [parent.id, parent],
  ]);
  let admissionOpen = true;
  const service = new OpenClawSupervisionService(
    supervisionStore({
      readSession: async (id) => sessions.get(id) ?? null,
      rootAdmissionOpen: async () => admissionOpen,
    }),
  );
  const lineage = { parentSessionId: "IS-2", rootSessionId: "IS-1" };

  assert.equal(await service.supervisedRootForCreate("session:IS-2", lineage), "IS-1");
  admissionOpen = false;
  await assert.rejects(service.supervisedRootForCreate("session:IS-2", lineage), (error) => {
    assert.equal(status(error), 409);
    return true;
  });
  await assert.rejects(
    service.supervisedRootForCreate("service:openclaw", {
      parentSessionId: "missing",
      rootSessionId: "IS-1",
    }),
    (error) => {
      assert.equal(status(error), 400);
      return true;
    },
  );
});

test("OpenClaw reservation supervision maps lineage, capacity, and admission outcomes", async () => {
  const root = session({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
  });
  const inserted = session({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
  });
  let position = 2;
  let admissionOpen = true;
  const rollbacks: string[] = [];
  const lineage = new Map([
    ["IS-1:0", root],
    ["IS-2:1", inserted],
  ]);
  const service = new OpenClawSupervisionService(
    supervisionStore({
      readLineageSession: async (id, pending) => lineage.get(`${id}:${pending}`) ?? null,
      roomReservationPosition: async () => position,
      rootAdmissionOpen: async () => admissionOpen,
      removeReservation: async (id) => {
        rollbacks.push(id);
        return true;
      },
    }),
  );

  await service.enforceRoomSessionLimitAfterInsert("IS-1", "IS-2", 100);
  assert.deepEqual(rollbacks, []);

  position = 65;
  await assert.rejects(service.enforceRoomSessionLimitAfterInsert("IS-1", "IS-2", 100), (error) => {
    assert.equal(status(error), 429);
    return true;
  });
  assert.deepEqual(rollbacks, ["IS-2"]);

  position = 0;
  admissionOpen = false;
  await assert.rejects(service.enforceRoomSessionLimitAfterInsert("IS-1", "IS-2", 100), (error) => {
    assert.equal(status(error), 409);
    return true;
  });
  assert.deepEqual(rollbacks, ["IS-2", "IS-2"]);

  lineage.delete("IS-2:1");
  await assert.rejects(service.enforceRoomSessionLimitAfterInsert("IS-1", "IS-2", 100), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
  assert.deepEqual(rollbacks, ["IS-2", "IS-2", "IS-2"]);
});

test("OpenClaw activation failures roll back before returning service errors", async () => {
  const calls: string[] = [];
  let removeSucceeded = true;
  const service = new OpenClawSupervisionService(
    supervisionStore({
      activateReservation: async () => {
        calls.push("activate");
        return false;
      },
      removeReservation: async () => {
        calls.push("rollback");
        return removeSucceeded;
      },
    }),
  );

  await assert.rejects(service.requireReservationActivation("IS-2", 100, "workspace"), {
    message: "interactive session reservation activation failed",
  });
  assert.deepEqual(calls, ["activate", "rollback"]);

  calls.length = 0;
  removeSucceeded = false;
  await assert.rejects(service.requireReservationActivation("IS-2", 100, "workspace"), {
    message: "interactive session reservation rollback failed",
  });
  assert.deepEqual(calls, ["activate", "rollback"]);
});
