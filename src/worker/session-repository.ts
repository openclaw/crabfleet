import { sql, type Insertable } from "kysely";

import {
  database,
  executeBatch,
  type InteractiveSessionRow,
  type InteractiveSessionTable,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type {
  InteractiveProvisionPersistence,
  InteractiveProvisionPersistenceInput,
  InteractiveProvisionResult,
} from "./session-provisioning.ts";

export type InteractiveSessionReplayReservation = {
  requestId: string;
  requestHash: string;
  sessionId: string;
  createdAt: number;
};

export type InteractiveSessionReservationValues = Insertable<InteractiveSessionTable>;

export async function readVisibleInteractiveSessionRows(
  env: RuntimeEnv,
  limit = 80,
): Promise<InteractiveSessionRow[]> {
  return database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("preparation_pending", "=", 0)
    .orderBy("updated_at", "desc")
    .limit(Math.max(1, Math.floor(limit)))
    .execute();
}

export async function readVisibleInteractiveSessionRow(
  env: RuntimeEnv,
  id: string,
): Promise<InteractiveSessionRow | null> {
  return (
    (await database(env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", id)
      .where("preparation_pending", "=", 0)
      .executeTakeFirst()) ?? null
  );
}

export async function insertInteractiveSessionReservation(
  env: RuntimeEnv,
  values: InteractiveSessionReservationValues,
  replay: InteractiveSessionReplayReservation | null,
): Promise<void> {
  const db = database(env);
  const insertSession = db.insertInto("interactive_sessions").values(values);
  if (!replay) {
    await insertSession.execute();
    return;
  }
  await executeBatch(env, [
    db.insertInto("openclaw_request_replays").values({
      request_id: replay.requestId,
      request_hash: replay.requestHash,
      session_id: replay.sessionId,
      created_at: replay.createdAt,
      updated_at: replay.createdAt,
    }),
    insertSession,
  ]);
}

export async function persistInteractiveSessionProvisionResult(
  env: RuntimeEnv,
  input: InteractiveProvisionPersistenceInput,
  result: InteractiveProvisionResult,
): Promise<InteractiveProvisionPersistence> {
  const terminalStatus =
    result.status === "stopped" || result.status === "expired" || result.status === "failed"
      ? result.status
      : null;
  const terminalAt = result.reconciledAt ?? input.insertedAt + 1;
  const completionVersionFloor = Math.max(terminalAt, input.insertedAt + 1);
  const update = await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: result.status,
      lease_id: result.adapter === input.adapterName ? null : result.leaseId,
      attach_url: terminalStatus ? null : result.attachUrl,
      // Versioned adapter desktop URLs are minted on demand and never persisted.
      vnc_url: result.adapter === input.adapterName ? null : result.vncUrl,
      adapter: result.adapter ?? null,
      profile: result.profile ?? input.profile,
      adapter_workspace_id: result.adapterWorkspaceId ?? null,
      provider_resource_id: result.providerResourceId ?? null,
      capabilities_json: JSON.stringify(result.capabilities ?? input.requestedCapabilities),
      expires_at: result.expiresAt ?? null,
      last_reconciled_at: result.reconciledAt ?? null,
      reconcile_error: result.reconcileError ?? null,
      terminal_status: terminalStatus ? null : (result.terminalStatus ?? null),
      adapter_create_pending: terminalStatus ? 0 : result.createPending ? 1 : 0,
      terminal_finalize_pending: terminalStatus ? 1 : 0,
      ...(terminalStatus
        ? {
            stopped_at: terminalAt,
            agent_token_hash: null,
            controller: null,
            control_requested_by: null,
            control_requested_at: null,
            control_granted_at: null,
            control_expires_at: null,
          }
        : {}),
      last_event: result.message,
      updated_at: sql<number>`MAX(updated_at + 1, ${completionVersionFloor})`,
    })
    .where("id", "=", input.sessionId)
    .where("status", "in", ["provisioning", "pending_adapter"])
    .where(sql<boolean>`lease_id IS ${input.initialLeaseId}`)
    .where("agent_token_hash", "=", input.initialAgentTokenHash)
    .where("sandbox_refresh_sandbox_id", "is", null)
    .where("sandbox_refresh_claim", "is", null)
    .where("sandbox_refresh_claim_expires_at", "is", null)
    .executeTakeFirst();
  return {
    updated: (update.numUpdatedRows ?? 0n) > 0n,
    terminalStatus,
    terminalAt,
  };
}

export async function markInteractiveSessionPendingAdapter(
  env: RuntimeEnv,
  input: Pick<
    InteractiveProvisionPersistenceInput,
    "sessionId" | "insertedAt" | "initialLeaseId" | "initialAgentTokenHash"
  >,
): Promise<void> {
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "pending_adapter",
      last_event: "waiting for interactive runtime adapter",
      updated_at: sql<number>`MAX(updated_at + 1, ${input.insertedAt + 1})`,
    })
    .where("id", "=", input.sessionId)
    .where("status", "=", "provisioning")
    .where(sql<boolean>`lease_id IS ${input.initialLeaseId}`)
    .where("agent_token_hash", "=", input.initialAgentTokenHash)
    .execute();
}
