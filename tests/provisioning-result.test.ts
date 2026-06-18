import assert from "node:assert/strict";
import test from "node:test";

import { failedProvision, safeProviderError } from "../src/worker/provisioning/result.ts";

test("provisioning failures share one terminal result shape", () => {
  assert.deepEqual(failedProvision("provider unavailable"), {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message: "provider unavailable",
  });
});

test("provider errors are bounded and redact credentials, connections, and identities", () => {
  const workspaceId = "workspace-private";
  const connection = "wss://terminal.example/private";
  const message = safeProviderError(
    new Error(`token=secret workspace=${workspaceId} terminal=${connection}`),
    [workspaceId],
    [connection],
  );
  assert.equal(message, "[credential] workspace=[workspace] terminal=[connection]");
  assert.equal(safeProviderError("x".repeat(2500)).length, 500);
});
