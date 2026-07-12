import {
  credentialPolicyRollbackExpiresAt,
  credentialPolicyRollbackRecord,
  isCurrentCredentialPolicyGeneration,
  type CredentialPolicyRollbackRecord,
} from "../credential-policy-fence.ts";
import type {
  SandboxCredentialPolicy,
  SandboxCredentialPolicyRegistration,
  StoredSandboxCredentialPolicy,
} from "./session-control-policy.ts";

const credentialPolicyRollbackClaimMs = 60_000;

export type SandboxCredentialPolicyRollbackRecord =
  CredentialPolicyRollbackRecord<SandboxCredentialPolicy>;

type SessionControlStub = Pick<DurableObjectStub, "fetch">;

export async function captureSandboxCredentialPolicyRollback(
  stub: SessionControlStub,
  lookupIds: readonly string[],
  expectedGeneration: string | null,
  sessionId: string,
): Promise<SandboxCredentialPolicyRollbackRecord[]> {
  const records = await Promise.all(
    lookupIds.map(async (lookupId): Promise<SandboxCredentialPolicyRollbackRecord | null> => {
      const response = await stub.fetch(
        `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(lookupId)}`,
      );
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("sandbox credential policy rollback snapshot failed");
      const generation = response.headers.get("x-crabfleet-policy-generation");
      const policy = (await response.json()) as SandboxCredentialPolicy;
      if (
        !isCurrentCredentialPolicyGeneration(generation) ||
        policy.sessionId !== sessionId ||
        policy.sandboxId !== lookupId
      ) {
        throw new Error("sandbox credential policy rollback snapshot is inconsistent");
      }
      return { generation, policy };
    }),
  );
  const present = records.filter((record): record is SandboxCredentialPolicyRollbackRecord =>
    Boolean(record),
  );
  if (!expectedGeneration) {
    if (present.length > 0) {
      throw new Error("sandbox credential policy has no durable rollback owner");
    }
    return [];
  }
  if (
    present.length !== lookupIds.length ||
    present.some((record) => record.generation !== expectedGeneration)
  ) {
    throw new Error("sandbox credential policy rollback generation is incomplete");
  }
  return present;
}

export function parseSandboxCredentialPolicyRollback(
  value: string,
  lookupIds: readonly string[],
  sessionId: string,
): SandboxCredentialPolicyRollbackRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("sandbox credential policy rollback snapshot is invalid");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("sandbox credential policy rollback snapshot is invalid");
  }
  const records = parsed.map((item) =>
    credentialPolicyRollbackRecord<SandboxCredentialPolicy>(item),
  );
  if (records.some((record) => !record)) {
    throw new Error("sandbox credential policy rollback snapshot is invalid");
  }
  const rollback = records as SandboxCredentialPolicyRollbackRecord[];
  const expectedLookups = new Set(lookupIds);
  const actualLookups = new Set(rollback.map((record) => record.policy.sandboxId));
  const generations = new Set(rollback.map((record) => record.generation));
  if (
    rollback.some(
      (record) =>
        record.policy.sessionId !== sessionId || !expectedLookups.has(record.policy.sandboxId),
    ) ||
    actualLookups.size !== rollback.length ||
    (rollback.length > 0 && (rollback.length !== expectedLookups.size || generations.size !== 1))
  ) {
    throw new Error("sandbox credential policy rollback snapshot is inconsistent");
  }
  return rollback;
}

export async function restoreSandboxCredentialPolicyRollback(
  stub: SessionControlStub,
  registration: SandboxCredentialPolicyRegistration,
  registrationExpiresAt: number,
  rollbackJson: string,
  sessionId: string,
): Promise<void> {
  const rollback = parseSandboxCredentialPolicyRollback(
    rollbackJson,
    registration.lookupIds,
    sessionId,
  );
  const now = Date.now();
  const rollbackExpiresAt = credentialPolicyRollbackExpiresAt(
    registrationExpiresAt,
    now,
    credentialPolicyRollbackClaimMs,
  );
  for (const record of rollback) {
    const response = await stub.fetch("https://crabfleet.internal/api/session-control/register", {
      method: "POST",
      body: JSON.stringify({
        generation: record.generation,
        registrationClaim: `rollback:${registration.claim}`,
        registrationExpiresAt: rollbackExpiresAt,
        policy: record.policy,
      } satisfies StoredSandboxCredentialPolicy),
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
      throw new Error("sandbox credential policy rollback restore failed");
    }
  }
}
