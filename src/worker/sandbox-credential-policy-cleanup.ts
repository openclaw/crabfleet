import { sql } from "kysely";

import { runtimeAdapterName } from "../runtime-adapter.ts";
import { database, executeBatch, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  sandboxCredentialPolicyCleanupAuthorizedCondition,
  sandboxCredentialPolicyGeneration,
  sandboxCredentialPolicyRefQueries,
  sandboxManagedStoredOwnershipCondition,
  type SandboxManagedOwnershipFence,
} from "./sandbox-credential-policy-repository.ts";
import {
  sandboxLeaseInfo,
  sandboxLeasePrefix,
  sandboxLeaseWithoutRefresh,
} from "./sandbox-lease.ts";

export type SandboxTerminalCleanupOwnership = {
  fence: SandboxManagedOwnershipFence;
  sandboxIds: string[];
  terminalLeaseId: string;
};

export function sandboxTerminalCleanupOwnership(
  session: Pick<
    InteractiveSessionRow,
    | "id"
    | "lease_id"
    | "sandbox_refresh_sandbox_id"
    | "sandbox_refresh_claim"
    | "sandbox_refresh_claim_expires_at"
  >,
): SandboxTerminalCleanupOwnership | null {
  if (!session.lease_id?.startsWith(sandboxLeasePrefix)) return null;
  const terminalLeaseId = sandboxLeaseWithoutRefresh(session.lease_id);
  let currentSandboxId: string;
  try {
    currentSandboxId = sandboxLeaseInfo({ id: session.id, leaseId: terminalLeaseId }).sandboxId;
  } catch {
    return null;
  }
  const refreshValues = [
    session.sandbox_refresh_sandbox_id,
    session.sandbox_refresh_claim,
    session.sandbox_refresh_claim_expires_at,
  ];
  const refreshPresent = refreshValues.some((value) => value !== null);
  if (refreshPresent && refreshValues.some((value) => value === null)) return null;
  if (
    session.sandbox_refresh_sandbox_id &&
    session.sandbox_refresh_claim &&
    session.sandbox_refresh_claim_expires_at !== null
  ) {
    return {
      fence: {
        claim: session.sandbox_refresh_claim,
        expiresAt: session.sandbox_refresh_claim_expires_at,
        refreshLeaseId: session.lease_id,
        sandboxId: session.sandbox_refresh_sandbox_id,
      },
      sandboxIds: [...new Set([currentSandboxId, session.sandbox_refresh_sandbox_id])],
      terminalLeaseId,
    };
  }
  return {
    fence: { leaseId: session.lease_id, sandboxId: currentSandboxId },
    sandboxIds: [currentSandboxId],
    terminalLeaseId,
  };
}

export function sandboxManagedOwnershipFencesMatch(
  left: SandboxManagedOwnershipFence,
  right: SandboxManagedOwnershipFence,
): boolean {
  if ("leaseId" in left || "leaseId" in right) {
    return (
      "leaseId" in left &&
      "leaseId" in right &&
      left.leaseId === right.leaseId &&
      left.sandboxId === right.sandboxId
    );
  }
  return (
    left.claim === right.claim &&
    left.expiresAt === right.expiresAt &&
    left.refreshLeaseId === right.refreshLeaseId &&
    left.sandboxId === right.sandboxId
  );
}

export function terminalCleanupIntentRank(status: "stopped" | "expired" | "failed"): number {
  return status === "failed" ? 3 : status === "expired" ? 2 : 1;
}

