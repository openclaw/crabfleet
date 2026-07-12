export type CredentialPolicyGenerationRecord<T extends { sessionId: string }> = {
  generation: string;
  registrationClaim: string;
  registrationExpiresAt: number;
  policy: T;
};

export type CredentialPolicyGenerationTombstone = {
  generation: string;
  sessionId: string;
  tombstonedAt: number;
};

export function isCurrentCredentialPolicyGeneration(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("generation:") &&
    value.length > "generation:".length &&
    value.length <= 200
  );
}

export function credentialPolicyRegistrationAccepted<T extends { sessionId: string }>(
  current: CredentialPolicyGenerationRecord<T> | undefined,
  tombstone: CredentialPolicyGenerationTombstone | undefined,
  incoming: CredentialPolicyGenerationRecord<T>,
  now: number,
): boolean {
  if (incoming.registrationExpiresAt <= now) return false;
  if (tombstone?.generation === incoming.generation) {
    return false;
  }
  if (!current) return true;
  if (current.policy.sessionId !== incoming.policy.sessionId) {
    return false;
  }
  if (current.generation !== incoming.generation) {
    return incoming.registrationExpiresAt > current.registrationExpiresAt;
  }
  if (current.registrationClaim === incoming.registrationClaim) {
    return incoming.registrationExpiresAt >= current.registrationExpiresAt;
  }
  return incoming.registrationExpiresAt > current.registrationExpiresAt;
}

export function credentialPolicyCleanupMatches<T extends { sessionId: string }>(
  current: CredentialPolicyGenerationRecord<T> | undefined,
  generation: string,
  sessionId: string,
): boolean {
  return Boolean(
    current && current.generation === generation && current.policy.sessionId === sessionId,
  );
}

export function credentialPolicySandboxIsExpected(
  leaseSandboxId: string | null,
  policySandboxId: string,
  refreshSandboxId: string | null,
  refreshClaim: string | null,
  refreshClaimExpiresAt: number | null,
  now: number,
): boolean {
  if (leaseSandboxId === policySandboxId) return true;
  return Boolean(
    refreshSandboxId === policySandboxId &&
    refreshClaim &&
    refreshClaimExpiresAt !== null &&
    refreshClaimExpiresAt > now,
  );
}
