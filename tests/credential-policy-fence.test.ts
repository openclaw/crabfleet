import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialPolicyCleanupMatches,
  credentialPolicyRollbackExpiresAt,
  credentialPolicyRegistrationAccepted,
  credentialPolicySandboxIsExpected,
  type CredentialPolicyGenerationRecord,
  type CredentialPolicyGenerationTombstone,
} from "../src/credential-policy-fence.ts";

type Policy = { sessionId: string; value: string };

const registration = (
  generation: string,
  claim: string,
  registrationExpiresAt = 200,
): CredentialPolicyGenerationRecord<Policy> => ({
  generation,
  registrationClaim: claim,
  registrationExpiresAt,
  policy: { sessionId: "IS-101", value: claim },
});

test("generation tombstones reject late registration regardless of operation order", () => {
  const incoming = registration("generation-1", "claim-1");
  const tombstone: CredentialPolicyGenerationTombstone = {
    generation: "generation-1",
    sessionId: "IS-101",
    tombstonedAt: 100,
  };

  assert.equal(credentialPolicyRegistrationAccepted(undefined, undefined, incoming, 100), true);
  assert.equal(credentialPolicyCleanupMatches(incoming, "generation-1", "IS-101"), true);
  assert.equal(credentialPolicyRegistrationAccepted(undefined, tombstone, incoming, 100), false);
  assert.equal(
    credentialPolicyRegistrationAccepted(
      undefined,
      { ...tombstone, sessionId: "IS-102" },
      incoming,
      100,
    ),
    false,
  );
});

test("generation fences isolate new policies from stale cleanup", () => {
  const current = registration("generation-2", "claim-2");
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-1"),
      100,
    ),
    false,
  );
  assert.equal(credentialPolicyCleanupMatches(current, "generation-1", "IS-101"), false);
  assert.equal(
    credentialPolicyRegistrationAccepted(
      undefined,
      undefined,
      registration("generation-1", "claim-1"),
      200,
    ),
    false,
  );
});

test("newer generations rotate policy for the same session only", () => {
  const current = registration("generation-1", "claim-current", 300);

  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-2", "claim-replacement", 301),
      100,
    ),
    true,
  );
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      {
        ...registration("generation-2", "claim-replacement", 301),
        policy: { sessionId: "IS-102", value: "claim-replacement" },
      },
      100,
    ),
    false,
  );
});

test("same-generation registration claims advance monotonically", () => {
  const current = registration("generation-1", "claim-current", 300);

  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-current", 299),
      100,
    ),
    false,
  );
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-current", 300),
      100,
    ),
    true,
  );
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-current", 301),
      100,
    ),
    true,
  );
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-replacement", 300),
      100,
    ),
    false,
  );
  assert.equal(
    credentialPolicyRegistrationAccepted(
      current,
      undefined,
      registration("generation-1", "claim-replacement", 301),
      100,
    ),
    true,
  );
});

test("delayed abandoned registration cannot replace a newer claim", () => {
  const newer = registration("generation-1", "claim-new", 400);
  const abandoned = registration("generation-1", "claim-old", 300);

  assert.equal(credentialPolicyRegistrationAccepted(newer, undefined, abandoned, 200), false);
});

test("rollback claims advance beyond the generation they replace", () => {
  assert.equal(credentialPolicyRollbackExpiresAt(500, 100, 200), 501);
  assert.equal(credentialPolicyRollbackExpiresAt(200, 100, 200), 300);
});

test("live lease refresh fences both current and expected sandbox policies", () => {
  assert.equal(
    credentialPolicySandboxIsExpected("sandbox-old", "sandbox-old", null, null, null, 100),
    true,
  );
  assert.equal(
    credentialPolicySandboxIsExpected(
      "sandbox-old",
      "sandbox-new",
      "sandbox-new",
      "refresh-claim",
      200,
      100,
    ),
    true,
  );
  assert.equal(
    credentialPolicySandboxIsExpected(
      "sandbox-old",
      "sandbox-new",
      "sandbox-new",
      "refresh-claim",
      100,
      100,
    ),
    false,
  );
  assert.equal(
    credentialPolicySandboxIsExpected("sandbox-old", "sandbox-new", "sandbox-new", null, 200, 100),
    false,
  );
});
