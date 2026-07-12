import {
  credentialPolicyCleanupMatches,
  isCurrentCredentialPolicyGeneration,
  type CredentialPolicyGenerationRecord,
  type CredentialPolicyGenerationTombstone,
} from "../credential-policy-fence.ts";
import type { FleetSandboxPolicySummary } from "../fleet-state.ts";

export type SandboxCredentialPolicy = {
  allowedHosts: string[];
  expiresAt?: number;
  githubCredentialSource?: "none" | "session" | "worker";
  githubRepo: string;
  githubRepoNodeId?: string;
  githubTokenCiphertext?: string;
  openAIBaseUrl?: string;
  openAIOrgId?: string;
  owner: string;
  sandboxId: string;
  sessionId: string;
};

export type StoredSandboxCredentialPolicy =
  CredentialPolicyGenerationRecord<SandboxCredentialPolicy>;

export type SandboxCredentialPolicyRegistration = {
  generation: string;
  claim: string;
  lookupIds: string[];
};

export function sandboxCredentialPolicyRegistrationLookupIds(
  value: string | null | undefined,
  sandboxId: string,
  expectedLookupIds: readonly string[],
): string[] {
  if (value !== null && value !== undefined) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (
        Array.isArray(parsed) &&
        parsed.length > 0 &&
        parsed.every(
          (lookupId) =>
            typeof lookupId === "string" && lookupId.length > 0 && lookupId.length <= 200,
        )
      ) {
        const lookupIds = [...new Set(parsed)];
        if (lookupIds.includes(sandboxId)) return lookupIds;
      }
    } catch {
      // Malformed persisted state cannot authorize additional lookup identities.
    }
    return [sandboxId];
  }
  const fallbackLookupIds = [...new Set(expectedLookupIds)];
  return fallbackLookupIds.includes(sandboxId) ? fallbackLookupIds : [sandboxId];
}

export function storedSandboxCredentialPolicy(
  value: unknown,
): StoredSandboxCredentialPolicy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Partial<StoredSandboxCredentialPolicy>;
  if (
    record.policy &&
    isCurrentCredentialPolicyGeneration(record.generation) &&
    typeof record.registrationClaim === "string" &&
    typeof record.registrationExpiresAt === "number"
  ) {
    return record as StoredSandboxCredentialPolicy;
  }
  return undefined;
}

export function sandboxCredentialPolicyFromStorage(
  value: unknown,
): SandboxCredentialPolicy | undefined {
  const current = storedSandboxCredentialPolicy(value);
  if (!current) return undefined;
  if (
    current.policy.expiresAt !== undefined &&
    (!Number.isFinite(current.policy.expiresAt) || current.policy.expiresAt <= Date.now())
  ) {
    return undefined;
  }
  return current.policy;
}

export function sandboxCredentialPolicyCleanupDeletesStored(
  value: unknown,
  generation: string,
  sessionId: string,
): boolean {
  if (value === undefined) return false;
  const current = storedSandboxCredentialPolicy(value);
  return !current || credentialPolicyCleanupMatches(current, generation, sessionId);
}

export function validSandboxCredentialPolicyRegistration(
  value: StoredSandboxCredentialPolicy,
): boolean {
  return Boolean(
    value &&
    isCurrentCredentialPolicyGeneration(value.generation) &&
    typeof value.registrationClaim === "string" &&
    value.registrationClaim.length > 0 &&
    value.registrationClaim.length <= 200 &&
    Number.isFinite(value.registrationExpiresAt) &&
    value.policy &&
    typeof value.policy.sandboxId === "string" &&
    typeof value.policy.sessionId === "string" &&
    (value.policy.expiresAt === undefined ||
      (Number.isFinite(value.policy.expiresAt) && value.policy.expiresAt > Date.now())),
  );
}

export function validCredentialPolicyTombstone(
  value: CredentialPolicyGenerationTombstone,
): boolean {
  return Boolean(
    value &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    value.generation.length <= 200 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 200 &&
    Number.isFinite(value.tombstonedAt),
  );
}

export function dedupeSandboxPolicies(
  policies: SandboxCredentialPolicy[],
): SandboxCredentialPolicy[] {
  const seen = new Set<string>();
  const result: SandboxCredentialPolicy[] = [];
  for (const policy of policies.sort((a, b) => a.sandboxId.localeCompare(b.sandboxId))) {
    const key = `${policy.sessionId}:${policy.owner}:${policy.githubRepo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(policy);
  }
  return result;
}

export function redactSandboxPolicy(
  policy: SandboxCredentialPolicy,
  workerCredentialAvailable = false,
): FleetSandboxPolicySummary {
  const githubCredentialSource =
    policy.githubCredentialSource ??
    (policy.githubTokenCiphertext ? "session" : workerCredentialAvailable ? "worker" : "none");
  return {
    allowedHostCount: policy.allowedHosts.length,
    allowedHosts: [...policy.allowedHosts].sort(),
    githubCredentialSource,
    githubRepo: policy.githubRepo,
    hasGithubRepoNodeId: Boolean(policy.githubRepoNodeId),
    hasGithubToken: githubCredentialSource !== "none",
    openAIBaseUrlHost: urlHost(policy.openAIBaseUrl),
    openAIOrgConfigured: Boolean(policy.openAIOrgId),
    owner: policy.owner,
    sandboxId: policy.sandboxId,
    sessionId: policy.sessionId,
  };
}

function urlHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}
