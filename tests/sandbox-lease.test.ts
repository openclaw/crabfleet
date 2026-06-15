import assert from "node:assert/strict";
import test from "node:test";

import {
  isCurrentSandboxLease,
  newSandboxLease,
  sandboxIdForSession,
  sandboxLeaseId,
  sandboxLeaseInfo,
  sandboxLeaseRefreshStartedAt,
  sandboxLeaseWithoutRefresh,
} from "../src/worker/sandbox-lease.ts";

test("sandbox leases centralize managed identity and adapter filtering", () => {
  const lease = newSandboxLease("IS-101");
  const leaseId = sandboxLeaseId(lease);

  assert.match(lease.sandboxId, /^crabbox-is-101-[a-f0-9]{8}$/);
  assert.match(lease.terminalSessionId, /^terminal-is-101-[a-f0-9]{8}$/);
  assert.equal(isCurrentSandboxLease(leaseId), true);
  assert.deepEqual(sandboxLeaseInfo({ id: "IS-101", leaseId }), lease);
  assert.deepEqual(sandboxLeaseInfo({ id: "IS-101", leaseId, adapter: "runtime-v1" }), {
    sandboxId: "crabbox-is-101",
    terminalSessionId: "terminal-is-101",
  });
  assert.equal(sandboxIdForSession("IS/101"), "crabbox-is-101");
});

test("sandbox lease refresh markers preserve the terminal lease identity", () => {
  const leaseId = "sandbox:crabbox-is-101:terminal-is-101:autostart-v4:refreshing-1234-deadbeef";
  assert.equal(sandboxLeaseRefreshStartedAt(leaseId), 1234);
  assert.equal(
    sandboxLeaseWithoutRefresh(leaseId),
    "sandbox:crabbox-is-101:terminal-is-101:autostart-v4",
  );
  assert.equal(sandboxLeaseRefreshStartedAt("sandbox:plain"), null);
});
