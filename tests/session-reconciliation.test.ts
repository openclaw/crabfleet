import assert from "node:assert/strict";
import test from "node:test";

import { clearedAdapterCapabilities } from "../src/runtime-adapter.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { containerCapabilities } from "../src/worker/session-model.ts";
import {
  claimInteractiveSessionReconciliation,
  InteractiveSessionReconciliationService,
  persistInteractiveSessionReconciliation,
  reconciledInteractiveStatus,
  recordInteractiveSessionReconciliationFailure,
  runtimeAdapterReconciliationTransition,
  type InteractiveSessionReconciliationStore,
} from "../src/worker/session-reconciliation.ts";
import type { InteractiveProvisionResult } from "../src/worker/session-provisioning.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };
type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result,
  batchHandler: (statements: PreparedStatement[]) => D1Result[] = () => [],
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
      async batch(statements: unknown[]) {
        return batchHandler(statements as PreparedStatement[]);
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

function inspection(values: Partial<InteractiveProvisionResult> = {}): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message: "runtime adapter workspace ready",
    adapter: "runtime-adapter",
    profile: "default",
    adapterWorkspaceId: "workspace-1",
    reconciledAt: 200,
    reconcileError: null,
    ...values,
  };
}

function reconciliationStore(
  overrides: Partial<InteractiveSessionReconciliationStore> = {},
): InteractiveSessionReconciliationStore {
  return {
    now: () => 200,
    async claim() {
      return true;
    },
    async inspect() {
      return inspection();
    },
    async persist() {
      return true;
    },
    async readSession() {
      return null;
    },
    async stopSuperseded() {},
    async archive() {},
    async finalize() {},
    async recordFailure() {},
    ...overrides,
  };
}

test("reconciliation status policy preserves stopping and attached lifecycle ownership", () => {
  assert.equal(reconciledInteractiveStatus("stopping", "ready", null), "stopping");
  assert.equal(reconciledInteractiveStatus("stopping", "stopped", "failed"), "failed");
  assert.equal(reconciledInteractiveStatus("attached", "ready", null), "attached");
  assert.equal(reconciledInteractiveStatus("detached", "ready", null), "detached");
  assert.equal(reconciledInteractiveStatus("provisioning", "ready", null), "ready");
});

test("reconciliation transition preserves omitted fields and clears inactive authority", () => {
  const row = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
    provider_resource_id: "provider-1",
    attach_url: "wss://terminal.example.test",
    capabilities_json: JSON.stringify(containerCapabilities),
    expires_at: 500,
    reconcile_error: null,
    adapter_create_pending: 0,
    last_event: "runtime adapter workspace ready",
    updated_at: 100,
  });
  const unchanged = runtimeAdapterReconciliationTransition(row, inspection(), 200);
  assert.equal(unchanged.attachUrl, row.attach_url);
  assert.equal(unchanged.capabilitiesJson, row.capabilities_json);
  assert.equal(unchanged.expiresAt, 500);
  assert.equal(unchanged.providerResourceId, "provider-1");
  assert.equal(unchanged.evidenceChanged, false);

  const terminal = runtimeAdapterReconciliationTransition(
    row,
    inspection({
      status: "expired",
      attachUrlPresent: true,
      capabilitiesPresent: true,
      expiresAtPresent: true,
      createPending: false,
      message: "runtime adapter workspace is gone",
    }),
    220,
  );
  assert.equal(terminal.status, "expired");
  assert.equal(terminal.attachUrl, null);
  assert.equal(terminal.capabilitiesJson, JSON.stringify(clearedAdapterCapabilities));
  assert.equal(terminal.expiresAt, null);
  assert.equal(terminal.terminalStatus, null);
  assert.equal(terminal.inactive, true);
  assert.equal(terminal.stoppedAt, 220);
  assert.equal(terminal.completionVersion, 220);
  assert.equal(terminal.evidenceChanged, true);
});

test("reconciliation persistence claims exact revisions and atomically records changed evidence", async () => {
  const row = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
    last_reconciled_at: 150,
    updated_at: 100,
  });
  const claimEnv = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "run");
    assert.match(sql, /update "interactive_sessions"/i);
    assert.match(sql, /"last_reconciled_at" =/i);
    assert.deepEqual(parameters, [200, row.id, "ready", 100, 150]);
    return { changes: 1 };
  });
  assert.equal(await claimInteractiveSessionReconciliation(claimEnv, row, 200), true);

  const inspected = inspection({
    status: "expired",
    message: `  ${"x".repeat(1100)}  `,
    attachUrlPresent: true,
    capabilitiesPresent: true,
    expiresAtPresent: true,
  });
  const transition = runtimeAdapterReconciliationTransition(row, inspected, 220);
  let batch: PreparedStatement[] = [];
  const persistEnv = runtimeEnv(
    () => {
      throw new Error("batch statements should not execute individually");
    },
    (statements) => {
      batch = statements;
      return [{ results: [] }, { results: [{ updated_at: 220 }] }];
    },
  );
  assert.equal(
    await persistInteractiveSessionReconciliation(
      persistEnv,
      row,
      inspected,
      transition,
      200,
      "runtime-adapter",
    ),
    true,
  );
  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /insert into interactive_session_events/i);
  assert.match(batch[1]?.sql ?? "", /update "interactive_sessions"/i);
  assert.ok(batch[0]?.parameters.includes("x".repeat(1000)));
  assert.ok(batch[1]?.parameters.includes(1));
  assert.ok(batch[1]?.parameters.includes(220));
  assert.ok(batch[1]?.parameters.includes("runtime-adapter"));
});

