import assert from "node:assert/strict";
import test from "node:test";

import { parseAdapterWorkspaceResult } from "../src/runtime-adapter.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  failRuntimeAdapterWorkspaceIdConflict,
  stageRuntimeAdapterProvision,
} from "../src/worker/provisioning/runtime-adapter-repository.ts";
import {
  RuntimeAdapterProvisioningService,
  runtimeAdapterProvisionResult,
  type RuntimeAdapterProvisioningDependencies,
} from "../src/worker/provisioning/runtime-adapter.ts";
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
} from "../src/worker/provisioning/types.ts";
import { containerCapabilities } from "../src/worker/session-model.ts";

const session: InteractiveProvisionRequest = {
  id: "IS-101",
  adapterWorkspaceId: "fleet-a-is-101",
  adapterControlPlane: "https://controller.example/api/",
  adapterTtlSeconds: 14_400,
  adapterIdleTimeoutSeconds: 1_800,
  adapterRequestedCapabilities: {
    terminal: true,
    takeover: true,
    vnc: true,
    desktop: true,
    logs: true,
    artifacts: true,
  },
  parentSessionId: "IS-100",
  rootSessionId: "IS-99",
  repo: "example/project",
  branch: "feature/refactor",
  runtime: "crabbox",
  profile: "desktop-large",
  command: "codex --yolo",
  prompt: "continue",
  purpose: "refactor",
  summary: "starting",
  owner: "operator",
  createdBy: "service",
};

const createAttempt = {
  status: "provisioning" as const,
  updatedAt: 101,
  lastReconciledAt: null,
  terminalStatus: null,
};

function failedConflictResult(message = "workspace conflict"): InteractiveProvisionResult {
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message,
    adapter: null,
    profile: session.profile,
    adapterWorkspaceId: null,
    createPending: false,
  };
}

function dependencies(
  overrides: Partial<RuntimeAdapterProvisioningDependencies> = {},
): RuntimeAdapterProvisioningDependencies {
  return {
    namespace: "fleet-a",
    now: () => 200,
    resolveControlPlane: (_profile, registeredControlPlane) => {
      if (!registeredControlPlane) throw new Error("registered control plane missing");
      return registeredControlPlane;
    },
    async stageProvision() {
      return createAttempt;
    },
    async createWorkspace() {
      return {
        ok: true,
        status: 201,
        body: {
          id: "fleet-a-is-101",
          status: "ready",
          profile: "desktop-large",
          attachUrl: "wss://controller.example/terminal/IS-101",
          capabilities: session.adapterRequestedCapabilities,
          expiresAt: "2026-06-15T12:00:00Z",
          message: "ready",
        },
      };
    },
    async failWorkspaceIdConflict() {
      return failedConflictResult();
    },
    async stageFailedRelease() {},
    async stopWorkspaceForSession() {
      return { status: "stopped", message: "runtime workspace released" };
    },
    async recordConfirmedRelease() {},
    async persistStopEvidence() {},
    ...overrides,
  };
}

test("runtime adapter create stages and sends the immutable registered payload", async () => {
  const stages: unknown[] = [];
  const creates: unknown[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async stageProvision(input) {
        stages.push(input);
        return createAttempt;
      },
      async createWorkspace(input) {
        creates.push(input);
        return dependencies().createWorkspace(input);
      },
    }),
  );

  const result = await service.provision(session);

  assert.equal(result.status, "ready");
  assert.equal(result.profile, "desktop-large");
  assert.equal(result.adapterWorkspaceId, "fleet-a-is-101");
  assert.equal(result.attachUrl, "wss://controller.example/terminal/IS-101");
  assert.equal(stages.length, 1);
  assert.equal(creates.length, 1);
  const stage = stages[0] as {
    adapterControlPlane: string;
    adapterWorkspaceId: string;
    createPayloadJson: string;
  };
  assert.equal(stage.adapterControlPlane, "https://controller.example/api/");
  assert.equal(stage.adapterWorkspaceId, "fleet-a-is-101");
  assert.deepEqual(JSON.parse(stage.createPayloadJson), {
    id: "fleet-a-is-101",
    parentSessionId: "IS-100",
    rootSessionId: "IS-99",
    repo: "example/project",
    branch: "feature/refactor",
    runtime: "crabbox",
    profile: "desktop-large",
    command: "codex --yolo",
    prompt: "continue",
    purpose: "refactor",
    summary: "starting",
    owner: "operator",
    createdBy: "service",
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    capabilities: { desktop: true },
  });
  assert.deepEqual(creates[0], {
    url: "https://controller.example/api/v1/workspaces",
    adapterWorkspaceId: "fleet-a-is-101",
    createPayloadJson: stage.createPayloadJson,
  });
});

