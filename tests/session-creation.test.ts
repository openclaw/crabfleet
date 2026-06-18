import assert from "node:assert/strict";
import test from "node:test";

import {
  InteractiveSessionCreationService,
  type InteractiveSessionCreationConfiguration,
  type InteractiveSessionCreationReservation,
  type InteractiveSessionCreationStore,
} from "../src/worker/session-creation.ts";
import type { ResolvedInteractiveSessionCreateRequest } from "../src/worker/session-create-request.ts";
import type { InteractiveSessionReservationContext } from "../src/worker/session-reservation-context.ts";
import type { InteractiveSession } from "../src/worker/session-model.ts";
import { containerCapabilities, interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const reservation: InteractiveSessionCreationReservation = {
  id: "IS-2",
  insertedAt: 100,
  supervisedRootSessionId: "IS-1",
  requiresActivation: true,
  adapterWorkspaceId: "workspace-2",
};

const resolvedRequest: ResolvedInteractiveSessionCreateRequest = {
  repo: "openclaw/crabfleet",
  branch: "main",
  runtime: "crabbox",
  profile: "default",
  requestedCapabilities: containerCapabilities,
  command: "codex --yolo",
  prompt: "continue",
  purpose: "refactor",
  summary: "starting",
  owner: "user:operator",
  createdBy: "user:operator",
};

const reservationContext: InteractiveSessionReservationContext = {
  agentToken: "agent-token",
  initialAgentTokenHash: "agent-hash",
  initialSandboxLease: null,
  initialSandboxOwnership: null,
  adapterWorkspaceId: "workspace-2",
  adapterControlPlane: "https://controller.example",
  adapterSettings: {
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    capabilities: containerCapabilities,
  },
  adapterCreatePayloadJson: '{"id":"workspace-2"}',
};

const creationConfiguration: InteractiveSessionCreationConfiguration = {
  adapterName: "runtime-v1",
  sandboxLeasePrefix: "sandbox:",
  maximumAttempts: 3,
};

function creationStore(
  overrides: Partial<InteractiveSessionCreationStore> = {},
): InteractiveSessionCreationStore {
  return {
    now: () => 100,
    defaultIdentity: () => ({ owner: "user:operator", createdBy: "user:operator" }),
    resolveRequest: (_body, identity) => ({ ...resolvedRequest, ...identity }),
    requireRepo: async () => undefined,
    resolveLineage: async () => ({ parentSessionId: null, rootSessionId: null }),
    supervisedRootForCreate: async () => null,
    nextSessionId: async () => "IS-2",
    createReservationContext: async () => reservationContext,
    insertReservation: async () => undefined,
    provisionManaged: async () => ({
      status: "ready",
      leaseId: null,
      attachUrl: "wss://controller.example/terminal",
      vncUrl: null,
      message: "ready",
      adapter: "runtime-v1",
      adapterWorkspaceId: "workspace-2",
    }),
    auditCreated: async () => undefined,
    decorateSession: (value) => value,
    enforceSupervision: async () => undefined,
    rollbackReservation: async () => undefined,
    activateReservation: async () => undefined,
    recordRequest: async () => undefined,
    isConstraintError: () => false,
    readRequestReplay: async () => null,
    persistProvisionResult: async () => ({
      updated: true,
      terminalStatus: null,
      terminalAt: 101,
    }),
    markPendingAdapter: async () => undefined,
    recordProvisionEvent: async () => undefined,
    finalizeTerminal: async () => undefined,
    readSession: async () => null,
    stopSupersededAdapter: async () => undefined,
    cleanupSupersededSandbox: async () => undefined,
    ...overrides,
  };
}

function session(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(sessionRow(values), []);
}

test("session creation owns normalization through decorated durable result", async () => {
  const calls: string[] = [];
  const current = session({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-root",
    status: "ready",
    adapter: "runtime-v1",
    adapter_workspace_id: "workspace-2",
  });
  let reservationInput: unknown;
  let replayInput: unknown;
  let provisionInput: unknown;
  const service = new InteractiveSessionCreationService(
    creationStore({
      defaultIdentity: () => ({ owner: "default-owner", createdBy: "default-creator" }),
      resolveRequest: (body, identity) => {
        calls.push("resolve");
        assert.equal(body.repo, "openclaw/crabfleet");
        return { ...resolvedRequest, ...identity };
      },
      requireRepo: async (repo) => {
        calls.push(`repo:${repo}`);
      },
      resolveLineage: async (parentSessionId, rootSessionId) => {
        calls.push(`lineage:${parentSessionId}:${rootSessionId}`);
        return { parentSessionId: "IS-1", rootSessionId: "IS-root" };
      },
      supervisedRootForCreate: async (createdBy, lineage) => {
        calls.push(`supervised:${createdBy}:${lineage.rootSessionId}`);
        return "IS-root";
      },
      nextSessionId: async () => {
        calls.push("id");
        return "IS-2";
      },
      createReservationContext: async (_request, context) => {
        calls.push(`context:${context.id}:${context.parentSessionId}:${context.rootSessionId}`);
        return reservationContext;
      },
      insertReservation: async (input, replay) => {
        calls.push("insert");
        reservationInput = input;
        replayInput = replay;
      },
      enforceSupervision: async (rootId, sessionId, insertedAt) => {
        calls.push(`supervise:${rootId}:${sessionId}:${insertedAt}`);
      },
      activateReservation: async (sessionId, insertedAt, workspaceId) => {
        calls.push(`activate:${sessionId}:${insertedAt}:${workspaceId}`);
      },
      recordRequest: async (sessionId, insertedAt) => {
        calls.push(`request:${sessionId}:${insertedAt}`);
      },
      provisionManaged: async (request, agentToken, ownership) => {
        calls.push(`provision:${agentToken}:${ownership ? "owned" : "unowned"}`);
        provisionInput = request;
        return {
          status: "ready",
          leaseId: null,
          attachUrl: "wss://controller.example/terminal",
          vncUrl: null,
          message: "ready",
          adapter: "runtime-v1",
          adapterWorkspaceId: "workspace-2",
        };
      },
      persistProvisionResult: async () => {
        calls.push("persist");
        return { updated: true, terminalStatus: null, terminalAt: 101 };
      },
      recordProvisionEvent: async () => {
        calls.push("event");
      },
      auditCreated: async (sessionId, request, now) => {
        calls.push(`audit:${sessionId}:${request.owner}:${request.createdBy}:${now}`);
      },
      readSession: async () => {
        calls.push("read");
        return current;
      },
      decorateSession: (value) => {
        calls.push("decorate");
        return value;
      },
    }),
    creationConfiguration,
  );

  const created = await service.create(
    { repo: "openclaw/crabfleet", parentSessionId: "body-parent" },
    "github-token",
    {
      owner: "owner-override",
      createdBy: "service:openclaw",
      parentSessionId: "IS-1",
      rootSessionId: "caller-root",
      openClawRequestId: "request-1",
      openClawRequestHash: "hash-1",
      afterReserve: async () => {
        calls.push("prepare");
      },
    },
  );

  assert.equal(created, current);
  assert.deepEqual(calls, [
    "resolve",
    "repo:openclaw/crabfleet",
    "lineage:IS-1:caller-root",
    "supervised:service:openclaw:IS-root",
    "id",
    "context:IS-2:IS-1:IS-root",
    "insert",
    "supervise:IS-root:IS-2:100",
    "prepare",
    "activate:IS-2:100:workspace-2",
    "request:IS-2:100",
    "provision:agent-token:unowned",
    "persist",
    "event",
    "audit:IS-2:owner-override:service:openclaw:100",
    "read",
    "decorate",
  ]);
  assert.deepEqual(replayInput, {
    requestId: "request-1",
    requestHash: "hash-1",
    sessionId: "IS-2",
    createdAt: 100,
  });
  assert.deepEqual(reservationInput, {
    id: "IS-2",
    parentSessionId: "IS-1",
    rootSessionId: "IS-root",
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "crabbox",
    adapterName: "runtime-v1",
    profile: "default",
    adapterWorkspaceId: "workspace-2",
    adapterControlPlane: "https://controller.example",
    requestedCapabilities: containerCapabilities,
    adapterSettings: reservationContext.adapterSettings,
    adapterCreatePayloadJson: '{"id":"workspace-2"}',
    preparationReservation: true,
    openClawRequestId: "request-1",
    openClawRequestHash: "hash-1",
    command: "codex --yolo",
    prompt: "continue",
    purpose: "refactor",
    summary: "starting",
    owner: "owner-override",
    createdBy: "service:openclaw",
    initialLeaseId: null,
    initialAgentTokenHash: "agent-hash",
    now: 100,
  });
  assert.deepEqual(provisionInput, {
    id: "IS-2",
    adapterWorkspaceId: "workspace-2",
    adapterControlPlane: "https://controller.example",
    adapterTtlSeconds: 14_400,
    adapterIdleTimeoutSeconds: 1_800,
    adapterRequestedCapabilities: containerCapabilities,
    adapterCreatePayloadJson: '{"id":"workspace-2"}',
    parentSessionId: "IS-1",
    rootSessionId: "IS-root",
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "crabbox",
    profile: "default",
    command: "codex --yolo",
    prompt: "continue",
    purpose: "refactor",
    summary: "starting",
    owner: "owner-override",
    createdBy: "service:openclaw",
    githubToken: "github-token",
  });
});

test("session creation retries only an unowned reservation collision", async () => {
  const constraint = new Error("unique");
  const ids = ["IS-2", "IS-3"];
  const inserted: string[] = [];
  const current = session({ id: "IS-3", status: "ready" });
  const service = new InteractiveSessionCreationService(
    creationStore({
      nextSessionId: async () => ids.shift() ?? "unexpected",
      createReservationContext: async (_request, context) => ({
        ...reservationContext,
        adapterWorkspaceId: `workspace-${context.id}`,
      }),
      insertReservation: async (input) => {
        inserted.push(input.id);
        if (input.id === "IS-2") throw constraint;
      },
      isConstraintError: (error) => error === constraint,
      readSession: async () => current,
    }),
    creationConfiguration,
  );

  assert.equal(await service.create({ repo: "openclaw/crabfleet" }), current);
  assert.deepEqual(inserted, ["IS-2", "IS-3"]);
});

test("session creation returns a durable replay after a request reservation race", async () => {
  const constraint = new Error("unique");
  const replay = session({ id: "IS-9", status: "ready" });
  let provisioned = false;
  const service = new InteractiveSessionCreationService(
    creationStore({
      insertReservation: async () => {
        throw constraint;
      },
      isConstraintError: (error) => error === constraint,
      readRequestReplay: async (requestId, requestHash) => {
        assert.equal(requestId, "request-1");
        assert.equal(requestHash, "hash-1");
        return replay;
      },
      provisionManaged: async () => {
        provisioned = true;
        return null;
      },
    }),
    creationConfiguration,
  );

  assert.equal(
    await service.create({ repo: "openclaw/crabfleet" }, undefined, {
      openClawRequestId: "request-1",
      openClawRequestHash: "hash-1",
    }),
    replay,
  );
  assert.equal(provisioned, false);
});

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
    creationConfiguration,
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
    creationConfiguration,
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
    creationConfiguration,
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
    creationConfiguration,
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
    creationConfiguration,
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

test("session creation persists provision evidence before terminal finalization", async () => {
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      persistProvisionResult: async () => {
        calls.push("persist");
        return { updated: true, terminalStatus: "failed", terminalAt: 150 };
      },
      recordProvisionEvent: async (_sessionId, message, now) => {
        calls.push(`event:${message}:${now}`);
      },
      finalizeTerminal: async (_sessionId, status, now) => {
        calls.push(`finalize:${status}:${now}`);
      },
    }),
    creationConfiguration,
  );

  assert.deepEqual(
    await service.completeProvision(
      {
        sessionId: "IS-2",
        insertedAt: 100,
        profile: "default",
        requestedCapabilities: containerCapabilities,
        initialLeaseId: null,
        initialAgentTokenHash: "agent-hash",
        adapterName: "runtime-adapter",
      },
      {
        status: "failed",
        leaseId: null,
        attachUrl: null,
        vncUrl: null,
        message: "provider failed",
      },
    ),
    { updated: true, terminalStatus: "failed", terminalAt: 150 },
  );
  assert.deepEqual(calls, ["persist", "event:provider failed:101", "finalize:failed:150"]);
});

