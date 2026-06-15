import assert from "node:assert/strict";
import test from "node:test";

import type { HttpError } from "../src/worker/http.ts";
import {
  RuntimeAdapterStopService,
  type RuntimeAdapterStopStore,
  type RuntimeAdapterWorkspaceStopResult,
} from "../src/worker/session-runtime-adapter-stop.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function fixture(
  options: {
    session?: InteractiveSession;
    claimed?: boolean;
    reread?: InteractiveSession | null;
    archiveFailure?: boolean;
    stop?: RuntimeAdapterWorkspaceStopResult;
    stopError?: unknown;
    createPending?: boolean;
    confirmed?: "stopping" | "stopped" | "failed" | null;
  } = {},
) {
  const session =
    options.session ??
    interactiveSession(
      sessionRow({
        id: "IS-10",
        adapter: "runtime-v1",
        adapter_workspace_id: "workspace-10",
      }),
      [],
    );
  const claims: Array<{ actor: string; now: number }> = [];
  const archives: string[] = [];
  const evidence: Array<{
    message: string;
    reconcileError: string | null;
    actor: string;
  }> = [];
  const releases: Array<{ now: number; message: string }> = [];
  let clock = 200;
  const store: RuntimeAdapterStopStore = {
    claimStop: async (_session, actor, now) => {
      claims.push({ actor, now });
      return options.claimed ?? true;
    },
    archive: async (sessionId) => {
      archives.push(sessionId);
      if (options.archiveFailure) throw new Error("archive unavailable");
    },
    readSession: async () => (options.reread === undefined ? session : options.reread),
    stopWorkspace: async () => {
      if (options.stopError !== undefined) throw options.stopError;
      return options.stop ?? { status: "stopped", message: "workspace released" };
    },
    providerError: () => "redacted provider failure",
    persistEvidence: async (_id, _workspaceId, message, _now, reconcileError, actor) => {
      evidence.push({ message, reconcileError, actor });
    },
    readCreatePending: async () => options.createPending ?? false,
    confirmRelease: async (_id, _workspaceId, now, message) => {
      releases.push({ now, message });
      return options.confirmed ?? "stopped";
    },
    now: () => {
      clock += 1;
      return clock;
    },
  };
  return {
    archives,
    claims,
    evidence,
    releases,
    service: new RuntimeAdapterStopService(store, "runtime-v1"),
    session,
  };
}

function hasStatus(status: number): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as HttpError).status === status;
}

async function stop(context: ReturnType<typeof fixture>) {
  return context.service.stop({
    session: context.session,
    actor: "operator",
    now: 100,
  });
}

test("runtime adapter stop requires a persisted workspace identity", async () => {
  const session = interactiveSession(
    sessionRow({ adapter: "runtime-v1", adapter_workspace_id: null }),
    [],
  );
  await assert.rejects(() => stop(fixture({ session })), hasStatus(503));
});

test("lost stop claims accept only the same adapter workspace in stopping or terminal state", async () => {
  const stopping = interactiveSession(
    sessionRow({
      id: "IS-10",
      adapter: "runtime-v1",
      adapter_workspace_id: "workspace-10",
      status: "stopping",
    }),
    [],
  );
  const accepted = fixture({ claimed: false, reread: stopping });
  assert.equal((await stop(accepted)).session, stopping);
  assert.deepEqual(accepted.archives, []);

  const different = interactiveSession(
    sessionRow({
      id: "IS-10",
      adapter: "runtime-v1",
      adapter_workspace_id: "workspace-other",
      status: "stopping",
    }),
    [],
  );
  await assert.rejects(() => stop(fixture({ claimed: false, reread: different })), hasStatus(409));
});

test("pending provider stops persist create-resolution evidence", async () => {
  const context = fixture({
    archiveFailure: true,
    stop: { status: "stopping", message: "provider stopping" },
    createPending: true,
  });
  const result = await stop(context);

  assert.equal(result.session, context.session);
  assert.equal(result.auditAt, null);
  assert.deepEqual(context.claims, [{ actor: "operator", now: 100 }]);
  assert.deepEqual(context.archives, ["IS-10"]);
  assert.deepEqual(context.evidence, [
    {
      message: "provider stopping; runtime adapter stop waiting for create resolution",
      reconcileError: null,
      actor: "operator",
    },
  ]);
});

test("provider stop failures persist redacted retry evidence", async () => {
  const context = fixture({ stopError: new Error("secret provider detail") });
  await assert.rejects(() => stop(context), hasStatus(503));
  assert.deepEqual(context.evidence, [
    {
      message: "runtime adapter stop pending: redacted provider failure",
      reconcileError: "redacted provider failure",
      actor: "operator",
    },
  ]);
});

test("confirmed releases return the durable session and a post-release audit clock", async () => {
  const stopped = interactiveSession(
    sessionRow({
      id: "IS-10",
      adapter: "runtime-v1",
      adapter_workspace_id: "workspace-10",
      status: "stopped",
    }),
    [],
  );
  const context = fixture({ reread: stopped, confirmed: "stopped" });
  const result = await stop(context);

  assert.equal(result.session, stopped);
  assert.equal(result.auditAt, 202);
  assert.deepEqual(context.releases, [{ now: 201, message: "workspace released" }]);
});

test("unresolved releases and missing rereads do not claim completion", async () => {
  const unresolved = fixture({ confirmed: "stopping" });
  assert.equal((await stop(unresolved)).auditAt, null);

  const missing = fixture({
    stop: { status: "stopping", message: "provider stopping" },
    reread: null,
  });
  await assert.rejects(() => stop(missing), hasStatus(404));
});