test("runtime adapter create rejects response identity and profile changes as ambiguous", async () => {
  const wrongIdentity = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        return {
          ok: true,
          status: 201,
          body: {
            id: "different-workspace",
            status: "ready",
            profile: session.profile,
          },
        };
      },
    }),
  );
  const wrongProfile = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        return {
          ok: true,
          status: 201,
          body: {
            id: session.adapterWorkspaceId,
            status: "ready",
            profile: "different-profile",
          },
        };
      },
    }),
  );

  assert.match((await wrongIdentity.provision(session)).message, /workspace identity mismatch/);
  assert.match((await wrongProfile.provision(session)).message, /workspace profile mismatch/);
});

test("runtime adapter transport failures remain ambiguous and retain create ownership", async () => {
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        throw new Error("request failed token=secret");
      },
    }),
  );

  const result = await service.provision(session);

  assert.equal(result.status, "provisioning");
  assert.equal(result.createPending, true);
  assert.match(result.message, /create outcome unknown/);
  assert.doesNotMatch(result.message, /secret/);
});

test("definitive create failures stage release before stopping and confirming", async () => {
  const calls: string[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        return {
          ok: false,
          status: 422,
          body: { detail: "capacity unavailable; token=private-value" },
        };
      },
      async stageFailedRelease(_sessionId, _workspaceId, message) {
        calls.push(`stage:${message}`);
      },
      async stopWorkspaceForSession() {
        calls.push("stop");
        return { status: "stopped", message: "runtime workspace released" };
      },
      async recordConfirmedRelease() {
        calls.push("confirm");
      },
    }),
  );

  const result = await service.provision(session);

  assert.equal(result.status, "failed");
  assert.equal(result.terminalStatus, null);
  assert.match(result.message, /capacity unavailable; \[credential\]/);
  assert.deepEqual(
    calls.map((call) => call.split(":")[0]),
    ["stage", "stop", "confirm"],
  );
});

test("pending failed releases retain terminal failure and persist stop evidence", async () => {
  const calls: string[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async stageFailedRelease(_sessionId, _workspaceId, _message, now) {
        calls.push(`stage:${now}`);
      },
      async stopWorkspaceForSession() {
        calls.push("stop");
        return { status: "stopping", message: "runtime workspace release pending" };
      },
      async persistStopEvidence(_sessionId, _workspaceId, _message, now) {
        calls.push(`evidence:${now}`);
      },
    }),
  );

  const result = await service.releaseFailed("IS-101", {
    status: "failed",
    leaseId: null,
    attachUrl: "wss://controller.example/private-terminal",
    vncUrl: null,
    message: "provider failed",
    adapterWorkspaceId: "fleet-a-is-101",
  });

  assert.equal(result.status, "stopping");
  assert.equal(result.terminalStatus, "failed");
  assert.equal(result.attachUrl, null);
  assert.equal(result.reconcileError, "provider failed; runtime workspace release pending");
  assert.deepEqual(calls, ["stage:200", "stop", "evidence:200"]);
});

test("failed release transport errors stay retryable and redact connection authority", async () => {
  const evidence: string[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async stopWorkspaceForSession() {
        throw new Error("delete failed token=private wss://controller.example/private-terminal");
      },
      async persistStopEvidence(_sessionId, _workspaceId, message) {
        evidence.push(message);
      },
    }),
  );

  const result = await service.releaseFailed("IS-101", {
    status: "failed",
    leaseId: null,
    attachUrl: "wss://controller.example/private-terminal",
    vncUrl: null,
    message: "provider failed",
    adapterWorkspaceId: "fleet-a-is-101",
  });

  assert.equal(result.status, "stopping");
  assert.equal(result.terminalStatus, "failed");
  assert.match(result.message, /runtime workspace release pending/);
  assert.doesNotMatch(result.message, /private/);
  assert.deepEqual(evidence, [result.message]);
});

test("create replays keep retryable and definitive responses ambiguous", async () => {
  const calls: string[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        return { ok: false, status: 422, body: { message: "invalid while replaying" } };
      },
      async stageFailedRelease() {
        calls.push("stage-release");
      },
    }),
  );

  const result = await service.provision(session, {
    status: "provisioning",
    updatedAt: 100,
    lastReconciledAt: 90,
    terminalStatus: null,
  });

  assert.equal(result.status, "provisioning");
  assert.equal(result.createPending, true);
  assert.match(result.message, /create replay pending/);
  assert.deepEqual(calls, []);
});

test("workspace id conflicts detach through the fenced repository callback only", async () => {
  const calls: string[] = [];
  const service = new RuntimeAdapterProvisioningService(
    dependencies({
      async createWorkspace() {
        return {
          ok: false,
          status: 409,
          body: { error: { code: "workspace_id_conflict", message: "already owned" } },
        };
      },
      async failWorkspaceIdConflict(input) {
        calls.push(`conflict:${input.createAttempt.updatedAt}:${input.adapterControlPlane}`);
        return failedConflictResult("already owned");
      },
      async stageFailedRelease() {
        calls.push("stage-release");
      },
      async stopWorkspaceForSession() {
        calls.push("stop");
        return { status: "stopped", message: "stopped" };
      },
    }),
  );

  const result = await service.provision(session);

  assert.equal(result.message, "already owned");
  assert.deepEqual(calls, ["conflict:101:https://controller.example/api/"]);
});

