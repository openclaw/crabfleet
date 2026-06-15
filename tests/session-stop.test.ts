import assert from "node:assert/strict";
import test from "node:test";

import type { HttpError } from "../src/worker/http.ts";
import {
  InteractiveSessionStopService,
  interactiveSessionTerminalStatus,
  type InteractiveSessionStopStore,
  type InteractiveSessionTerminalStatus,
} from "../src/worker/session-stop.ts";
import type { RuntimeAdapterStopServiceResult } from "../src/worker/session-runtime-adapter-stop.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type StopCalls = {
  staged: Array<{ status: InteractiveSessionTerminalStatus; message: string }>;
  reconciled: string[];
  events: string[];
  finalized: InteractiveSessionTerminalStatus[];
  githubActions: number;
  runtimeAdapter: number;
  legacy: number;
  audits: string[];
};

function fixture(
  options: {
    session?: InteractiveSession;
    sandbox?: boolean;
    staged?: boolean;
    cleanupIntent?: boolean;
    reread?: InteractiveSession | null;
    githubActionsStopped?: boolean;
    runtimeAdapterResult?: RuntimeAdapterStopServiceResult;
    legacyStopped?: boolean;
    finalizeFailure?: boolean;
  } = {},
) {
  const session = options.session ?? interactiveSession(sessionRow({ id: "IS-9" }), []);
  const calls: StopCalls = {
    staged: [],
    reconciled: [],
    events: [],
    finalized: [],
    githubActions: 0,
    runtimeAdapter: 0,
    legacy: 0,
    audits: [],
  };
  const store: InteractiveSessionStopStore = {
    isSandbox: () => options.sandbox ?? false,
    stageTerminalCleanup: async (_id, status, message) => {
      calls.staged.push({ status, message });
      return options.staged ?? true;
    },
    reconcileCleanup: async (id) => {
      calls.reconciled.push(id);
    },
    readTerminalCleanupIntent: async () => options.cleanupIntent ?? false,
    recordEvent: async (_id, message) => {
      calls.events.push(message);
    },
    readSession: async () => (options.reread === undefined ? session : options.reread),
    finalizeTerminal: async (_id, status) => {
      calls.finalized.push(status);
      if (options.finalizeFailure) throw new Error("finalizer unavailable");
    },
    stopGitHubActions: async () => {
      calls.githubActions += 1;
      return options.githubActionsStopped ?? true;
    },
    stopRuntimeAdapter: async () => {
      calls.runtimeAdapter += 1;
      return options.runtimeAdapterResult ?? { session, auditAt: null };
    },
    stopLegacy: async () => {
      calls.legacy += 1;
      return options.legacyStopped ?? true;
    },
    audit: async (message) => {
      calls.audits.push(message);
    },
  };
  return {
    calls,
    service: new InteractiveSessionStopService(store, "runtime-v1"),
    session,
  };
}

function hasStatus(status: number): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as HttpError).status === status;
}

async function stop(
  context: ReturnType<typeof fixture>,
  canManage = true,
): Promise<InteractiveSession> {
  return context.service.stop({
    session: context.session,
    actor: "operator",
    canManage,
    now: 100,
  });
}

test("terminal status detection owns only stable terminal states", () => {
  for (const status of ["stopped", "expired", "failed"] as const) {
    assert.equal(
      interactiveSessionTerminalStatus(interactiveSession(sessionRow({ status }), [])),
      status,
    );
  }
  assert.equal(
    interactiveSessionTerminalStatus(interactiveSession(sessionRow({ status: "stopping" }), [])),
    null,
  );
});

test("stop requires session management authority", async () => {
  const context = fixture();
  await assert.rejects(() => stop(context, false), hasStatus(403));
  assert.equal(context.calls.legacy, 0);
});