test("session creation records pending adapters without finalization", async () => {
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      markPendingAdapter: async () => {
        calls.push("pending");
      },
      recordProvisionEvent: async (_sessionId, message, now) => {
        calls.push(`event:${message}:${now}`);
      },
      finalizeTerminal: async () => {
        calls.push("finalize");
      },
    }),
    creationConfiguration,
  );

  const result = await service.completeProvision(
    {
      sessionId: "IS-2",
      insertedAt: 100,
      profile: "default",
      requestedCapabilities: containerCapabilities,
      initialLeaseId: null,
      initialAgentTokenHash: "agent-hash",
      adapterName: "runtime-adapter",
    },
    null,
  );
  assert.deepEqual(result, { updated: true, terminalStatus: null, terminalAt: 101 });
  assert.deepEqual(calls, ["pending", "event:waiting for interactive runtime adapter:101"]);
});

test("session creation preserves the currently owned adapter provision", async () => {
  const current = session({
    id: "IS-2",
    status: "ready",
    adapter: "runtime-v1",
    adapter_workspace_id: "workspace-current",
  });
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      readSession: async () => current,
      stopSupersededAdapter: async () => {
        calls.push("stop");
      },
    }),
    creationConfiguration,
  );

  assert.equal(
    await service.recoverSupersededProvision(
      {
        sessionId: "IS-2",
        adapterName: "runtime-v1",
        sandboxLeasePrefix: "sandbox:",
        now: 150,
      },
      {
        status: "ready",
        leaseId: null,
        attachUrl: null,
        vncUrl: null,
        message: "ready",
        adapter: "runtime-v1",
        adapterWorkspaceId: "workspace-current",
      },
    ),
    current,
  );
  assert.deepEqual(calls, []);
});

