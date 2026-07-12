import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  clearRuntimeAdapterCreatePending,
  confirmRuntimeAdapterRelease,
  type RuntimeAdapterReleaseEffects,
} from "../src/worker/provisioning/runtime-adapter-repository.ts";
import {
  RuntimeAdapterReleaseService,
  type RuntimeAdapterReleaseServiceDependencies,
  type RuntimeAdapterWorkspaceRegistration,
} from "../src/worker/provisioning/runtime-adapter-release-service.ts";

const registration: RuntimeAdapterWorkspaceRegistration = {
  profile: "default",
  controlPlane: "https://adapter.example.test/",
};

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function releaseDependencies(
  overrides: Partial<RuntimeAdapterReleaseServiceDependencies> = {},
): RuntimeAdapterReleaseServiceDependencies {
  return {
    async clearCreatePending() {},
    async stopWorkspace() {
      return { status: "stopped", message: "runtime workspace released" };
    },
    async confirmRelease() {
      return "stopped";
    },
    async persistStopEvidence() {},
    providerError() {
      return "provider unavailable";
    },
    ...overrides,
  };
}

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

test("superseded release clears the create marker before stopping and confirming", async () => {
  const calls: string[] = [];
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async clearCreatePending(sessionId, adapterWorkspaceId) {
        calls.push(`clear:${sessionId}:${adapterWorkspaceId}`);
      },
      async stopWorkspace(sessionId, adapterWorkspaceId, retained, createPending) {
        calls.push(
          `stop:${sessionId}:${adapterWorkspaceId}:${retained?.profile}:${retained?.controlPlane}:${createPending}`,
        );
        return { status: "stopped", message: "runtime workspace released" };
      },
      async confirmRelease(sessionId, adapterWorkspaceId, now, message) {
        calls.push(`confirm:${sessionId}:${adapterWorkspaceId}:${now}:${message}`);
        return "stopped";
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101",
    registration,
    createPending: false,
    now: 200,
  });

  assert.deepEqual(calls, [
    "clear:IS-101:fleet-a-is-101",
    "stop:IS-101:fleet-a-is-101:default:https://adapter.example.test/:false",
    "confirm:IS-101:fleet-a-is-101:200:runtime workspace released",
  ]);
});

test("superseded release preserves pending stop evidence", async () => {
  const evidence: unknown[][] = [];
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async stopWorkspace() {
        return { status: "stopping", message: "stop accepted" };
      },
      async persistStopEvidence(...args) {
        evidence.push(args);
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101",
    registration,
    createPending: true,
    now: 200,
  });

  assert.deepEqual(evidence, [["IS-101", "fleet-a-is-101", "stop accepted", 200, null]]);
});

test("superseded release records redacted provider failures for retry", async () => {
  const evidence: unknown[][] = [];
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async stopWorkspace() {
        throw new Error("secret provider detail");
      },
      providerError(error, adapterWorkspaceId) {
        assert.ok(error instanceof Error);
        assert.equal(adapterWorkspaceId, "fleet-a-is-101");
        return "provider unavailable";
      },
      async persistStopEvidence(...args) {
        evidence.push(args);
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101",
    registration,
    createPending: true,
    now: 200,
  });

  assert.deepEqual(evidence, [
    [
      "IS-101",
      "fleet-a-is-101",
      "superseded runtime adapter stop pending: provider unavailable",
      200,
      "provider unavailable",
    ],
  ]);
});

test("confirmed release waits for create resolution behind an exact lifecycle fence", async () => {
  let statements: PreparedStatement[] = [];
  const effects: string[] = [];
  const env = runtimeEnv(
    () => [
      {
        adapter_create_pending: 1,
        terminal_status: "failed",
        terminal_failure_reason: "original failure",
        reconcile_error: "release error",
        last_event: "runtime workspace released",
        updated_at: 101,
      },
    ],
    (prepared) => {
      statements = prepared;
      return [{ results: [{ updated_at: 102 }] }];
    },
  );

  const result = await confirmRuntimeAdapterRelease(
    env,
    "IS-101",
    "fleet-a-is-101",
    200,
    "runtime workspace released",
    releaseEffects(effects),
  );

  assert.equal(result, "stopping");
  assert.deepEqual(effects, []);
  assert.equal(statements.length, 1);
  assert.match(statements[0].sql, /adapter_create_pending/);
  assert.match(statements[0].sql, /terminal_status/);
  assert.match(statements[0].sql, /updated_at/);
  assert.match(statements[0].sql, /max\(updated_at \+ 1, \?\)/i);
  assert.ok(statements[0].parameters.includes("IS-101"));
  assert.ok(statements[0].parameters.includes("fleet-a-is-101"));
  assert.ok(statements[0].parameters.includes(101));
});

