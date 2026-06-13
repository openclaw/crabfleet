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

export type CredentialPolicyLegacyMigration = {
  generation: string;
  registrationClaim: string;
  registrationExpiresAt: number;
  sessionId: string;
};

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
  if (
    current.generation !== incoming.generation ||
    current.policy.sessionId !== incoming.policy.sessionId
  ) {
    return false;
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

export function migratedCredentialPolicyRecord<T extends { sessionId: string }>(
  current: CredentialPolicyGenerationRecord<T> | undefined,
  legacy: T | undefined,
  tombstone: CredentialPolicyGenerationTombstone | undefined,
  migration: CredentialPolicyLegacyMigration,
  now: number,
): CredentialPolicyGenerationRecord<T> | undefined {
  if (migration.registrationExpiresAt <= now || tombstone?.generation === migration.generation) {
    return undefined;
  }
  const policy = current?.policy ?? legacy;
  if (!policy || policy.sessionId !== migration.sessionId) return undefined;
  const incoming = {
    generation: migration.generation,
    registrationClaim: migration.registrationClaim,
    registrationExpiresAt: migration.registrationExpiresAt,
    policy,
  };
  if (!current) return incoming;
  if (
    current.generation !== migration.generation &&
    (!current.generation.startsWith("legacy:") ||
      migration.registrationExpiresAt <= current.registrationExpiresAt)
  ) {
    return undefined;
  }
  if (
    current.generation === migration.generation &&
    !credentialPolicyRegistrationAccepted(current, tombstone, incoming, now)
  ) {
    return undefined;
  }
  return incoming;
}

export function credentialPolicyMigrationCleanupMatches<T extends { sessionId: string }>(
  current: CredentialPolicyGenerationRecord<T> | undefined,
  generation: string,
  sessionId: string,
): boolean {
  return Boolean(
    current &&
    current.generation !== generation &&
    current.generation.startsWith("legacy:") &&
    current.policy.sessionId === sessionId,
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
