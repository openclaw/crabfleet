import { sql, type Insertable, type UpdateObject } from "kysely";

import {
  database,
  executeBatch,
  type Database,
  type InteractiveSessionRow,
  type InteractiveSessionTable,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { InteractiveRuntime, InteractiveSessionStatus } from "./models.ts";
import type {
  InteractiveProvisionPersistence,
  InteractiveProvisionPersistenceInput,
  InteractiveProvisionResult,
} from "./provisioning/types.ts";
import {
  interactiveSession,
  interactiveSessionLogArchive,
  type InteractiveSession,
  type InteractiveSessionEventRow,
  type InteractiveSessionLogArchive,
  type RuntimeCapabilities,
} from "./session-model.ts";

export type InteractiveSessionReplayReservation = {
  requestId: string;
  requestHash: string;
  sessionId: string;
  createdAt: number;
};

export type InteractiveSessionReservationValues = Insertable<InteractiveSessionTable>;

export type LegacyInteractiveSessionStopOwner = {
  id: string;
  status: InteractiveSessionStatus;
  runtime: InteractiveRuntime;
  adapter: string | null;
  leaseId: string | null;
  updatedAt: number;
};

export type InteractiveSessionReservationBuildInput = {
  id: string;
  parentSessionId: string | null;
  rootSessionId: string;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  adapterName: string;
  profile: string;
  adapterWorkspaceId: string | null;
  adapterControlPlane: string | null;
  requestedCapabilities: RuntimeCapabilities;
  adapterSettings: {
    ttlSeconds: number;
    idleTimeoutSeconds: number;
    capabilities: RuntimeCapabilities;
  } | null;
  adapterCreatePayloadJson: string | null;
  preparationReservation: boolean;
  openClawRequestId: string | null;
  openClawRequestHash: string | null;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  initialLeaseId: string | null;
  initialAgentTokenHash: string;
  now: number;
};

export function buildInteractiveSessionReservationValues(
  input: InteractiveSessionReservationBuildInput,
): InteractiveSessionReservationValues {
  const immediateAdapter = Boolean(input.adapterWorkspaceId && !input.preparationReservation);
  return {
    id: input.id,
    parent_session_id: input.parentSessionId,
    root_session_id: input.rootSessionId,
    repo: input.repo,
    branch: input.branch,
    runtime: input.runtime,
    adapter: immediateAdapter ? input.adapterName : null,
    profile: input.profile,
    adapter_workspace_id: input.adapterWorkspaceId,
    adapter_control_plane: input.adapterControlPlane,
    provider_resource_id: null,
    capabilities_json: JSON.stringify(input.requestedCapabilities),
    expires_at: null,
    last_reconciled_at: immediateAdapter ? input.now : null,
    reconcile_error: immediateAdapter ? "runtime adapter create pending" : null,
    terminal_status: null,
    adapter_ttl_seconds: input.adapterSettings?.ttlSeconds ?? null,
    adapter_idle_timeout_seconds: input.adapterSettings?.idleTimeoutSeconds ?? null,
    adapter_requested_capabilities_json: input.adapterSettings
      ? JSON.stringify(input.adapterSettings.capabilities)
      : null,
    adapter_create_payload_json: input.adapterCreatePayloadJson,
    adapter_create_pending: immediateAdapter ? 1 : 0,
    preparation_pending: input.preparationReservation ? 1 : 0,
    openclaw_request_id: input.openClawRequestId,
    openclaw_request_hash: input.openClawRequestHash,
    openclaw_admission_closed: 0,
    command: input.command,
    prompt: input.prompt,
    purpose: input.purpose,
    summary: input.summary,
    owner: input.owner,
    created_by: input.createdBy,
    status: "provisioning",
    lease_id: input.initialLeaseId,
    attach_url: null,
    vnc_url: null,
    last_event: "interactive workspace requested",
    created_at: input.now,
    updated_at: input.now,
    last_seen_at: input.now,
    stopped_at: null,
    share_mode: "private",
    share_token_hash: null,
    share_token_preview: null,
    control_requested_by: null,
    control_requested_at: null,
    controller: null,
    control_granted_at: null,
    control_expires_at: null,
    multiplayer_mode: 0,
    agent_token_hash: input.initialAgentTokenHash,
    work_key: null,
    work_kind: null,
    work_state: "",
    work_phase: "",
    source_url: null,
    github_run_url: null,
    codex_thread_id: null,
    codex_turn_id: null,
    last_heartbeat_at: null,
    completion_reason: null,
  };
}

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

export async function readSharedInteractiveSessionRow(
  env: RuntimeEnv,
  id: string,
): Promise<InteractiveSessionRow | null> {
  return (
    (await database(env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", id)
      .where("preparation_pending", "=", 0)
      .where("share_mode", "=", "link_read")
      .executeTakeFirst()) ?? null
  );
}

export async function readInteractiveSessionRecords(
  env: RuntimeEnv,
  limit = 80,
): Promise<InteractiveSession[]> {
  const rows = await readVisibleInteractiveSessionRows(env, limit);
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [logs, archives] = await Promise.all([
    readInteractiveSessionLogs(env, ids),
    readInteractiveSessionLogArchives(env, ids),
  ]);
  return rows.map((row) =>
    interactiveSession(row, logs.get(row.id) ?? [], archives.get(row.id) ?? null),
  );
}

export async function readInteractiveSessionRecord(
  env: RuntimeEnv,
  id: string,
): Promise<InteractiveSession | null> {
  const row = await readVisibleInteractiveSessionRow(env, id);
  if (!row) return null;
  const [logs, archives] = await Promise.all([
    readInteractiveSessionLogs(env, [id]),
    readInteractiveSessionLogArchives(env, [id]),
  ]);
  return interactiveSession(row, logs.get(id) ?? [], archives.get(id) ?? null);
}

export async function readInteractiveSessionLogs(
  env: RuntimeEnv,
  ids: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return new Map();
  const eventRows = (
    await sql<{ session_id: string; message: string; created_at: number }>`
      SELECT session_id, message, created_at
      FROM (
        SELECT session_id, message, created_at, id,
          row_number() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rank
        FROM interactive_session_events
        WHERE session_id IN (${sql.join(uniqueIds)})
      )
      WHERE rank <= 80
      ORDER BY session_id ASC, created_at ASC, id ASC
    `.execute(database(env))
  ).rows;
  const logs = new Map<string, string[]>();
  for (const row of eventRows) {
    const line = `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`;
    logs.set(row.session_id, [...(logs.get(row.session_id) ?? []), line]);
  }
  return logs;
}

export async function readInteractiveSessionLogArchives(
  env: RuntimeEnv,
  ids: string[],
): Promise<Map<string, InteractiveSessionLogArchive>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return new Map();
  const rows = await database(env)
    .selectFrom("interactive_session_log_archives")
    .selectAll()
    .where("session_id", "in", uniqueIds)
    .execute();
  return new Map(rows.map((row) => [row.session_id, interactiveSessionLogArchive(row)]));
}

export async function readInteractiveSessionEventRows(
  env: RuntimeEnv,
  id: string,
  options: { limit?: number; newest?: boolean } = {},
): Promise<InteractiveSessionEventRow[]> {
  const limit = options.limit ? Math.max(1, Math.min(10000, Math.floor(options.limit))) : 0;
  const base = database(env)
    .selectFrom("interactive_session_events")
    .selectAll()
    .where("session_id", "=", id);
  if (limit && options.newest) {
    const rows = await base
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.reverse();
  }
  const ordered = base.orderBy("created_at", "asc").orderBy("id", "asc");
  return (limit ? ordered.limit(limit) : ordered).execute();
}

export async function countInteractiveSessionEvents(env: RuntimeEnv, id: string): Promise<number> {
  const row = await database(env)
    .selectFrom("interactive_session_events")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("session_id", "=", id)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

export async function persistInteractiveSessionEventMutation(
  env: RuntimeEnv,
  session: { id: string; status: string; updatedAt: number },
  actorName: string,
  message: string,
  values: UpdateObject<Database, "interactive_sessions">,
  now: number,
): Promise<boolean> {
  const db = database(env);
  const eventMessage = clean(message, 1000);
  const revision = Math.max(now, session.updatedAt + 1);
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND status = ${session.status}
    AND updated_at = ${session.updatedAt}
  `;
  const eventQuery = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, ${actorName}, ${eventMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const updateQuery = db
    .updateTable("interactive_sessions")
    .set({
      ...values,
      terminal_finalize_pending: sql<number>`CASE
        WHEN status IN ('stopped', 'expired', 'failed') THEN 1
        ELSE terminal_finalize_pending
      END`,
      updated_at: revision,
      last_event: eventMessage,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [eventQuery, updateQuery].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  return results.at(-1)?.results.some((row) => row.updated_at === revision) ?? false;
}

export async function persistLegacyInteractiveSessionStop(
  env: RuntimeEnv,
  owner: LegacyInteractiveSessionStopOwner,
  actorName: string,
  runtimeAdapterName: string,
  sandboxLeasePrefix: string,
  now: number,
): Promise<boolean> {
  const db = database(env);
  const revision = Math.max(now, owner.updatedAt + 1);
  const eventActor = clean(actorName, 120) || "system";
  const expectedOwner = sql<boolean>`
    id = ${owner.id}
    AND status = ${owner.status}
    AND runtime = ${owner.runtime}
    AND updated_at = ${owner.updatedAt}
    AND adapter IS ${owner.adapter}
    AND lease_id IS ${owner.leaseId}
    AND (adapter IS NULL OR adapter != ${runtimeAdapterName})
    AND (lease_id IS NULL OR lease_id NOT LIKE ${`${sandboxLeasePrefix}%`})
    AND credential_cleanup_terminal_status IS NULL
  `;
  const requestedMessage = "interactive workspace stop requested";
  const finalMessage = "interactive workspace stopped";
  const requestedEvent = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${owner.id}, ${eventActor}, ${requestedMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const stoppedEvent = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${owner.id}, ${eventActor}, ${finalMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const stop = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopped",
      stopped_at: sql<number>`COALESCE(stopped_at, ${now})`,
      reconcile_error: null,
      terminal_status: null,
      adapter_create_pending: 0,
      terminal_finalize_pending: 1,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: revision,
      last_event: finalMessage,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [requestedEvent, stoppedEvent, stop].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  return results.at(-1)?.results.some((row) => row.updated_at === revision) ?? false;
}

export async function persistGitHubActionsSessionStop(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
  actorName: string,
  githubActionsRuntime: string,
  now: number,
): Promise<boolean> {
  const revision = Math.max(now, session.updatedAt + 1);
  const message = "GitHub Actions terminal session ended from Crabfleet; workflow run not canceled";
  const db = database(env);
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND runtime = ${githubActionsRuntime}
    AND status = ${session.status}
    AND updated_at = ${session.updatedAt}
  `;
  const event = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, ${clean(actorName, 120) || "system"}, ${message}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const update = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopped",
      stopped_at: now,
      reconcile_error: null,
      terminal_status: null,
      terminal_failure_reason: null,
      terminal_finalize_pending: 1,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      work_state: "",
      work_phase: "session_ended",
      completion_reason: "Crabfleet terminal session ended; workflow run not canceled",
      last_event: message,
      updated_at: revision,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [event, update].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  return results.at(-1)?.results.some((row) => row.updated_at === revision) ?? false;
}

export async function readInteractiveSessionTerminalCleanupIntent(
  env: RuntimeEnv,
  sessionId: string,
): Promise<boolean> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select("credential_cleanup_terminal_status")
    .where("id", "=", sessionId)
    .where("status", "=", "stopping")
    .executeTakeFirst();
  return Boolean(row?.credential_cleanup_terminal_status);
}

export async function readRuntimeAdapterCreatePending(
  env: RuntimeEnv,
  sessionId: string,
  runtimeAdapterName: string,
  adapterWorkspaceId: string,
): Promise<boolean> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select("adapter_create_pending")
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("status", "=", "stopping")
    .executeTakeFirst();
  return row?.adapter_create_pending === 1;
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

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