test("runtime adapter result mapping preserves registered profile and requested capabilities", () => {
  const parsed = parseAdapterWorkspaceResult(
    {
      id: "fleet-a-is-101",
      status: "ready",
      profile: "provider-profile",
      capabilities: { terminal: true },
    },
    { workspaceId: "fleet-a-is-101" },
  );
  assert.ok(parsed);

  const result = runtimeAdapterProvisionResult(
    parsed,
    {
      runtime: "container",
      profile: "registered-profile",
      adapterRequestedCapabilities: containerCapabilities,
    },
    200,
    "fleet-a-is-101",
    true,
  );

  assert.equal(result.profile, "registered-profile");
  assert.deepEqual(result.capabilities, {
    ...containerCapabilities,
    terminal: true,
  });
});

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (sql: string, parameters: unknown[], kind: "all" | "run") => unknown[],
  batchHandler: (statements: PreparedStatement[]) => unknown[] = () => [],
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              sql,
              parameters,
              async all() {
                return { results: handler(sql, parameters, "all"), meta: { changes: 1 } };
              },
              async run() {
                handler(sql, parameters, "run");
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        return batchHandler(statements as PreparedStatement[]);
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("runtime adapter create staging compiles exact lifecycle fences", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = runtimeEnv((sql, parameters) => {
    executions.push({ sql, parameters });
    return [
      {
        status: "provisioning",
        updated_at: 102,
        last_reconciled_at: 90,
        terminal_status: null,
      },
    ];
  });

  const result = await stageRuntimeAdapterProvision(env, {
    session,
    now: 100,
    adapterControlPlane: "https://controller.example/api/",
    adapterWorkspaceId: "fleet-a-is-101",
    capabilities: session.adapterRequestedCapabilities!,
    ttlSeconds: 14_400,
    idleTimeoutSeconds: 1_800,
    createPayloadJson: '{"id":"fleet-a-is-101"}',
    reconciliationOwner: {
      status: "provisioning",
      updatedAt: 101,
      lastReconciledAt: 90,
      terminalStatus: null,
    },
  });

  assert.deepEqual(result, {
    status: "provisioning",
    updatedAt: 102,
    lastReconciledAt: 90,
    terminalStatus: null,
  });
  assert.equal(executions.length, 1);
  assert.match(executions[0].sql, /adapter_control_plane/);
  assert.match(executions[0].sql, /adapter_workspace_id/);
  assert.match(executions[0].sql, /last_reconciled_at/);
  assert.match(executions[0].sql, /terminal_status"?\s+is null/i);
  assert.ok(executions[0].parameters.includes("https://controller.example/api/"));
  assert.ok(executions[0].parameters.includes("fleet-a-is-101"));
  assert.ok(executions[0].parameters.includes(101));
  assert.ok(executions[0].parameters.includes(90));
});

test("workspace conflict detachment batches the full ownership fence", async () => {
  let statements: PreparedStatement[] = [];
  const env = runtimeEnv(
    () => [],
    (prepared) => {
      statements = prepared;
      return [{ results: [] }, { results: [] }];
    },
  );

  const result = await failRuntimeAdapterWorkspaceIdConflict(env, {
    session,
    now: 200,
    adapterControlPlane: "https://controller.example/api/",
    adapterWorkspaceId: "fleet-a-is-101",
    createPayloadJson: '{"id":"fleet-a-is-101"}',
    capabilities: session.adapterRequestedCapabilities!,
    createAttempt: {
      status: "provisioning",
      updatedAt: 101,
      lastReconciledAt: 90,
      terminalStatus: null,
    },
    message: "workspace already owned",
  });

  assert.equal(result, null);
  assert.equal(statements.length, 2);
  const batchSql = statements.map((statement) => statement.sql).join("\n");
  assert.match(batchSql, /adapter_create_pending/);
  assert.match(batchSql, /adapter_control_plane/);
  assert.match(batchSql, /adapter_create_payload_json/);
  assert.match(batchSql, /adapter_requested_capabilities_json/);
  assert.match(batchSql, /last_reconciled_at/);
  assert.match(batchSql, /terminal_status"?\s+is null/i);
  assert.match(batchSql, /terminal_finalize_pending/);
  const parameters = statements.flatMap((statement) => statement.parameters);
  assert.ok(parameters.includes("https://controller.example/api/"));
  assert.ok(parameters.includes("fleet-a-is-101"));
  assert.ok(parameters.includes(101));
  assert.ok(parameters.includes(90));
});
