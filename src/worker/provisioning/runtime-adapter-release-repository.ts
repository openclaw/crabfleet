import { sql } from "kysely";

import { database, type RuntimeAdapterWorkspaceCleanupRow } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import type {
  RuntimeAdapterWorkspaceCleanup,
  RuntimeAdapterWorkspaceRegistration,
} from "./runtime-adapter-release-service.ts";

const cleanupClaimTtlMs = 60_000;
const cleanupRetryDelayMs = 15_000;

export async function stageRuntimeAdapterWorkspaceCleanup(
  env: RuntimeEnv,
  input: {
    sessionId: string;
    adapterWorkspaceId: string;
    registration: RuntimeAdapterWorkspaceRegistration | null;
    createPending: boolean;
    now: number;
  },
): Promise<void> {
  await sql`
    INSERT INTO runtime_adapter_workspace_cleanups (
      session_id,
      adapter_workspace_id,
      profile,
      control_plane,
      create_pending,
      message,
      reconcile_error,
      next_attempt_at,
      created_at,
      updated_at
    ) VALUES (
      ${input.sessionId},
      ${input.adapterWorkspaceId},
      ${input.registration?.profile ?? null},
      ${input.registration?.controlPlane ?? null},
      ${input.createPending ? 1 : 0},
      'superseded runtime adapter cleanup pending',
      NULL,
      ${input.now},
      ${input.now},
      ${input.now}
    )
    ON CONFLICT(session_id, adapter_workspace_id) DO NOTHING
  `.execute(database(env));
}

export async function claimRuntimeAdapterWorkspaceCleanup(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  now: number,
): Promise<RuntimeAdapterWorkspaceCleanup | null> {
  const claim = `runtime-cleanup:${crypto.randomUUID()}`;
  const row = await database(env)
    .updateTable("runtime_adapter_workspace_cleanups")
    .set({
      cleanup_claim: claim,
      cleanup_claim_expires_at: now + cleanupClaimTtlMs,
      attempt_count: sql<number>`attempt_count + 1`,
      last_attempt_at: now,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where("session_id", "=", sessionId)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("next_attempt_at", "<=", now)
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<=", now),
      ]),
    )
    .returningAll()
    .executeTakeFirst();
  return row ? cleanupClaim(row) : null;
}

export async function claimRuntimeAdapterWorkspaceCleanupBatch(
  env: RuntimeEnv,
  now: number,
  limit: number,
): Promise<RuntimeAdapterWorkspaceCleanup[]> {
  const candidates = await database(env)
    .selectFrom("runtime_adapter_workspace_cleanups")
    .select(["session_id", "adapter_workspace_id"])
    .where("next_attempt_at", "<=", now)
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<=", now),
      ]),
    )
    .orderBy("next_attempt_at", "asc")
    .orderBy("updated_at", "asc")
    .orderBy("session_id", "asc")
    .orderBy("adapter_workspace_id", "asc")
    .limit(limit)
    .execute();
  const claims: RuntimeAdapterWorkspaceCleanup[] = [];
  for (const candidate of candidates) {
    const claimed = await claimRuntimeAdapterWorkspaceCleanup(
      env,
      candidate.session_id,
      candidate.adapter_workspace_id,
      now,
    );
    if (claimed) claims.push(claimed);
  }
  return claims;
}

export async function persistRuntimeAdapterWorkspaceCleanupEvidence(
  env: RuntimeEnv,
  cleanup: RuntimeAdapterWorkspaceCleanup,
  message: string,
  now: number,
  reconcileError: string | null,
): Promise<void> {
  await database(env)
    .updateTable("runtime_adapter_workspace_cleanups")
    .set({
      message,
      reconcile_error: reconcileError,
      next_attempt_at: now + cleanupRetryDelayMs,
      cleanup_claim: null,
      cleanup_claim_expires_at: null,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where("session_id", "=", cleanup.sessionId)
    .where("adapter_workspace_id", "=", cleanup.adapterWorkspaceId)
    .where("cleanup_claim", "=", cleanup.claim)
    .execute();
}

export async function markRuntimeAdapterWorkspaceCleanupDeletionObserved(
  env: RuntimeEnv,
  cleanup: RuntimeAdapterWorkspaceCleanup,
  now: number,
): Promise<void> {
  const row = await database(env)
    .updateTable("runtime_adapter_workspace_cleanups")
    .set({
      deletion_observed: 1,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where("session_id", "=", cleanup.sessionId)
    .where("adapter_workspace_id", "=", cleanup.adapterWorkspaceId)
    .where("cleanup_claim", "=", cleanup.claim)
    .returning("deletion_observed")
    .executeTakeFirst();
  if (!row) throw new Error("runtime adapter cleanup ownership changed");
}

export async function completeRuntimeAdapterWorkspaceCleanup(
  env: RuntimeEnv,
  cleanup: RuntimeAdapterWorkspaceCleanup,
): Promise<void> {
  await database(env)
    .deleteFrom("runtime_adapter_workspace_cleanups")
    .where("session_id", "=", cleanup.sessionId)
    .where("adapter_workspace_id", "=", cleanup.adapterWorkspaceId)
    .where("cleanup_claim", "=", cleanup.claim)
    .execute();
}

function cleanupClaim(row: RuntimeAdapterWorkspaceCleanupRow): RuntimeAdapterWorkspaceCleanup {
  return {
    sessionId: row.session_id,
    adapterWorkspaceId: row.adapter_workspace_id,
    registration:
      row.profile && row.control_plane
        ? {
            profile: row.profile,
            controlPlane: row.control_plane,
          }
        : null,
    createPending: row.create_pending === 1,
    deletionObserved: row.deletion_observed === 1,
    claim: row.cleanup_claim ?? "",
  };
}
