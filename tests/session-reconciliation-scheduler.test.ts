import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  interactiveSessionReconciliationDue,
  InteractiveSessionReconciliationScheduler,
  readInteractiveSessionReconciliationCandidates,
  readInteractiveSessionReconciliationRow,
  readLegacyStoppingInteractiveSessionCandidates,
  requeueTerminalArchiveObjectBackfill,
  type InteractiveSessionReconciliationSchedulerStore,
} from "../src/worker/session-reconciliation-scheduler.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };

function runtimeEnv(
  handler: (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result,
  sessionLogs = false,
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                const result = handler(sql, parameters, "all");
                return { results: result.results ?? [], meta: { changes: result.changes ?? 0 } };
              },
              async run() {
                const result = handler(sql, parameters, "run");
                return { meta: { changes: result.changes ?? 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    ...(sessionLogs ? { SESSION_LOGS: {} as R2Bucket } : {}),
  } as RuntimeEnv;
}

function schedulerStore(
  overrides: Partial<InteractiveSessionReconciliationSchedulerStore> = {},
): InteractiveSessionReconciliationSchedulerStore {
  return {
    async cleanupAbandonedPreparations() {},
    async cleanupCredentialPolicies() {},
    providerConfigured: () => true,
    async readLegacyStoppingCandidates() {
      return [];
    },
    async completeLegacyStop() {},
    async requeueTerminalArchiveBackfill() {},
    async readBatchCandidates() {
      return [];
    },
    async readSession() {
      return undefined;
    },
    async reconcile() {},
    report() {},
    ...overrides,
  };
}

function scheduler(
  store: InteractiveSessionReconciliationSchedulerStore,
): InteractiveSessionReconciliationScheduler {
  return new InteractiveSessionReconciliationScheduler(store, {
    adapterName: "runtime-adapter",
    sandboxLeasePrefix: "sandbox:",
    intervalMs: 15_000,
    limit: 2,
    concurrency: 2,
  });
}

test("batch scheduling orders cleanup, recovers legacy stops, and reconciles only bounded due rows", async () => {
  const order: string[] = [];
  const reconciled: string[] = [];
  const reports: string[] = [];
  const legacyOne = sessionRow({ id: "IS-L1", status: "stopping", adapter: null });
  const legacyTwo = sessionRow({ id: "IS-L2", status: "stopping", adapter: null });
  const active = sessionRow({
    id: "IS-A",
    status: "ready",
    adapter: "runtime-adapter",
    last_reconciled_at: null,
  });
  const terminal = sessionRow({
    id: "IS-T",
    status: "failed",
    terminal_finalize_pending: 1,
    last_reconciled_at: 1,
  });
  const recent = sessionRow({
    id: "IS-R",
    status: "ready",
    adapter: "runtime-adapter",
    last_reconciled_at: 99_000,
  });
  await scheduler(
    schedulerStore({
      async cleanupAbandonedPreparations() {
        order.push("abandoned");
      },
      async cleanupCredentialPolicies() {
        order.push("credentials");
      },
      async readLegacyStoppingCandidates() {
        order.push("legacy-read");
        return [legacyOne, legacyTwo];
      },
      async completeLegacyStop(row) {
        order.push(`legacy:${row.id}`);
        if (row.id === legacyTwo.id) throw new Error("stop unavailable");
      },
      async requeueTerminalArchiveBackfill() {
        order.push("backfill");
      },
      async readBatchCandidates(providerConfigured) {
        assert.equal(providerConfigured, true);
        order.push("batch-read");
        return [active, recent, terminal];
      },
      async reconcile(row) {
        reconciled.push(row.id);
      },
      report(message) {
        reports.push(message);
      },
    }),
  ).runBatch(100_000);

  assert.deepEqual(order.slice(0, 3), ["abandoned", "credentials", "legacy-read"]);
  assert.ok(order.indexOf("backfill") > order.indexOf(`legacy:${legacyTwo.id}`));
  assert.ok(order.indexOf("batch-read") > order.indexOf("backfill"));
  assert.deepEqual(new Set(reconciled), new Set([active.id, terminal.id]));
  assert.deepEqual(reports, [
    `legacy interactive session stop recovery failed for ${legacyTwo.id}`,
  ]);
});

test("targeted scheduling completes cleanup and admits terminal finalization without a provider", async () => {
  const order: string[] = [];
  const row = sessionRow({
    id: "IS-T",
    status: "stopped",
    terminal_finalize_pending: 1,
    last_reconciled_at: null,
  });
  await scheduler(
    schedulerStore({
      async cleanupCredentialPolicies(_now, sessionId) {
        order.push(`credentials:${sessionId}`);
      },
      providerConfigured: () => false,
      async readLegacyStoppingCandidates(sessionId) {
        order.push(`legacy:${sessionId}`);
        return [];
      },
      async requeueTerminalArchiveBackfill(sessionId) {
        order.push(`backfill:${sessionId}`);
      },
      async readSession(sessionId) {
        order.push(`read:${sessionId}`);
        return row;
      },
      async reconcile(current) {
        order.push(`reconcile:${current.id}`);
      },
    }),
  ).reconcileById(row.id, 100_000);

  assert.deepEqual(order, [
    `credentials:${row.id}`,
    `legacy:${row.id}`,
    `backfill:${row.id}`,
    `read:${row.id}`,
    `reconcile:${row.id}`,
  ]);
});

test("reconciliation cadence requires terminal work or a configured active adapter", () => {
  const active = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    last_reconciled_at: 80_000,
  });
  assert.equal(
    interactiveSessionReconciliationDue(active, 100_000, {
      adapterName: "runtime-adapter",
      providerConfigured: true,
      intervalMs: 15_000,
    }),
    true,
  );
  assert.equal(
    interactiveSessionReconciliationDue(active, 90_000, {
      adapterName: "runtime-adapter",
      providerConfigured: true,
      intervalMs: 15_000,
    }),
    false,
  );
  assert.equal(
    interactiveSessionReconciliationDue(active, 100_000, {
      adapterName: "runtime-adapter",
      providerConfigured: false,
      intervalMs: 15_000,
    }),
    false,
  );
  assert.equal(
    interactiveSessionReconciliationDue(
      sessionRow({ status: "failed", terminal_finalize_pending: 1 }),
      100_000,
      {
        adapterName: "runtime-adapter",
        providerConfigured: false,
        intervalMs: 15_000,
      },
    ),
    true,
  );
});

