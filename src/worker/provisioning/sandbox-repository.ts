import { sql } from "kysely";

import { sha256 } from "../crypto.ts";
import {
  database,
  executeBatch,
  type CompilableQuery,
  type InteractiveSessionRow,
} from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import {
  newSandboxLease,
  sandboxLeaseId,
  sandboxLeaseInfo,
  sandboxLeasePrefix,
  sandboxLeaseWithoutRefresh,
  type SandboxLeaseRefreshFence,
} from "../sandbox-lease.ts";
import { newAgentToken } from "../session-reservation-context.ts";
import type { ManagedSandboxProvisionClaim, ManagedSandboxProvisionCommit } from "./sandbox.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export async function claimManagedSandboxProvision(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  owner: InteractiveSessionRow,
  now: number,
  claimTtlMs: number,
): Promise<ManagedSandboxProvisionClaim | null> {
  const claimRevision = Math.max(now, owner.updated_at + 1);
  const agentToken = newAgentToken();
  const agentTokenHash = await sha256(agentToken);
  const lease = newSandboxLease(session.id);
  const fence: SandboxLeaseRefreshFence = {
    claim: `managed-provision:${crypto.randomUUID()}`,
    expiresAt: now + claimTtlMs,
    refreshLeaseId: owner.lease_id,
    sandboxId: lease.sandboxId,
  };
  const claimed = await database(env)
    .updateTable("interactive_sessions")
    .set({
      sandbox_refresh_sandbox_id: fence.sandboxId,
      sandbox_refresh_claim: fence.claim,
      sandbox_refresh_claim_expires_at: fence.expiresAt,
      agent_token_hash: agentTokenHash,
      last_event: "managed Sandbox provision claimed",
      updated_at: claimRevision,
    })
    .where("id", "=", owner.id)
    .where("updated_at", "=", owner.updated_at)
    .where("status", "in", ["provisioning", "pending_adapter"])
    .where("preparation_pending", "=", 0)
    .where(sql<boolean>`parent_session_id IS ${session.parentSessionId}`)
    .where(sql<boolean>`COALESCE(root_session_id, id) = ${session.rootSessionId}`)
    .where("runtime", "=", session.runtime)
    .where("repo", "=", session.repo)
    .where("branch", "=", session.branch)
    .where("profile", "=", session.profile)
    .where("command", "=", session.command)
    .where("prompt", "=", session.prompt)
    .where("purpose", "=", session.purpose)
    .where("summary", "=", session.summary)
    .where("owner", "=", session.owner)
    .where("created_by", "=", session.createdBy)
    // Never adopt retired or unknown adapter ownership as a built-in Sandbox session.
    .where("adapter", "is", null)
    .where("credential_cleanup_terminal_status", "is", null)
    .where(sql<boolean>`agent_token_hash IS ${owner.agent_token_hash}`)
    .where(sql<boolean>`lease_id IS ${owner.lease_id}`)
    .where((expression) =>
      expression.or([
        expression("sandbox_refresh_claim", "is", null),
        expression("sandbox_refresh_claim_expires_at", "<=", now),
      ]),
    )
    .executeTakeFirst();
  if ((claimed.numUpdatedRows ?? 0n) === 0n) return null;

  const previousSandboxId = owner.lease_id?.startsWith(sandboxLeasePrefix)
    ? sandboxLeaseInfo({
        id: owner.id,
        leaseId: sandboxLeaseWithoutRefresh(owner.lease_id),
      }).sandboxId
    : null;
  return {
    agentToken,
    agentTokenHash,
    lease,
    fence,
    previousSandboxId,
    claimRevision,
  };
}

export async function commitManagedSandboxProvision(
  env: RuntimeEnv,
  sessionId: string,
  claim: ManagedSandboxProvisionClaim,
  provisioned: InteractiveProvisionResult,
  finishedAt: number,
): Promise<ManagedSandboxProvisionCommit> {
  const expectedLeaseId = sandboxLeaseId(claim.lease);
  const commitRevision = Math.max(finishedAt, claim.claimRevision + 1);
  const db = database(env);
  const commitQueries: CompilableQuery[] = [
    db
      .updateTable("interactive_sessions")
      .set({
        status: "ready",
        lease_id: expectedLeaseId,
        attach_url: provisioned.attachUrl,
        vnc_url: provisioned.vncUrl,
        sandbox_refresh_sandbox_id: null,
        sandbox_refresh_claim: null,
        sandbox_refresh_claim_expires_at: null,
        last_event: provisioned.message,
        updated_at: sql<number>`MAX(updated_at + 1, ${commitRevision})`,
      })
      .where("id", "=", sessionId)
      .where("status", "in", ["provisioning", "pending_adapter"])
      .where(sql<boolean>`lease_id IS ${claim.fence.refreshLeaseId}`)
      .where("sandbox_refresh_sandbox_id", "=", claim.fence.sandboxId)
      .where("sandbox_refresh_claim", "=", claim.fence.claim)
      .where("sandbox_refresh_claim_expires_at", "=", claim.fence.expiresAt)
      .where("sandbox_refresh_claim_expires_at", ">", finishedAt)
      .where("agent_token_hash", "=", claim.agentTokenHash),
  ];
  const cleanupPending = Boolean(
    claim.previousSandboxId && claim.previousSandboxId !== claim.lease.sandboxId,
  );
  if (cleanupPending) {
    commitQueries.push(
      db
        .updateTable("interactive_session_credential_policies")
        .set({
          state: "cleanup_pending",
          cleanup_claim: null,
          cleanup_claim_expires_at: null,
          updated_at: commitRevision,
        })
        .where("session_id", "=", sessionId)
        .where("sandbox_id", "=", claim.previousSandboxId!).where(sql<boolean>`
          EXISTS (
            SELECT 1
            FROM interactive_sessions AS owner
            WHERE owner.id = ${sessionId}
              AND owner.status = 'ready'
              AND owner.lease_id = ${expectedLeaseId}
              AND owner.agent_token_hash = ${claim.agentTokenHash}
              AND owner.credential_cleanup_terminal_status IS NULL
              AND owner.sandbox_refresh_sandbox_id IS NULL
              AND owner.sandbox_refresh_claim IS NULL
              AND owner.sandbox_refresh_claim_expires_at IS NULL
          )
        `),
    );
  }
  await executeBatch(env, commitQueries);
  const current = await db
    .selectFrom("interactive_sessions")
    .select(["lease_id", "status", "sandbox_refresh_claim", "agent_token_hash"])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  return {
    committed: Boolean(
      current?.lease_id === expectedLeaseId &&
      current.sandbox_refresh_claim === null &&
      current.agent_token_hash === claim.agentTokenHash &&
      ["ready", "attached", "detached"].includes(current.status),
    ),
    cleanupPending,
    commitRevision,
  };
}