export async function stageTerminalCredentialPolicyCleanup(
  env: RuntimeEnv,
  session: InteractiveSessionRow,
  terminalStatus: "stopped" | "expired" | "failed",
  message: string,
  now: number,
  failureReason?: string,
  requiredFence?: SandboxManagedOwnershipFence,
): Promise<boolean> {
  const ownership = sandboxTerminalCleanupOwnership(session);
  if (
    !ownership ||
    (requiredFence && !sandboxManagedOwnershipFencesMatch(ownership.fence, requiredFence))
  ) {
    return false;
  }
  const db = database(env);
  const stageRevision = Math.max(now, session.updated_at + 1);
  const generations = await Promise.all(
    ownership.sandboxIds.map(async (sandboxId) => ({
      generation: await sandboxCredentialPolicyGeneration(env, session.id, sandboxId),
      sandboxId,
    })),
  );
  const cleanupIntent = sql<"stopped" | "expired" | "failed">`CASE
    WHEN credential_cleanup_terminal_status = 'failed' OR ${terminalStatus} = 'failed'
      THEN 'failed'
    WHEN credential_cleanup_terminal_status = 'expired' OR ${terminalStatus} = 'expired'
      THEN 'expired'
    ELSE 'stopped'
  END`;
  const failureFallback =
    failureReason ??
    (terminalStatus === "failed"
      ? message
      : "interactive workspace failed during credential cleanup");
  const failureEvidence = sql<string | null>`CASE
    WHEN credential_cleanup_terminal_status = 'failed' THEN COALESCE(
      NULLIF(terminal_failure_reason, ''),
      NULLIF(reconcile_error, ''),
      NULLIF(last_event, ''),
      ${failureFallback}
    )
    WHEN ${terminalStatus} = 'failed' THEN COALESCE(
      NULLIF(terminal_failure_reason, ''),
      NULLIF(${failureFallback}, ''),
      NULLIF(reconcile_error, ''),
      NULLIF(last_event, ''),
      'interactive workspace failed during credential cleanup'
    )
    ELSE terminal_failure_reason
  END`;
  const sessionTransition = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopping",
      lease_id: ownership.terminalLeaseId,
      credential_cleanup_terminal_status: cleanupIntent,
      terminal_finalize_pending: 0,
      sandbox_refresh_sandbox_id: null,
      sandbox_refresh_claim: null,
      sandbox_refresh_claim_expires_at: null,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      controller_subject: null,
      control_requested_by: null,
      control_requested_by_subject: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      reconcile_error: sql<string>`CASE
        WHEN credential_cleanup_terminal_status = 'failed' OR ${terminalStatus} = 'failed'
          THEN COALESCE(${failureEvidence}, ${message})
        ELSE ${message}
      END`,
      terminal_failure_reason: failureEvidence,
      terminal_status: null,
      adapter_create_pending: 0,
      stopped_at: sql<number>`COALESCE(stopped_at, ${now})`,
      updated_at: stageRevision,
      last_event: message,
    })
    .where("id", "=", session.id)
    .where("updated_at", "=", session.updated_at)
    .where((expression) =>
      expression.or([
        expression("adapter", "is", null),
        expression("adapter", "!=", runtimeAdapterName),
      ]),
    )
    .where(sandboxManagedStoredOwnershipCondition(ownership.fence));
  const policyTransitions = generations.flatMap(({ generation, sandboxId }) => [
    ...sandboxCredentialPolicyRefQueries(
      env,
      session.id,
      sandboxId,
      "cleanup_pending",
      generation,
      stageRevision,
      sandboxCredentialPolicyCleanupAuthorizedCondition(session.id, sandboxId, stageRevision),
    ),
    db
      .updateTable("interactive_session_credential_policies")
      .set({
        state: "cleanup_pending",
        updated_at: stageRevision,
      })
      .where("session_id", "=", session.id)
      .where("sandbox_id", "=", sandboxId)
      .where(
        sandboxCredentialPolicyCleanupAuthorizedCondition(session.id, sandboxId, stageRevision),
      ),
    db
      .updateTable("interactive_session_credential_policy_registrations")
      .set({
        state: "cleanup_pending",
        registration_claim: null,
        registration_claim_expires_at: null,
        updated_at: stageRevision,
      })
      .where("session_id", "=", session.id)
      .where("sandbox_id", "=", sandboxId)
      .where(
        sandboxCredentialPolicyCleanupAuthorizedCondition(session.id, sandboxId, stageRevision),
      ),
  ]);
  await executeBatch(env, [sessionTransition, ...policyTransitions]);
  const staged = await db
    .selectFrom("interactive_sessions")
    .select([
      "status",
      "credential_cleanup_terminal_status",
      "terminal_failure_reason",
      "updated_at",
    ])
    .where("id", "=", session.id)
    .executeTakeFirst();
  return Boolean(
    staged?.status === "stopping" &&
    staged.updated_at === stageRevision &&
    staged.credential_cleanup_terminal_status &&
    terminalCleanupIntentRank(staged.credential_cleanup_terminal_status) >=
      terminalCleanupIntentRank(terminalStatus) &&
    (staged.credential_cleanup_terminal_status !== "failed" || staged.terminal_failure_reason),
  );
}

export async function stageTerminalCredentialPolicyCleanupById(
  env: RuntimeEnv,
  sessionId: string,
  terminalStatus: "stopped" | "expired" | "failed",
  message: string,
  now: number,
  failureReason?: string,
  requiredFence?: SandboxManagedOwnershipFence,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await database(env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!session) return false;
    if (
      session.status === "stopping" &&
      session.credential_cleanup_terminal_status &&
      terminalCleanupIntentRank(session.credential_cleanup_terminal_status) >=
        terminalCleanupIntentRank(terminalStatus) &&
      (session.credential_cleanup_terminal_status !== "failed" || session.terminal_failure_reason)
    ) {
      return true;
    }
    if (
      await stageTerminalCredentialPolicyCleanup(
        env,
        session,
        terminalStatus,
        message,
        now,
        failureReason,
        session.status === "stopping" && session.credential_cleanup_terminal_status
          ? undefined
          : requiredFence,
      )
    ) {
      return true;
    }
  }
  return false;
}
