import assert from "node:assert/strict";
import test from "node:test";

import {
  dedupeSandboxPolicies,
  redactSandboxPolicy,
  sandboxCredentialPolicyCleanupDeletesStored,
  sandboxCredentialPolicyFromStorage,
  storedSandboxCredentialPolicy,
  validCredentialPolicyTombstone,
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
    generation: "generation:test-1",
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
    validSandboxCredentialPolicyRegistration(registration({ generation: "legacy:test-1" })),
    false,
  );
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
  assert.equal(sandboxCredentialPolicyFromStorage(current), policy);

  assert.equal(storedSandboxCredentialPolicy(policy), undefined);
  assert.equal(sandboxCredentialPolicyFromStorage(policy), undefined);
  assert.equal(
    storedSandboxCredentialPolicy(registration({ generation: "legacy:test-1" })),
    undefined,
  );
  assert.equal(
    sandboxCredentialPolicyFromStorage(
      registration({ policy: { ...policy, expiresAt: Date.now() - 1 } }),
    ),
    undefined,
  );
});

test("credential cleanup purges unreadable storage without crossing current generations", () => {
  assert.equal(
    sandboxCredentialPolicyCleanupDeletesStored(undefined, "generation:test-1", "IS-42"),
    false,
  );
  assert.equal(
    sandboxCredentialPolicyCleanupDeletesStored(policy, "generation:test-1", "IS-42"),
    true,
  );
  assert.equal(
    sandboxCredentialPolicyCleanupDeletesStored(registration(), "generation:test-1", "IS-42"),
    true,
  );
  assert.equal(
    sandboxCredentialPolicyCleanupDeletesStored(registration(), "generation:test-2", "IS-42"),
    false,
  );
  assert.equal(
    sandboxCredentialPolicyCleanupDeletesStored(registration(), "generation:test-1", "IS-43"),
    false,
  );
});

test("generation tombstones validate exact bounded identities", () => {
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
