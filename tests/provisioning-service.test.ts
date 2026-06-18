import assert from "node:assert/strict";
import test from "node:test";

import { InteractiveProvisioningService } from "../src/worker/provisioning/service.ts";
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
  SandboxProvisionOwnership,
} from "../src/worker/provisioning/types.ts";

const session: InteractiveProvisionRequest = {
  id: "session-1",
  parentSessionId: null,
  rootSessionId: "session-1",
  repo: "openclaw/openclaw",
  branch: "main",
  runtime: "container",
  profile: "default",
  command: "pnpm test",
  prompt: "",
  purpose: "test",
  summary: "test",
  owner: "operator",
  createdBy: "operator",
};

const sandbox: SandboxProvisionOwnership = {
  lease: {
    sandboxId: "sandbox-1",
    terminalSessionId: "terminal-1",
  },
  ownership: {
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  },
};

function result(message: string): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message,
  };
}

test("managed container provisioning prefers built-in Sandbox", async () => {
  const calls: string[] = [];
  const service = new InteractiveProvisioningService({
    sandboxAvailable: true,
    runtimeAdapterAvailable: true,
    provisionSandbox: async (request, agentToken, ownership) => {
      calls.push(`sandbox:${request.id}:${agentToken}:${ownership.lease.sandboxId}`);
      return result("sandbox");
    },
    provisionRuntimeAdapter: async () => {
      calls.push("runtime-adapter");
      return result("runtime-adapter");
    },
  });

  assert.equal(
    (await service.provisionManaged(session, "agent-token", sandbox))?.message,
    "sandbox",
  );
  assert.deepEqual(calls, ["sandbox:session-1:agent-token:sandbox-1"]);
});

test("managed Crabbox and container fallback use the versioned runtime adapter", async () => {
  const calls: string[] = [];
  const service = new InteractiveProvisioningService({
    sandboxAvailable: false,
    runtimeAdapterAvailable: true,
    provisionSandbox: async () => {
      calls.push("sandbox");
      return result("sandbox");
    },
    provisionRuntimeAdapter: async (request, agentToken) => {
      calls.push(`${request.runtime}:${agentToken}`);
      return result("runtime-adapter");
    },
  });

  assert.equal(
    (await service.provisionManaged({ ...session, runtime: "crabbox" }, "crabbox-token"))?.message,
    "runtime-adapter",
  );
  assert.equal(
    (await service.provisionManaged(session, "container-token"))?.message,
    "runtime-adapter",
  );
  assert.deepEqual(calls, ["crabbox:crabbox-token", "container:container-token"]);
});

test("managed Sandbox provisioning requires durable ownership", async () => {
  const service = new InteractiveProvisioningService({
    sandboxAvailable: true,
    runtimeAdapterAvailable: true,
    provisionSandbox: async () => result("sandbox"),
    provisionRuntimeAdapter: async () => result("runtime-adapter"),
  });

  assert.deepEqual(await service.provisionManaged(session), {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message: "Cloudflare Sandbox durable ownership is missing",
  });
});

test("managed provisioning returns null when no provider supports the runtime", async () => {
  const service = new InteractiveProvisioningService({
    sandboxAvailable: true,
    runtimeAdapterAvailable: false,
    provisionSandbox: async () => result("sandbox"),
    provisionRuntimeAdapter: async () => result("runtime-adapter"),
  });

  assert.equal(await service.provisionManaged({ ...session, runtime: "crabbox" }), null);
});

test("standalone provisioning is built-in Sandbox only", () => {
  const available = new InteractiveProvisioningService({
    sandboxAvailable: true,
    runtimeAdapterAvailable: true,
    provisionSandbox: async () => result("sandbox"),
    provisionRuntimeAdapter: async () => result("runtime-adapter"),
  });
  const unavailable = new InteractiveProvisioningService({
    sandboxAvailable: false,
    runtimeAdapterAvailable: true,
    provisionSandbox: async () => result("sandbox"),
    provisionRuntimeAdapter: async () => result("runtime-adapter"),
  });

  assert.equal(available.supportsStandalone("container"), true);
  assert.equal(available.supportsStandalone("crabbox"), false);
  assert.equal(unavailable.supportsStandalone("container"), false);
});
