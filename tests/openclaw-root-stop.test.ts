import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveSessionRow } from "../src/worker/database.ts";
import {
  OpenClawRootStopService,
  type OpenClawRootStopClock,
  type OpenClawRootStopStore,
} from "../src/worker/openclaw-root-stop.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function rootSession() {
  return interactiveSession(
    sessionRow({
      id: "IS-1",
      root_session_id: "IS-1",
      created_by: "service:openclaw",
      status: "stopped",
    }),
    [],
  );
}

function clock(): OpenClawRootStopClock & { current: number } {
  return {
    current: 0,
    now() {
      return this.current;
    },
    async sleep(milliseconds) {
      this.current += milliseconds;
    },
  };
}

function rootStopStore(overrides: Partial<OpenClawRootStopStore> = {}): OpenClawRootStopStore {
  return {
    readRootSession: async () => rootSession(),
    recordStopRequested: async () => undefined,
    closeAdmission: async () => undefined,
    readRootRows: async () => [],
    rollbackReservation: async () => undefined,
    stopSession: async () => undefined,
    reconcileSession: async () => undefined,
    readRootCompletion: async () => ({ total: 0, remaining: 0 }),
    recordStopped: async () => undefined,
    ...overrides,
  };
}

test("OpenClaw root stop records intent before closing admission and requires stable completion", async () => {
  const calls: string[] = [];
  let completionReads = 0;
  const terminalRoot = sessionRow({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
    status: "stopped",
  });
  const service = new OpenClawRootStopService(
    rootStopStore({
      recordStopRequested: async () => {
        calls.push("requested");
      },
      closeAdmission: async () => {
        calls.push("closed");
      },
      readRootRows: async () => [terminalRoot],
      readRootCompletion: async () => {
        completionReads += 1;
        return { total: 1, remaining: 0 };
      },
      recordStopped: async () => {
        calls.push("stopped");
      },
    }),
    "runtime-adapter",
    { clock: clock() },
  );

  const result = await service.stop("IS-1");
  assert.equal(completionReads, 2);
  assert.deepEqual(calls, ["requested", "closed", "stopped"]);
  assert.deepEqual(
    result.sessions.map((session) => session.id),
    ["IS-1"],
  );
});

test("OpenClaw root stop rolls back reservations before stopping active descendants", async () => {
  const calls: string[] = [];
  let pending = true;
  let active = true;
  const root = sessionRow({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
    status: "stopped",
  });
  const pendingChild = sessionRow({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
    preparation_pending: 1,
  });
  const activeChild = sessionRow({
    id: "IS-3",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
    status: "ready",
  });
  const rows = (): InteractiveSessionRow[] => [
    ...(pending ? [pendingChild] : []),
    { ...activeChild, status: active ? "ready" : "stopped" },
    root,
  ];
  const service = new OpenClawRootStopService(
    rootStopStore({
      readRootRows: async () => rows(),
      rollbackReservation: async (id) => {
        calls.push(`rollback:${id}`);
        pending = false;
      },
      stopSession: async (session) => {
        calls.push(`stop:${session.id}`);
        active = false;
      },
      readRootCompletion: async () => ({
        total: rows().length,
        remaining: pending || active ? 1 : 0,
      }),
    }),
    "runtime-adapter",
    { clock: clock() },
  );

  await service.stop("IS-1");
  assert.deepEqual(calls.slice(0, 2), ["rollback:IS-2", "stop:IS-3"]);
});

test("OpenClaw root stop reconciles non-adapter stopping sessions", async () => {
  let reconciled = 0;
  let stopping = true;
  const root = sessionRow({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
    status: "stopped",
  });
  const child = sessionRow({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
    status: "stopping",
    adapter: null,
  });
  const rows = () => [{ ...child, status: stopping ? "stopping" : "stopped" } as const, root];
  const service = new OpenClawRootStopService(
    rootStopStore({
      readRootRows: async () => rows(),
      reconcileSession: async () => {
        reconciled += 1;
        stopping = false;
      },
      stopSession: async () => {
        throw new Error("stopping legacy sessions must reconcile");
      },
      readRootCompletion: async () => ({
        total: 2,
        remaining: stopping ? 1 : 0,
      }),
    }),
    "runtime-adapter",
    { clock: clock() },
  );

  await service.stop("IS-1");
  assert.equal(reconciled, 1);
});

test("OpenClaw root stop rejects non-room roots before recording mutations", async () => {
  let mutated = false;
  const service = new OpenClawRootStopService(
    rootStopStore({
      readRootSession: async () =>
        interactiveSession(sessionRow({ id: "IS-1", created_by: "github:42" }), []),
      recordStopRequested: async () => {
        mutated = true;
      },
    }),
    "runtime-adapter",
    { clock: clock() },
  );

  await assert.rejects(service.stop("IS-1"), (error: unknown) => {
    assert.equal(
      typeof error === "object" && error !== null && "status" in error ? error.status : null,
      404,
    );
    return true;
  });
  assert.equal(mutated, false);
});