test("session creation stops superseded adapter workspaces", async () => {
  const current = session({
    id: "IS-2",
    status: "ready",
    adapter: "runtime-v1",
    adapter_workspace_id: "workspace-current",
  });
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      readSession: async () => current,
      stopSupersededAdapter: async (sessionId, workspaceId, createPending, now) => {
        calls.push(`stop:${sessionId}:${workspaceId}:${createPending}:${now}`);
      },
    }),
    creationConfiguration,
  );

  assert.equal(
    await service.recoverSupersededProvision(
      {
        sessionId: "IS-2",
        adapterName: "runtime-v1",
        sandboxLeasePrefix: "sandbox:",
        now: 150,
      },
      {
        status: "ready",
        leaseId: null,
        attachUrl: null,
        vncUrl: null,
        message: "late create",
        adapter: "runtime-v1",
        adapterWorkspaceId: "workspace-late",
        createPending: true,
      },
    ),
    current,
  );
  assert.deepEqual(calls, ["stop:IS-2:workspace-late:true:150"]);
});

test("session creation cleans superseded sandbox ownership and rereads durability", async () => {
  const before = session({ id: "IS-2", status: "stopping" });
  const after = session({ id: "IS-2", status: "failed" });
  let reads = 0;
  const calls: string[] = [];
  const service = new InteractiveSessionCreationService(
    creationStore({
      readSession: async () => {
        reads += 1;
        return reads === 1 ? before : after;
      },
      cleanupSupersededSandbox: async (sessionId, leaseId) => {
        calls.push(`cleanup:${sessionId}:${leaseId}`);
      },
    }),
    creationConfiguration,
  );

  assert.equal(
    await service.recoverSupersededProvision(
      {
        sessionId: "IS-2",
        adapterName: "runtime-v1",
        sandboxLeasePrefix: "sandbox:",
        now: 150,
      },
      {
        status: "ready",
        leaseId: "sandbox:late",
        attachUrl: null,
        vncUrl: null,
        message: "late sandbox",
      },
    ),
    after,
  );
  assert.deepEqual(calls, ["cleanup:IS-2:sandbox:late"]);
  assert.equal(reads, 2);
});

test("session creation fails explicitly when durable ownership disappears", async () => {
  const service = new InteractiveSessionCreationService(creationStore(), creationConfiguration);
  await assert.rejects(
    service.recoverSupersededProvision(
      {
        sessionId: "IS-2",
        adapterName: "runtime-v1",
        sandboxLeasePrefix: "sandbox:",
        now: 150,
      },
      {
        status: "ready",
        leaseId: null,
        attachUrl: null,
        vncUrl: null,
        message: "ready",
      },
    ),
    /interactive session disappeared during provisioning/,
  );
});
