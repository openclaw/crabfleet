import { sql } from "kysely";

import { database, executeBatch, type StandaloneSandboxProvisionRow } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import {
  activeSandboxCredentialPolicyCondition,
  activeSandboxCredentialPolicyGeneration,
} from "../sandbox-policy-state.ts";
import { newSandboxLease, sandboxLeaseId } from "../sandbox-lease.ts";
import type {
  StandaloneSandboxProvisionClaim,
  StandaloneSandboxProvisionFence,
} from "./standalone-sandbox.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export async function readStandaloneSandboxProvision(
  env: RuntimeEnv,
  provisionId: string,
): Promise<StandaloneSandboxProvisionRow | null> {
  return (
    (await database(env)
      .selectFrom("standalone_sandbox_provisions")
      .selectAll()
      .where("id", "=", provisionId)
      .executeTakeFirst()) ?? null
  );
}

export async function claimStandaloneSandboxProvision(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  requestHash: string,
  now: number,
  ownershipTtlMs: number,
  provisionTtlMs: number,
): Promise<StandaloneSandboxProvisionClaim | null> {
  const lease = newSandboxLease(session.id);
  const fence: StandaloneSandboxProvisionFence = {
    claim: `standalone:${crypto.randomUUID()}`,
    provisionId: session.id,
    sandboxId: lease.sandboxId,
  };
  const expiresAt = now + provisionTtlMs;
  await sql`
    INSERT INTO standalone_sandbox_provisions (
      id,
      request_hash,
      sandbox_id,
      state,
      ownership_claim,
      ownership_claim_expires_at,
      lease_id,
      attach_url,
      vnc_url,
      expires_at,
      message,
      created_at,
      updated_at
    ) VALUES (
      ${session.id},
      ${requestHash},
      ${lease.sandboxId},
      'provisioning',
      ${fence.claim},
      ${now + ownershipTtlMs},
      ${sandboxLeaseId(lease)},
      NULL,
      NULL,
      ${expiresAt},
      'standalone Sandbox provision started',
      ${now},
      ${now}
    )
    ON CONFLICT(id) DO NOTHING
  `.execute(database(env));
  const owner = await readStandaloneSandboxProvision(env, session.id);
  if (
    owner?.request_hash !== requestHash ||
    owner.sandbox_id !== lease.sandboxId ||
    owner.state !== "provisioning" ||
    owner.ownership_claim !== fence.claim ||
    (owner.ownership_claim_expires_at ?? 0) <= now ||
    owner.lease_id !== sandboxLeaseId(lease) ||
    owner.expires_at !== expiresAt
  ) {
    return null;
  }
  return { lease, fence, expiresAt, claimRevision: now };
}

export async function stageStandaloneSandboxClaimCleanup(
  env: RuntimeEnv,
  claim: StandaloneSandboxProvisionClaim,
  message: string,
  now: number,
): Promise<void> {
  const transitionRevision = Math.max(now, claim.claimRevision + 1);
  await database(env)
    .updateTable("standalone_sandbox_provisions")
    .set({
      state: "cleanup_pending",
      ownership_claim: null,
      ownership_claim_expires_at: null,
      attach_url: null,
      vnc_url: null,
      message,
      updated_at: transitionRevision,
    })
    .where("id", "=", claim.fence.provisionId)
    .where("sandbox_id", "=", claim.fence.sandboxId)
    .where("state", "=", "provisioning")
    .where("ownership_claim", "=", claim.fence.claim)
    .where("lease_id", "=", sandboxLeaseId(claim.lease))
    .where("expires_at", "=", claim.expiresAt)
    .execute();
}

export async function activateStandaloneSandboxProvision(
  env: RuntimeEnv,
  provisionId: string,
  claim: StandaloneSandboxProvisionClaim,
  result: InteractiveProvisionResult,
  now: number,
): Promise<boolean> {
  const generation = await activeSandboxCredentialPolicyGeneration(
    env,
    provisionId,
    claim.lease.sandboxId,
  );
  if (!generation) return false;
  const activationVersion = Math.max(now, claim.claimRevision + 1);
  const ownerStillClaimed = sql<boolean>`EXISTS (
    SELECT 1
    FROM standalone_sandbox_provisions AS owner
    WHERE owner.id = ${provisionId}
      AND owner.sandbox_id = ${claim.lease.sandboxId}
      AND owner.state = 'provisioning'
      AND owner.ownership_claim = ${claim.fence.claim}
      AND owner.ownership_claim_expires_at > ${activationVersion}
      AND owner.expires_at = ${claim.expiresAt}
      AND owner.expires_at > ${activationVersion}
  )`;
  const db = database(env);
  await executeBatch(env, [
    db
      .updateTable("interactive_session_credential_policies")
      .set({ updated_at: activationVersion })
      .where("session_id", "=", provisionId)
      .where("sandbox_id", "=", claim.lease.sandboxId)
      .where("state", "=", "active")
      .where("registration_generation", "=", generation)
      .where("registration_claim", "is", null)
      .where(ownerStillClaimed),
    db
      .updateTable("standalone_sandbox_provisions")
      .set({
        state: "active",
        ownership_claim: null,
        ownership_claim_expires_at: null,
        lease_id: result.leaseId,
        attach_url: result.attachUrl,
        vnc_url: result.vncUrl,
        message: result.message,
        updated_at: activationVersion,
      })
      .where("id", "=", provisionId)
      .where("sandbox_id", "=", claim.lease.sandboxId)
      .where("state", "=", "provisioning")
      .where("ownership_claim", "=", claim.fence.claim)
      .where("ownership_claim_expires_at", ">", activationVersion)
      .where("expires_at", "=", claim.expiresAt)
      .where("expires_at", ">", activationVersion)
      .where(
        activeSandboxCredentialPolicyCondition(
          env,
          provisionId,
          claim.lease.sandboxId,
          generation,
          activationVersion,
        ),
      ),
  ]);
  const activated = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "sandbox_id", "lease_id", "expires_at"])
    .where("id", "=", provisionId)
    .executeTakeFirst();
  return Boolean(
    activated?.state === "active" &&
    activated.sandbox_id === claim.lease.sandboxId &&
    activated.lease_id === result.leaseId &&
    activated.expires_at === claim.expiresAt,
  );
}
