import assert from "node:assert/strict";
import test from "node:test";

import {
  credentialPolicyLegacyRepairClaimPrefix,
  dedupeSandboxPolicies,
  legacySandboxCredentialPolicy,
  redactSandboxPolicy,
  sandboxCredentialPolicyFromStorage,
  storedSandboxCredentialPolicy,
  validCredentialPolicyTombstone,
  validSandboxCredentialPolicyLegacyMigration,
  validSandboxCredentialPolicyRegistration,
  type SandboxCredentialPolicy,
  type StoredSandboxCredentialPolicy,
} from "../src/worker/session-control-policy.ts";

const policy: SandboxCredentialPolicy = {
  allowedHosts: ["api.github.com", "api.openai.com"],
  githubCredentialSource: "session",
  githubRepo: "openclaw/crabfleet",
  githubRepoNodeId: "R_123",
  githubTokenCiphertext: "encrypted",
  openAIBaseUrl: "https://api.openai.com/v1",
  openAIOrgId: "org-1",
  owner: "operator",
  sandboxId: "sandbox-1",
  sessionId: "IS-42",
};

function registration(
  values: Partial<StoredSandboxCredentialPolicy> = {},
): StoredSandboxCredentialPolicy {
  return {
    generation: "generation-1",
    registrationClaim: "claim-1",
    registrationExpiresAt: Date.now() + 60_000,
    policy,
    ...values,
  };
}

test("session-control policy registration validates bounded generation shape", () => {
  assert.equal(validSandboxCredentialPolicyRegistration(registration()), true);
  assert.equal(validSandboxCredentialPolicyRegistration(registration({ generation: "" })), false);
  assert.equal(
    validSandboxCredentialPolicyRegistration(registration({ registrationExpiresAt: Number.NaN })),
    false,
  );
  assert.equal(
    validSandboxCredentialPolicyRegistration(
      registration({ policy: { ...policy, expiresAt: Date.now() - 1 } }),
    ),
    false,
  );
});

test("session-control storage exposes only current unexpired policy records", () => {
  const current = registration();
  assert.equal(storedSandboxCredentialPolicy(current), current);
  assert.equal(legacySandboxCredentialPolicy(current), undefined);
  assert.equal(sandboxCredentialPolicyFromStorage(current), policy);

  assert.equal(storedSandboxCredentialPolicy(policy), undefined);
  assert.equal(legacySandboxCredentialPolicy(policy), policy);
  assert.equal(sandboxCredentialPolicyFromStorage(policy), undefined);
  assert.equal(
    sandboxCredentialPolicyFromStorage(
      registration({ policy: { ...policy, expiresAt: Date.now() - 1 } }),
    ),
    undefined,
  );
});

test("legacy migration and tombstones validate exact bounded identities", () => {
  const migration = {
    generation: "generation-2",
    registrationClaim: `${credentialPolicyLegacyRepairClaimPrefix}claim-2`,
    registrationExpiresAt: Date.now() + 60_000,
    sandboxIds: ["sandbox-1", "sandbox-2"],
    sessionId: "IS-42",
  };
  assert.equal(validSandboxCredentialPolicyLegacyMigration(migration), true);
  assert.equal(
    validSandboxCredentialPolicyLegacyMigration({
      ...migration,
      generation: "legacy:generation-2",
    }),
    false,
  );
  assert.equal(
    validSandboxCredentialPolicyLegacyMigration({
      ...migration,
      sandboxIds: ["sandbox-1", "sandbox-1"],
    }),
    false,
  );
  assert.equal(
    validCredentialPolicyTombstone({
      generation: "generation-2",
      sessionId: "IS-42",
      tombstonedAt: Date.now(),
    }),
    true,
  );
  assert.equal(
    validCredentialPolicyTombstone({
      generation: "",
      sessionId: "IS-42",
      tombstonedAt: Date.now(),
    }),
    false,
  );
});

test("fleet policy summaries deduplicate owners and redact credential material", () => {
  const policies = dedupeSandboxPolicies([
    { ...policy, sandboxId: "sandbox-2" },
    policy,
    { ...policy, owner: "other", sandboxId: "sandbox-3" },
  ]);
  assert.deepEqual(
    policies.map((item) => item.sandboxId),
    ["sandbox-1", "sandbox-3"],
  );

  assert.deepEqual(redactSandboxPolicy(policy), {
    allowedHostCount: 2,
    allowedHosts: ["api.github.com", "api.openai.com"],
    githubCredentialSource: "session",
    githubRepo: "openclaw/crabfleet",
    hasGithubRepoNodeId: true,
    hasGithubToken: true,
    openAIBaseUrlHost: "api.openai.com",
    openAIOrgConfigured: true,
    owner: "operator",
    sandboxId: "sandbox-1",
    sessionId: "IS-42",
  });
});