test("reconciliation failure persistence retains status, revision, and claim fences", async () => {
  const row = sessionRow({ status: "attached", updated_at: 100 });
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "run");
    assert.match(sql, /update "interactive_sessions"/i);
    assert.match(sql, /"reconcile_error" =/i);
    assert.deepEqual(parameters, [220, "provider unavailable", 220, row.id, "attached", 100, 200]);
    return { changes: 1 };
  });

  await recordInteractiveSessionReconciliationFailure(env, row, 200, 220, "provider unavailable");
});

test("reconciliation claims before inspection, persists evidence, archives, and finalizes", async () => {
  const row = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
    updated_at: 100,
  });
  const order: string[] = [];
  const service = new InteractiveSessionReconciliationService(
    reconciliationStore({
      async claim(_row, claimAt) {
        order.push(`claim:${claimAt}`);
        return true;
      },
      async inspect(_row, claimAt) {
        order.push(`inspect:${claimAt}`);
        return inspection({ status: "expired", message: "workspace expired" });
      },
      async persist(_row, _inspection, transition, claimAt) {
        order.push(`persist:${claimAt}:${transition.status}`);
        return true;
      },
      async archive(_sessionId, now) {
        order.push(`archive:${now}`);
      },
      async finalize(_sessionId, status, now) {
        order.push(`finalize:${status}:${now}`);
      },
    }),
    "runtime-adapter",
  );

  await service.reconcile(row, 150);
  assert.deepEqual(order, [
    "claim:200",
    "inspect:200",
    "persist:200:expired",
    "archive:200",
    "finalize:expired:200",
  ]);
});

test("terminal reconciliation finalizes before provider inspection", async () => {
  const row = sessionRow({
    status: "failed",
    terminal_finalize_pending: 1,
    stopped_at: 175,
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
  });
  const order: string[] = [];
  const service = new InteractiveSessionReconciliationService(
    reconciliationStore({
      async claim() {
        order.push("claim");
        return true;
      },
      async inspect() {
        order.push("inspect");
        return inspection();
      },
      async finalize(_sessionId, status, now) {
        order.push(`finalize:${status}:${now}`);
      },
    }),
    "runtime-adapter",
  );

  await service.reconcile(row, 150);
  assert.deepEqual(order, ["claim", "finalize:failed:175"]);
});

test("lost reconciliation ownership finalizes terminal rereads or releases superseded workspaces", async () => {
  const row = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
  });
  const finalized: string[] = [];
  const terminalService = new InteractiveSessionReconciliationService(
    reconciliationStore({
      async persist() {
        return false;
      },
      async readSession() {
        return interactiveSession(
          sessionRow({ id: row.id, status: "stopped", stopped_at: 180 }),
          [],
        );
      },
      async finalize(_sessionId, status, now) {
        finalized.push(`${status}:${now}`);
      },
    }),
    "runtime-adapter",
  );
  await terminalService.reconcile(row, 150);
  assert.deepEqual(finalized, ["stopped:180"]);

  const released: string[] = [];
  const supersededService = new InteractiveSessionReconciliationService(
    reconciliationStore({
      async persist() {
        return false;
      },
      async readSession() {
        return interactiveSession(
          sessionRow({
            id: row.id,
            status: "ready",
            adapter: "runtime-adapter",
            adapter_workspace_id: "workspace-2",
          }),
          [],
        );
      },
      async stopSuperseded(sessionId, workspaceId, createPending, now) {
        released.push(`${sessionId}:${workspaceId}:${createPending}:${now}`);
      },
    }),
    "runtime-adapter",
  );
  await supersededService.reconcile(row, 150);
  assert.deepEqual(released, [`${row.id}:workspace-1:false:200`]);
});

test("reconciliation failures retain the claimed lifecycle fence", async () => {
  const row = sessionRow({
    status: "ready",
    adapter: "runtime-adapter",
    adapter_workspace_id: "workspace-1",
    last_reconciled_at: 190,
  });
  const failures: Array<{ claimAt: number; failedAt: number; message: string }> = [];
  const service = new InteractiveSessionReconciliationService(
    reconciliationStore({
      now: () => 200,
      async inspect() {
        throw new Error("provider unavailable");
      },
      async recordFailure(_row, claimAt, failedAt, error) {
        failures.push({
          claimAt,
          failedAt,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    }),
    "runtime-adapter",
  );

  await service.reconcile(row, 150);
  assert.deepEqual(failures, [{ claimAt: 200, failedAt: 200, message: "provider unavailable" }]);
});
