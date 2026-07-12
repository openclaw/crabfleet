import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  claimRuntimeAdapterWorkspaceCleanup,
  claimRuntimeAdapterWorkspaceCleanupBatch,
  completeRuntimeAdapterWorkspaceCleanup,
  markRuntimeAdapterWorkspaceCleanupDeletionObserved,
  persistRuntimeAdapterWorkspaceCleanupEvidence,
  stageRuntimeAdapterWorkspaceCleanup,
} from "../src/worker/provisioning/runtime-adapter-release-repository.ts";
import {
  clearRuntimeAdapterCreatePending,
  confirmRuntimeAdapterRelease,
  type RuntimeAdapterReleaseEffects,
} from "../src/worker/provisioning/runtime-adapter-repository.ts";
import {
  RuntimeAdapterReleaseService,
  type RuntimeAdapterReleaseServiceDependencies,
  type RuntimeAdapterWorkspaceCleanup,
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
  let stagedCleanup: RuntimeAdapterWorkspaceCleanup | null = null;
  return {
    async stageCleanup(input) {
      stagedCleanup = {
        sessionId: input.sessionId,
        adapterWorkspaceId: input.adapterWorkspaceId,
        registration: input.registration,
        createPending: input.createPending,
        deletionObserved: false,
        claim: "claim-1",
      };
    },
    async claimCleanup() {
      return stagedCleanup;
    },
    async claimPendingCleanups() {
      return [];
    },
    async persistCleanupEvidence() {},
    async markCleanupDeletionObserved() {},
    async completeCleanup() {},
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
      async stageCleanup(input) {
        calls.push(`stage:${input.sessionId}:${input.adapterWorkspaceId}`);
      },
      async claimCleanup(sessionId, adapterWorkspaceId) {
        return {
          sessionId,
          adapterWorkspaceId,
          registration,
          createPending: false,
          deletionObserved: false,
          claim: "claim-1",
        };
      },
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
      async completeCleanup(cleanup) {
        calls.push(`complete:${cleanup.sessionId}:${cleanup.adapterWorkspaceId}`);
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
    "stage:IS-101:fleet-a-is-101",
    "clear:IS-101:fleet-a-is-101",
    "stop:IS-101:fleet-a-is-101:default:https://adapter.example.test/:false",
    "confirm:IS-101:fleet-a-is-101:200:runtime workspace released",
    "complete:IS-101:fleet-a-is-101",
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

test("superseded cleanup survives ownership loss and retries only the old workspace", async () => {
  const replacementWorkspaceId = "fleet-a-is-101-replacement";
  const cleanupRows = new Map<string, RuntimeAdapterWorkspaceCleanup>();
  const stopped: string[] = [];
  const sessionEvidence: string[] = [];
  let stopAttempts = 0;
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async stageCleanup(input) {
        cleanupRows.set(input.adapterWorkspaceId, {
          sessionId: input.sessionId,
          adapterWorkspaceId: input.adapterWorkspaceId,
          registration: input.registration,
          createPending: input.createPending,
          deletionObserved: false,
          claim: "claim-1",
        });
      },
      async claimCleanup(_sessionId, adapterWorkspaceId) {
        return cleanupRows.get(adapterWorkspaceId) ?? null;
      },
      async claimPendingCleanups() {
        return [...cleanupRows.values()].map((cleanup) => ({
          ...cleanup,
          claim: "claim-2",
        }));
      },
      async stopWorkspace(_sessionId, adapterWorkspaceId) {
        stopped.push(adapterWorkspaceId);
        stopAttempts += 1;
        return stopAttempts === 1
          ? { status: "stopping", message: "provider stop pending" }
          : { status: "stopped", message: "provider workspace released" };
      },
      async persistCleanupEvidence(cleanup, message) {
        cleanupRows.set(cleanup.adapterWorkspaceId, {
          ...cleanup,
          claim: "",
        });
        assert.equal(message, "provider stop pending");
      },
      async persistStopEvidence(_sessionId, adapterWorkspaceId) {
        if (adapterWorkspaceId === replacementWorkspaceId) {
          sessionEvidence.push(adapterWorkspaceId);
        }
      },
      async confirmRelease(_sessionId, adapterWorkspaceId) {
        assert.notEqual(adapterWorkspaceId, replacementWorkspaceId);
        return null;
      },
      async completeCleanup(cleanup) {
        cleanupRows.delete(cleanup.adapterWorkspaceId);
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101-old",
    registration,
    createPending: true,
    now: 200,
  });
  assert.equal(cleanupRows.size, 1);

  await service.retryPending(300);

  assert.deepEqual(stopped, ["fleet-a-is-101-old", "fleet-a-is-101-old"]);
  assert.deepEqual(sessionEvidence, []);
  assert.equal(cleanupRows.size, 0);
});

test("superseded provider failures remain independently retryable", async () => {
  const cleanupRows: RuntimeAdapterWorkspaceCleanup[] = [];
  let fail = true;
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async stageCleanup(input) {
        cleanupRows.push({
          sessionId: input.sessionId,
          adapterWorkspaceId: input.adapterWorkspaceId,
          registration: input.registration,
          createPending: input.createPending,
          deletionObserved: false,
          claim: "claim-1",
        });
      },
      async claimCleanup() {
        return cleanupRows[0] ?? null;
      },
      async claimPendingCleanups() {
        return cleanupRows;
      },
      async stopWorkspace() {
        if (fail) {
          fail = false;
          throw new Error("provider unavailable");
        }
        return { status: "stopped", message: "provider workspace released" };
      },
      async persistCleanupEvidence(cleanup, message, _now, reconcileError) {
        assert.equal(cleanup.adapterWorkspaceId, "fleet-a-is-101-old");
        assert.equal(message, "superseded runtime adapter stop pending: provider unavailable");
        assert.equal(reconcileError, "provider unavailable");
      },
      async completeCleanup() {
        cleanupRows.length = 0;
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101-old",
    registration,
    createPending: true,
    now: 200,
  });
  assert.equal(cleanupRows.length, 1);

  await service.retryPending(300);
  assert.equal(cleanupRows.length, 0);
});

test("observed create-pending deletion survives completion persistence failure", async () => {
  let cleanup: RuntimeAdapterWorkspaceCleanup | null = null;
  const retryMissing: boolean[] = [];
  let completionAttempts = 0;
  const service = new RuntimeAdapterReleaseService(
    releaseDependencies({
      async stageCleanup(input) {
        cleanup = {
          sessionId: input.sessionId,
          adapterWorkspaceId: input.adapterWorkspaceId,
          registration: input.registration,
          createPending: input.createPending,
          deletionObserved: false,
          claim: "claim-1",
        };
      },
      async claimCleanup() {
        return cleanup;
      },
      async claimPendingCleanups() {
        return cleanup ? [{ ...cleanup, claim: "claim-2" }] : [];
      },
      async stopWorkspace(_sessionId, _adapterWorkspaceId, _registration, retry) {
        retryMissing.push(retry);
        return {
          status: "stopped",
          message: retry
            ? "runtime adapter workspace released"
            : "runtime adapter workspace already gone",
        };
      },
      async markCleanupDeletionObserved(current) {
        cleanup = { ...current, deletionObserved: true };
      },
      async completeCleanup() {
        completionAttempts += 1;
        if (completionAttempts === 1) throw new Error("completion persistence unavailable");
        cleanup = null;
      },
      providerError(error) {
        assert.ok(error instanceof Error);
        return error.message;
      },
    }),
  );

  await service.stopSuperseded({
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101-old",
    registration,
    createPending: true,
    now: 200,
  });
  assert.equal(cleanup?.deletionObserved, true);

  await service.retryPending(15_200);

  assert.deepEqual(retryMissing, [true, false]);
  assert.equal(completionAttempts, 2);
  assert.equal(cleanup, null);
});

test("runtime adapter cleanup storage is independent and claim fenced", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0037_runtime_adapter_workspace_cleanup.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0039_runtime_adapter_cleanup_deletion_observed.sql", import.meta.url),
      "utf8",
    ),
  );
  const env = sqliteRuntimeEnv(sqlite);
  await stageRuntimeAdapterWorkspaceCleanup(env, {
    sessionId: "IS-101",
    adapterWorkspaceId: "fleet-a-is-101-old",
    registration,
    createPending: true,
    now: 200,
  });

  const claimed = await claimRuntimeAdapterWorkspaceCleanup(
    env,
    "IS-101",
    "fleet-a-is-101-old",
    200,
  );
  assert.ok(claimed);
  assert.equal(claimed.createPending, true);
  assert.equal(claimed.deletionObserved, false);
  assert.deepEqual(claimed.registration, registration);
  assert.equal((await claimRuntimeAdapterWorkspaceCleanupBatch(env, 200, 3)).length, 0);

  await markRuntimeAdapterWorkspaceCleanupDeletionObserved(env, claimed, 201);
  await persistRuntimeAdapterWorkspaceCleanupEvidence(
    env,
    claimed,
    "provider stop pending",
    200,
    null,
  );
  assert.equal((await claimRuntimeAdapterWorkspaceCleanupBatch(env, 15_199, 3)).length, 0);
  const retry = await claimRuntimeAdapterWorkspaceCleanupBatch(env, 15_200, 3);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].deletionObserved, true);
  await completeRuntimeAdapterWorkspaceCleanup(env, retry[0]);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS count FROM runtime_adapter_workspace_cleanups").get()?.count,
    0,
  );
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

type BoundStatement = {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
};

function sqliteRuntimeEnv(sqlite: DatabaseSync): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = sqlite.prepare(sql);
    if (/^\s*(?:select|pragma|with)\b|\breturning\b/i.test(sql)) {
      const results = statement.all(...parameters).map((row) => ({ ...row }));
      const changes = Number(sqlite.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
      return { results, success: true as const, meta: { changes } };
    }
    const result = statement.run(...parameters);
    return {
      results: [],
      success: true as const,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const bound = {
              execute: () => execute(sql, parameters),
              async all() {
                return bound.execute();
              },
              async run() {
                return bound.execute();
              },
            };
            return bound;
          },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) =>
            (statement as unknown as BoundStatement).execute(),
          );
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}