test("terminal sandbox stops stage cleanup and return the reconciled session", async () => {
  const terminal = interactiveSession(
    sessionRow({ id: "IS-9", status: "failed", stopped_at: 80 }),
    [],
  );
  const current = interactiveSession(sessionRow({ id: "IS-9", status: "failed" }), []);
  const context = fixture({ session: terminal, sandbox: true, reread: current });

  assert.equal(await stop(context), current);
  assert.deepEqual(context.calls.staged, [
    { status: "failed", message: "sandbox credential cleanup pending" },
  ]);
  assert.deepEqual(context.calls.reconciled, ["IS-9"]);
  assert.deepEqual(context.calls.finalized, []);
});

test("terminal non-sandbox stops retry finalization without changing the response", async () => {
  const terminal = interactiveSession(sessionRow({ status: "expired", stopped_at: 80 }), []);
  const context = fixture({ session: terminal, finalizeFailure: true });

  assert.equal(await stop(context), terminal);
  assert.deepEqual(context.calls.finalized, ["expired"]);
});

test("GitHub Actions stop audits success and accepts a concurrent terminal result", async () => {
  const session = interactiveSession(
    sessionRow({ id: "IS-9", runtime: "github_actions", capabilities_json: "{}" }),
    [],
  );
  const success = fixture({ session });
  assert.equal(await stop(success), session);
  assert.deepEqual(success.calls.audits, ["GitHub Actions session stopped IS-9"]);

  const stopped = interactiveSession(sessionRow({ id: "IS-9", status: "stopped" }), []);
  const raced = fixture({ session, githubActionsStopped: false, reread: stopped });
  assert.equal(await stop(raced), stopped);
  assert.deepEqual(raced.calls.audits, []);
});

test("runtime adapter stops delegate mechanics and audit confirmed release", async () => {
  const session = interactiveSession(
    sessionRow({ id: "IS-9", adapter: "runtime-v1", adapter_workspace_id: "workspace-9" }),
    [],
  );
  const stopped = interactiveSession(sessionRow({ id: "IS-9", status: "stopped" }), []);
  const context = fixture({
    session,
    runtimeAdapterResult: { session: stopped, auditAt: 140 },
  });

  assert.equal(await stop(context), stopped);
  assert.equal(context.calls.runtimeAdapter, 1);
  assert.deepEqual(context.calls.audits, ["interactive session stopped IS-9"]);
});

test("sandbox stops record intent before cleanup reconciliation", async () => {
  const context = fixture({ sandbox: true });

  assert.equal(await stop(context), context.session);
  assert.deepEqual(context.calls.staged, [
    {
      status: "stopped",
      message: "interactive workspace stop waiting for credential cleanup",
    },
  ]);
  assert.deepEqual(context.calls.events, ["interactive workspace stop requested"]);
  assert.deepEqual(context.calls.reconciled, ["IS-9"]);
  assert.equal(context.calls.legacy, 0);
});

test("sandbox stop races accept durable intent or terminal state and reject live ownership loss", async () => {
  const intent = fixture({ sandbox: true, staged: false, cleanupIntent: true });
  assert.equal(await stop(intent), intent.session);

  const terminal = interactiveSession(sessionRow({ status: "stopped" }), []);
  const completed = fixture({ sandbox: true, staged: false, reread: terminal });
  assert.equal(await stop(completed), terminal);

  const lost = fixture({ sandbox: true, staged: false });
  await assert.rejects(() => stop(lost), hasStatus(409));
});

test("legacy stops audit owned completion and accept concurrent terminal completion", async () => {
  const success = fixture();
  assert.equal(await stop(success), success.session);
  assert.deepEqual(success.calls.audits, ["interactive session stopped IS-9"]);

  const terminal = interactiveSession(sessionRow({ status: "stopped" }), []);
  const raced = fixture({ legacyStopped: false, reread: terminal });
  assert.equal(await stop(raced), terminal);
  assert.deepEqual(raced.calls.audits, []);
});

test("stop races reject live rereads and missing sessions", async () => {
  const githubActions = interactiveSession(sessionRow({ runtime: "github_actions" }), []);
  await assert.rejects(
    () => stop(fixture({ session: githubActions, githubActionsStopped: false })),
    hasStatus(409),
  );
  await assert.rejects(() => stop(fixture({ legacyStopped: false, reread: null })), hasStatus(404));
});
