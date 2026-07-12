import assert from "node:assert/strict";
import test from "node:test";

import { containerCapabilities } from "../src/worker/session-model.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  RuntimeAdapterWorkspaceLifecycle,
  type RuntimeAdapterWorkspaceLifecycleDependencies,
} from "../src/worker/runtime-adapter-workspaces.ts";
import type { InteractiveProvisionResult } from "../src/worker/provisioning/types.ts";
import { sessionRow } from "./helpers/session-row.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (sql: string, parameters: unknown[], kind: "all" | "run") => unknown[] = () => [],
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
    CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example.test",
    CRABBOX_RUNTIME_ADAPTER_TOKEN: "adapter-token",
  } as RuntimeEnv;
}

function provisionResult(
  values: Partial<InteractiveProvisionResult> = {},
): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: null,
    attachUrl: "wss://adapter.example.test/terminal/workspace-1",
    vncUrl: null,
    message: "runtime adapter workspace ready",
    adapter: "runtime-v1",
    profile: "default",
    adapterWorkspaceId: "workspace-1",
    providerResourceId: "provider-1",
    reconciledAt: 200,
    reconcileError: null,
    createPending: false,
    ...values,
  };
}

function dependencies(
  overrides: Partial<RuntimeAdapterWorkspaceLifecycleDependencies> = {},
): RuntimeAdapterWorkspaceLifecycleDependencies {
  return {
    now: () => 200,
    async fetch() {
      return Response.json({
        id: "workspace-1",
        providerResourceId: "provider-1",
        status: "ready",
        profile: "default",
        attachUrl: "wss://adapter.example.test/terminal/workspace-1",
        capabilities: containerCapabilities,
        message: "ready",
      });
    },
    async readResponseBody(response) {
      return response.status === 204 ? null : response.json();
    },
    async provisionReplay() {
      return provisionResult({ status: "provisioning", message: "create replayed" });
    },
    async releaseFailed(_sessionId, result) {
      return result;
    },
    async failWorkspaceIdConflict() {
      return provisionResult({ status: "failed", message: "workspace id conflict" });
    },
    async recordConfirmedRelease() {},
    async archive() {},
    ...overrides,
  };
}

function runtimeAdapterSession(
  values: Parameters<typeof sessionRow>[0] = {},
): ReturnType<typeof sessionRow> {
  return sessionRow({
    runtime: "container",
    adapter: "runtime-v1",
    profile: "default",
    adapter_workspace_id: "workspace-1",
    adapter_control_plane: "https://adapter.example.test/",
    provider_resource_id: "provider-1",
    capabilities_json: JSON.stringify(containerCapabilities),
    ...values,
  });
}

test("native VNC grants use the registered adapter and reject malformed credentials", async () => {
  const calls: Array<{ input: string; init: RequestInit }> = [];
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      now: () => 1_000,
      async fetch(input, init) {
        calls.push({ input, init });
        return Response.json({
          schema: "crabbox/native-vnc-grant/v1",
          brokerUrl: "https://crabbox.example.test",
          leaseId: "cbx_native123",
          ticket: "native_vnc_0123456789abcdef0123456789abcdef",
          expiresAt: new Date(61_000).toISOString(),
        });
      },
    }),
  );

  await assert.doesNotReject(
    service.createNativeVNCGrant("default", "https://adapter.example.test/", "workspace-1"),
  );
  assert.deepEqual(calls, [
    {
      input: "https://adapter.example.test/v1/workspaces/workspace-1/connections/native-vnc",
      init: { method: "POST" },
    },
  ]);

  const malformed = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      now: () => 1_000,
      async fetch() {
        return Response.json({ ticket: "secret" });
      },
    }),
  );
  await assert.rejects(
    malformed.createNativeVNCGrant("default", "https://adapter.example.test/", "workspace-1"),
    /invalid native VNC grant/u,
  );
});

test("workspace inspection uses the registered control plane and bounded response parser", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  let parsedResponses = 0;
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      async fetch(input, init) {
        requests.push({ url: input, method: init.method });
        return Response.json({
          id: "workspace-1",
          providerResourceId: "provider-1",
          status: "ready",
          profile: "default",
          attachUrl: "wss://adapter.example.test/terminal/workspace-1",
          capabilities: containerCapabilities,
          message: "ready",
        });
      },
      async readResponseBody(response) {
        parsedResponses += 1;
        return response.json();
      },
    }),
  );

  const result = await service.inspect(runtimeAdapterSession(), 150);

  assert.deepEqual(requests, [
    {
      url: "https://adapter.example.test/v1/workspaces/workspace-1",
      method: "GET",
    },
  ]);
  assert.equal(parsedResponses, 1);
  assert.equal(result.status, "ready");
  assert.equal(result.adapterWorkspaceId, "workspace-1");
  assert.equal(result.providerResourceId, "provider-1");
});

test("workspace inspection rejects a changed control plane before transport", async () => {
  let fetches = 0;
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      async fetch() {
        fetches += 1;
        return Response.json({});
      },
    }),
  );

  await assert.rejects(
    service.inspect(
      runtimeAdapterSession({
        adapter_control_plane: "https://different.example.test/",
      }),
      150,
    ),
    { message: "runtime adapter control plane differs from workspace registration" },
  );
  assert.equal(fetches, 0);
});

