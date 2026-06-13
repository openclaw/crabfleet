import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialPolicyCleanupMatches,
  credentialPolicyMigrationCleanupMatches,
  credentialPolicyRegistrationAccepted,
  credentialPolicySandboxIsExpected,
  migratedCredentialPolicyRecord,
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

test("legacy policy migration resumes idempotently after a crash", () => {
  const legacy: Policy = { sessionId: "IS-101", value: "legacy-secret" };
  const promoted = migratedCredentialPolicyRecord(
    registration("legacy:IS-101:sandbox", "legacy-claim", 200),
    undefined,
    undefined,
    {
      generation: "generation-repaired",
      registrationClaim: "legacy-repair:first",
      registrationExpiresAt: 300,
      sessionId: "IS-101",
    },
    100,
  );
  assert.equal(promoted?.generation, "generation-repaired");
  assert.equal(
    migratedCredentialPolicyRecord(
      registration("legacy:IS-101:sandbox", "legacy-newer", 400),
      undefined,
      undefined,
      {
        generation: "generation-repaired",
        registrationClaim: "legacy-repair:stale",
        registrationExpiresAt: 300,
        sessionId: "IS-101",
      },
      100,
    ),
    undefined,
  );
  const first = migratedCredentialPolicyRecord(
    undefined,
    legacy,
    undefined,
    {
      generation: "generation-repaired",
      registrationClaim: "legacy-repair:first",
      registrationExpiresAt: 300,
      sessionId: "IS-101",
    },
    100,
  );
  assert.deepEqual(first, {
    generation: "generation-repaired",
    registrationClaim: "legacy-repair:first",
    registrationExpiresAt: 300,
    policy: legacy,
  });

  const retry = migratedCredentialPolicyRecord(
    first,
    undefined,
    undefined,
    {
      generation: "generation-repaired",
      registrationClaim: "legacy-repair:retry",
      registrationExpiresAt: 400,
      sessionId: "IS-101",
    },
    301,
  );
  assert.equal(retry?.registrationClaim, "legacy-repair:retry");
  assert.equal(retry?.policy, legacy);
  assert.equal(
    migratedCredentialPolicyRecord(
      retry,
      undefined,
      undefined,
      {
        generation: "generation-repaired",
        registrationClaim: "legacy-repair:first",
        registrationExpiresAt: 300,
        sessionId: "IS-101",
      },
      200,
    ),
    undefined,
  );
});

test("legacy migration honors identity, tombstones, and raced cleanup", () => {
  const legacy: Policy = { sessionId: "IS-101", value: "legacy-secret" };
  const migration = {
    generation: "generation-repaired",
    registrationClaim: "legacy-repair:claim",
    registrationExpiresAt: 300,
    sessionId: "IS-101",
  };
  assert.equal(
    migratedCredentialPolicyRecord(
      undefined,
      { ...legacy, sessionId: "IS-102" },
      undefined,
      migration,
      100,
    ),
    undefined,
  );
  assert.equal(
    migratedCredentialPolicyRecord(
      undefined,
      legacy,
      {
        generation: migration.generation,
        sessionId: migration.sessionId,
        tombstonedAt: 99,
      },
      migration,
      100,
    ),
    undefined,
  );
  assert.equal(
    credentialPolicyMigrationCleanupMatches(
      registration("legacy:IS-101:sandbox", "old-claim", 200),
      migration.generation,
      migration.sessionId,
    ),
    true,
  );
  assert.equal(
    credentialPolicyMigrationCleanupMatches(
      registration("generation-other", "other-claim", 200),
      migration.generation,
      migration.sessionId,
    ),
    false,
  );
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
