import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialPolicyProvisioningStaleMs,
  credentialPolicyScanOwnershipFence,
  credentialPolicyScanRequiresCleanup,
  type CredentialPolicyScanRow,
} from "../src/worker/sandbox-credential-policy-scanner.ts";

const now = 2_000_000;

function scanRow(values: Partial<CredentialPolicyScanRow> = {}): CredentialPolicyScanRow {
  return {
    scan_rowid: 1,
    session_id: "IS-42",
    sandbox_id: "sandbox-1",
    lookup_id: "sandbox-1",
    policy_state: "active",
    registration_generation: "generation-1",
    registration_claim: null,
    registration_claim_expires_at: null,
    policy_updated_at: now,
    matched_session_id: "IS-42",
    session_adapter: null,
    session_status: "ready",
    session_lease_id: "sandbox:sandbox-1:terminal-1:autostart-v4",
    credential_cleanup_terminal_status: null,
    session_sandbox_refresh_sandbox_id: null,
    session_sandbox_refresh_claim: null,
    session_sandbox_refresh_claim_expires_at: null,
    session_agent_token_hash: "agent-token",
    session_updated_at: now,
    matched_standalone_id: null,
    standalone_state: null,
    standalone_claim: null,
    standalone_claim_expires_at: null,
    standalone_updated_at: null,
    ...values,
  };
}

test("credential-policy scan derives exact standalone and managed ownership fences", () => {
  assert.deepEqual(
    credentialPolicyScanOwnershipFence(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim: "standalone-claim",
        standalone_claim_expires_at: now + 1,
      }),
      now,
    ),
    {
      claim: "standalone-claim",
      provisionId: "IS-42",
      sandboxId: "sandbox-1",
    },
  );

  assert.deepEqual(credentialPolicyScanOwnershipFence(scanRow(), now), {
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  });

  const refreshLeaseId =
    "sandbox:sandbox-old:terminal-old:autostart-v4:refreshing-1900000-deadbeef";
  assert.deepEqual(
    credentialPolicyScanOwnershipFence(
      scanRow({
        session_lease_id: refreshLeaseId,
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now + 1,
      }),
      now,
    ),
    {
      claim: "refresh-claim",
      expiresAt: now + 1,
      refreshLeaseId,
      sandboxId: "sandbox-1",
    },
  );
});

test("credential-policy scan rejects incomplete, expired, and mismatched ownership", () => {
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim: "standalone-claim",
        standalone_claim_expires_at: now,
      }),
      now,
    ),
    null,
  );
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({
        session_lease_id: "sandbox:sandbox-old:terminal-old:autostart-v4",
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now,
      }),
      now,
    ),
    null,
  );
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({ matched_session_id: null, session_lease_id: null }),
      now,
    ),
    null,
  );
});

test("credential-policy scan preserves live standalone and managed policies", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "active",
      }),
      now,
    ),
    false,
  );
  assert.equal(credentialPolicyScanRequiresCleanup(scanRow(), now), false);
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_lease_id: "sandbox:sandbox-old:terminal-old:autostart-v4",
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now + 1,
      }),
      now,
    ),
    false,
  );
});

test("credential-policy scan cleans terminal, orphaned, adapter, and expired owners", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim_expires_at: now,
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({ matched_session_id: null, session_lease_id: null }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(scanRow({ session_adapter: "runtime-v1" }), now),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({ credential_cleanup_terminal_status: "stopped" }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(scanRow({ session_status: "failed" }), now),
    true,
  );
});

test("credential-policy scan cleans abandoned and stale registrations", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        policy_state: "registering",
        registration_claim: null,
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_status: "provisioning",
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
        policy_updated_at: now - credentialPolicyProvisioningStaleMs,
        session_updated_at: now - credentialPolicyProvisioningStaleMs,
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_status: "provisioning",
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
        policy_updated_at: now - credentialPolicyProvisioningStaleMs + 1,
        session_updated_at: now - credentialPolicyProvisioningStaleMs,
      }),
      now,
    ),
    false,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
      }),
      now,
    ),
    true,
  );
});