test("pending creates replay before workspace inspection", async () => {
  let fetches = 0;
  let replayOwner: unknown = null;
  const replayed = provisionResult({ status: "provisioning", message: "create replayed" });
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      async fetch() {
        fetches += 1;
        return Response.json({});
      },
      async provisionReplay(_session, owner) {
        replayOwner = owner;
        return replayed;
      },
    }),
  );

  const result = await service.inspect(
    runtimeAdapterSession({
      status: "provisioning",
      adapter_create_pending: 1,
      updated_at: 120,
      last_reconciled_at: 150,
    }),
    150,
  );

  assert.equal(result, replayed);
  assert.equal(fetches, 0);
  assert.deepEqual(replayOwner, {
    status: "provisioning",
    updatedAt: 120,
    lastReconciledAt: 150,
    terminalStatus: null,
  });
});

test("stopping sessions do not DELETE while persisted create replay is incomplete", async () => {
  let fetches = 0;
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(),
    dependencies({
      async fetch() {
        fetches += 1;
        return Response.json({});
      },
    }),
  );

  const result = await service.inspect(
    runtimeAdapterSession({
      status: "stopping",
      adapter_create_pending: 1,
      adapter_requested_capabilities_json: null,
      adapter_create_payload_json: null,
    }),
    150,
  );

  assert.equal(result.status, "stopping");
  assert.equal(result.createPending, true);
  assert.match(result.message, /persisted lifecycle is incomplete/);
  assert.equal(fetches, 0);
});

test("session-bound stop waits for create resolution before DELETE", async () => {
  let fetches = 0;
  const env = runtimeEnv(() => [
    {
      adapter_control_plane: "https://adapter.example.test/",
      adapter_create_pending: 1,
      profile: "default",
    },
  ]);
  const service = new RuntimeAdapterWorkspaceLifecycle(
    env,
    dependencies({
      async fetch() {
        fetches += 1;
        return new Response(null, { status: 204 });
      },
    }),
  );

  const result = await service.stopForSession("IS-42", "workspace-1");

  assert.deepEqual(result, {
    status: "stopping",
    message: "runtime adapter stop waiting for create resolution",
  });
  assert.equal(fetches, 0);
});

test("session-bound stop parses DELETE evidence and preserves the registered path", async () => {
  const requests: Array<{ url: string; method: string | undefined }> = [];
  let parsedResponses = 0;
  const env = runtimeEnv(() => [
    {
      adapter_control_plane: "https://adapter.example.test/",
      adapter_create_pending: 0,
      profile: "default",
    },
  ]);
  const service = new RuntimeAdapterWorkspaceLifecycle(
    env,
    dependencies({
      async fetch(input, init) {
        requests.push({ url: input, method: init.method });
        return Response.json({
          id: "workspace-1",
          status: "stopped",
          message: "provider confirmed release",
        });
      },
      async readResponseBody(response) {
        parsedResponses += 1;
        return response.json();
      },
    }),
  );

  const result = await service.stopForSession("IS-42", "workspace-1");

  assert.deepEqual(requests, [
    {
      url: "https://adapter.example.test/v1/workspaces/workspace-1",
      method: "DELETE",
    },
  ]);
  assert.equal(parsedResponses, 1);
  assert.deepEqual(result, {
    status: "stopped",
    message: "provider confirmed release",
  });
});

test("superseded stop uses retained registration after the session row moves on", async () => {
  let databaseReads = 0;
  const requests: Array<{ url: string; method: string | undefined }> = [];
  const service = new RuntimeAdapterWorkspaceLifecycle(
    runtimeEnv(() => {
      databaseReads += 1;
      return [];
    }),
    dependencies({
      async fetch(input, init) {
        requests.push({ url: input, method: init.method });
        return new Response(null, { status: 204 });
      },
    }),
  );

  const result = await service.stopForSession(
    "IS-42",
    "workspace-superseded",
    {
      profile: "default",
      controlPlane: "https://adapter.example.test/",
    },
    false,
  );

  assert.equal(databaseReads, 0);
  assert.deepEqual(requests, [
    {
      url: "https://adapter.example.test/v1/workspaces/workspace-superseded",
      method: "DELETE",
    },
  ]);
  assert.deepEqual(result, {
    status: "stopped",
    message: "runtime adapter workspace released",
  });
});

test("session-bound stop redacts provider credentials from failures", async () => {
  const env = runtimeEnv(() => [
    {
      adapter_control_plane: "https://adapter.example.test/",
      adapter_create_pending: 0,
      profile: "default",
    },
  ]);
  const service = new RuntimeAdapterWorkspaceLifecycle(
    env,
    dependencies({
      async fetch() {
        return Response.json(
          { detail: "capacity unavailable; token=private-value" },
          { status: 503 },
        );
      },
    }),
  );

  await assert.rejects(service.stopForSession("IS-42", "workspace-1"), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "capacity unavailable; [credential]");
    assert.doesNotMatch(error.message, /private-value/);
    return true;
  });
});
