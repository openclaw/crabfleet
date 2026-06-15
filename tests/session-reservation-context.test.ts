import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { sandboxLeaseId } from "../src/worker/sandbox-lease.ts";
import type { ResolvedInteractiveSessionCreateRequest } from "../src/worker/session-create-request.ts";
import { createInteractiveSessionReservationContext } from "../src/worker/session-reservation-context.ts";
import { containerCapabilities, crabboxCapabilities } from "../src/worker/session-model.ts";

function request(
  values: Partial<ResolvedInteractiveSessionCreateRequest> = {},
): ResolvedInteractiveSessionCreateRequest {
  return {
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "container",
    profile: "default",
    requestedCapabilities: containerCapabilities,
    command: "codex --yolo",
    prompt: "fix the issue",
    purpose: "fix the issue",
    summary: "starting",
    owner: "maintainer",
    createdBy: "service:openclaw",
    ...values,
  };
}

test("reservation contexts bind agent tokens to initial sandbox ownership", async () => {
  const context = await createInteractiveSessionReservationContext(
    { SANDBOX: {} as DurableObjectNamespace } as RuntimeEnv,
    request(),
    { id: "IS-2", parentSessionId: "IS-1", rootSessionId: "IS-1" },
  );

  assert.equal(context.initialAgentTokenHash, await sha256(context.agentToken));
  assert.ok(context.initialSandboxLease);
  assert.deepEqual(context.initialSandboxOwnership, {
    leaseId: sandboxLeaseId(context.initialSandboxLease),
    sandboxId: context.initialSandboxLease.sandboxId,
  });
  assert.equal(context.adapterWorkspaceId, null);
  assert.equal(context.adapterControlPlane, null);
  assert.equal(context.adapterSettings, null);
  assert.equal(context.adapterCreatePayloadJson, null);
});

test("reservation contexts persist exact runtime-adapter creation identity", async () => {
  const context = await createInteractiveSessionReservationContext(
    {
      CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example.test",
      CRABBOX_RUNTIME_ADAPTER_TOKEN: "server-secret",
      CRABBOX_RUNTIME_ADAPTER_NAMESPACE: "fleet",
      CRABBOX_RUNTIME_ADAPTER_TTL_SECONDS: "60",
      CRABBOX_RUNTIME_ADAPTER_IDLE_SECONDS: "999999",
    } as RuntimeEnv,
    request({
      runtime: "crabbox",
      requestedCapabilities: crabboxCapabilities,
    }),
    { id: "IS-2", parentSessionId: "IS-1", rootSessionId: "IS-1" },
  );

  assert.equal(context.initialSandboxLease, null);
  assert.equal(context.initialSandboxOwnership, null);
  assert.equal(context.adapterWorkspaceId, "fleet-is-2");
  assert.equal(context.adapterControlPlane, "https://adapter.example.test/");
  assert.deepEqual(context.adapterSettings, {
    ttlSeconds: 300,
    idleTimeoutSeconds: 86_400,
    capabilities: crabboxCapabilities,
  });
  const payload = JSON.parse(context.adapterCreatePayloadJson ?? "{}") as Record<string, unknown>;
  assert.equal(payload.id, "fleet-is-2");
  assert.equal(payload.parentSessionId, "IS-1");
  assert.equal(payload.rootSessionId, "IS-1");
  assert.equal(payload.profile, "default");
  assert.equal(payload.owner, "maintainer");
  assert.equal(payload.createdBy, "service:openclaw");
  assert.equal("token" in payload, false);
});

test("reservation contexts reject invalid runtime-adapter namespaces", async () => {
  await assert.rejects(
    createInteractiveSessionReservationContext(
      {
        CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example.test",
        CRABBOX_RUNTIME_ADAPTER_TOKEN: "server-secret",
        CRABBOX_RUNTIME_ADAPTER_NAMESPACE: "INVALID_NAMESPACE",
      } as RuntimeEnv,
      request({ runtime: "crabbox", requestedCapabilities: crabboxCapabilities }),
      { id: "IS-2", parentSessionId: null, rootSessionId: "IS-2" },
    ),
    /runtime adapter namespace is required/,
  );
});