test("confirmed failed release retains failure evidence and finalizes atomically", async () => {
  let statements: PreparedStatement[] = [];
  const effects: string[] = [];
  const env = runtimeEnv(
    () => [
      {
        adapter_create_pending: 0,
        terminal_status: "failed",
        terminal_failure_reason: "original failure",
        reconcile_error: "later release error",
        last_event: "runtime adapter stop pending",
        updated_at: 101,
      },
    ],
    (prepared) => {
      statements = prepared;
      return [{ results: [] }, { results: [{ updated_at: 102 }] }];
    },
  );

  const result = await confirmRuntimeAdapterRelease(
    env,
    "IS-101",
    "fleet-a-is-101",
    200,
    "runtime workspace released",
    releaseEffects(effects),
  );

  assert.equal(result, "failed");
  assert.deepEqual(effects, ["archive:IS-101:200", "finalize:IS-101:failed:200"]);
  assert.equal(statements.length, 2);
  const sql = statements.map((statement) => statement.sql).join("\n");
  const parameters = statements.flatMap((statement) => statement.parameters);
  assert.match(sql, /insert into interactive_session_events/i);
  assert.match(sql, /terminal_finalize_pending/i);
  assert.match(sql, /adapter_create_pending/i);
  assert.match(sql, /terminal_status/);
  assert.match(sql, /updated_at/);
  assert.ok(parameters.includes("original failure"));
  assert.ok(parameters.includes("runtime workspace released"));
  assert.ok(parameters.includes(101));
});

test("confirmed stopped release persists provider evidence before finalization", async () => {
  let statements: PreparedStatement[] = [];
  const effects: string[] = [];
  const env = runtimeEnv(
    () => [
      {
        adapter_create_pending: 0,
        terminal_status: null,
        terminal_failure_reason: null,
        reconcile_error: null,
        last_event: "runtime adapter stop requested",
        updated_at: 101,
      },
    ],
    (prepared) => {
      statements = prepared;
      return [{ results: [] }, { results: [{ updated_at: 102 }] }];
    },
  );

  const result = await confirmRuntimeAdapterRelease(
    env,
    "IS-101",
    "fleet-a-is-101",
    200,
    "runtime workspace released",
    releaseEffects(effects),
  );

  assert.equal(result, "stopped");
  assert.deepEqual(effects, ["archive:IS-101:200", "finalize:IS-101:stopped:200"]);
  assert.equal(statements.length, 2);
  assert.match(statements[0].sql, /insert into interactive_session_events/i);
  assert.ok(statements[0].parameters.includes("runtime workspace released"));
});

test("create-pending clearing fences the prior marker and advances its revision", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "run");
    executions.push({ sql, parameters });
    return [];
  });

  await clearRuntimeAdapterCreatePending(env, "IS-101", "fleet-a-is-101");

  assert.equal(executions.length, 1);
  assert.match(executions[0].sql, /update "interactive_sessions"/i);
  assert.match(executions[0].sql, /"adapter_create_pending" = \?/i);
  assert.match(executions[0].sql, /"adapter" = \?/i);
  assert.match(executions[0].sql, /"adapter_workspace_id" = \?/i);
  assert.match(executions[0].sql, /"status" = \?/i);
  assert.match(executions[0].sql, /max\(updated_at \+ 1, \?\)/i);
  assert.match(executions[0].sql, /where[\s\S]*"adapter_create_pending" = \?/i);
  assert.ok(executions[0].parameters.includes("IS-101"));
  assert.ok(executions[0].parameters.includes("fleet-a-is-101"));
  assert.ok(executions[0].parameters.includes("stopping"));
  assert.ok(executions[0].parameters.includes(1));
});

function releaseEffects(calls: string[]): RuntimeAdapterReleaseEffects {
  return {
    async archive(sessionId, now) {
      calls.push(`archive:${sessionId}:${now}`);
    },
    async finalize(sessionId, status, now) {
      calls.push(`finalize:${sessionId}:${status}:${now}`);
    },
  };
}