test("scheduler queries preserve legacy, provider, terminal, and archive-backfill admission", async () => {
  const row = sessionRow({ id: "IS-1", status: "stopping" });
  const queries: string[] = [];
  const env = runtimeEnv((sql, parameters, kind) => {
    queries.push(sql);
    if (/update interactive_sessions/i.test(sql)) {
      assert.equal(kind, "run");
      assert.match(sql, /archive\.events_key IS NULL/i);
      assert.match(sql, /last_reconciled_at = NULL/i);
      assert.ok(parameters.includes("IS-1"));
      return { changes: 1 };
    }
    assert.equal(kind, "all");
    if (/lease_id IS NULL OR lease_id NOT LIKE/i.test(sql)) {
      assert.match(sql, /"status" =/i);
      assert.match(sql, /"runtime" !=/i);
      assert.ok(parameters.includes("runtime-adapter"));
      assert.ok(parameters.includes("sandbox:%"));
      return { results: [row] };
    }
    if (/"terminal_finalize_pending" =/i.test(sql) && /"adapter" =/i.test(sql)) {
      assert.match(sql, /order by "last_reconciled_at" asc/i);
      assert.ok(parameters.includes("runtime-adapter"));
      return { results: [row] };
    }
    if (/from "interactive_sessions"/i.test(sql) && /"id" =/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-1"]);
      return { results: [row] };
    }
    throw new Error(`unexpected query: ${sql}`);
  }, true);

  assert.equal(
    (
      await readLegacyStoppingInteractiveSessionCandidates(env, {
        adapterName: "runtime-adapter",
        sandboxLeasePrefix: "sandbox:",
        limit: 3,
        sessionId: "IS-1",
      })
    )[0]?.id,
    "IS-1",
  );
  assert.equal(
    (await readInteractiveSessionReconciliationCandidates(env, "runtime-adapter", true, 3))[0]?.id,
    "IS-1",
  );
  assert.equal((await readInteractiveSessionReconciliationRow(env, "IS-1"))?.id, "IS-1");
  await requeueTerminalArchiveObjectBackfill(env, "IS-1", 3);
  assert.equal(queries.length, 4);
});
