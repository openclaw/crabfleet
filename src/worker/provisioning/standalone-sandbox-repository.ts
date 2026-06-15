import { sql } from "kysely";

import { mapWithConcurrency } from "../concurrency.ts";
import { database, executeBatch, type StandaloneSandboxProvisionRow } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import {
  activeSandboxCredentialPolicyCondition,
  activeSandboxCredentialPolicyGeneration,
  sandboxCredentialPolicyCleanupAuthorizedCondition,
  sandboxCredentialPolicyGeneration,
  sandboxCredentialPolicyRefQueries,
} from "../sandbox-credential-policy-repository.ts";
import {
  newSandboxLease,
  sandboxLeaseId,
  type StandaloneSandboxProvisionFence,
} from "../sandbox-lease.ts";
import {
  isManagedInteractiveSessionId,
  type StandaloneSandboxProvisionClaim,
} from "./standalone-sandbox.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

const credentialPolicyCleanupLimit = 8;

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

export async function stageStandaloneSandboxProvisionCleanup(
  env: RuntimeEnv,
  owner: StandaloneSandboxProvisionRow,
  message: string,
  now: number,
): Promise<boolean> {
  if (owner.state === "cleanup_pending") return true;
  const db = database(env);
  const transitionRevision = Math.max(now, owner.updated_at + 1);
  const generation = await sandboxCredentialPolicyGeneration(env, owner.id, owner.sandbox_id);
  let ownerTransition = db
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
    .where("id", "=", owner.id)
    .where("request_hash", "=", owner.request_hash)
    .where("sandbox_id", "=", owner.sandbox_id)
    .where("state", "=", owner.state)
    .where("updated_at", "=", owner.updated_at);
  ownerTransition = owner.ownership_claim
    ? ownerTransition.where("ownership_claim", "=", owner.ownership_claim)
    : ownerTransition.where("ownership_claim", "is", null);
  ownerTransition =
    owner.ownership_claim_expires_at === null
      ? ownerTransition.where("ownership_claim_expires_at", "is", null)
      : ownerTransition.where("ownership_claim_expires_at", "=", owner.ownership_claim_expires_at);
  ownerTransition = owner.lease_id
    ? ownerTransition.where("lease_id", "=", owner.lease_id)
    : ownerTransition.where("lease_id", "is", null);
  ownerTransition =
    owner.expires_at === null
      ? ownerTransition.where("expires_at", "is", null)
      : ownerTransition.where("expires_at", "=", owner.expires_at);
  const cleanupAuthorized = sandboxCredentialPolicyCleanupAuthorizedCondition(
    owner.id,
    owner.sandbox_id,
    transitionRevision,
  );
  await executeBatch(env, [
    ownerTransition,
    ...sandboxCredentialPolicyRefQueries(
      env,
      owner.id,
      owner.sandbox_id,
      "cleanup_pending",
      generation,
      transitionRevision,
      cleanupAuthorized,
    ),
    db
      .updateTable("interactive_session_credential_policies")
      .set({ state: "cleanup_pending", updated_at: transitionRevision })
      .where("session_id", "=", owner.id)
      .where("sandbox_id", "=", owner.sandbox_id)
      .where(cleanupAuthorized),
  ]);
  const staged = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "sandbox_id", "updated_at"])
    .where("id", "=", owner.id)
    .executeTakeFirst();
  return Boolean(
    staged?.state === "cleanup_pending" &&
    staged.sandbox_id === owner.sandbox_id &&
    staged.updated_at === transitionRevision,
  );
}

export async function expireStandaloneSandboxProvisions(
  env: RuntimeEnv,
  now: number,
  provisionId?: string,
): Promise<void> {
  const idFilter = provisionId ? sql`AND id = ${provisionId}` : sql``;
  const result = await sql<StandaloneSandboxProvisionRow>`
    SELECT *
    FROM standalone_sandbox_provisions
    WHERE (
      (state = 'active' AND (expires_at IS NULL OR expires_at <= ${now}))
      OR (
        state = 'provisioning'
        AND (
          expires_at IS NULL
          OR expires_at <= ${now}
          OR ownership_claim_expires_at IS NULL
          OR ownership_claim_expires_at <= ${now}
        )
      )
      OR (
        state = 'active'
        AND lower(id) GLOB 'is-[0-9]*'
        AND substr(lower(id), 4) NOT GLOB '*[^0-9]*'
      )
    )
    ${idFilter}
    ORDER BY COALESCE(expires_at, 0) ASC, updated_at ASC, id ASC
    LIMIT ${credentialPolicyCleanupLimit}
  `.execute(database(env));
  await mapWithConcurrency(result.rows, 3, async (owner) => {
    await stageStandaloneSandboxProvisionCleanup(
      env,
      owner,
      isManagedInteractiveSessionId(owner.id)
        ? "standalone provision used the reserved managed session namespace"
        : "standalone Sandbox provision expired",
      now,
    );
  });
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
