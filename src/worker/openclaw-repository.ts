import { sql } from "kysely";

import { database, executeBatch, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { interactiveSession, type InteractiveSession } from "./session-model.ts";

export type OpenClawRoomSessions = {
  sessions: InteractiveSession[];
  overflow: boolean;
};

export async function readOpenClawRoomRoot(
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<InteractiveSession | null> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", rootSessionId)
    .where("preparation_pending", "=", 0)
    .executeTakeFirst();
  return row ? interactiveSession(row, []) : null;
}

export async function readOpenClawRoomSessions(
  env: RuntimeEnv,
  rootSessionId: string,
  maximumSessions: number,
): Promise<OpenClawRoomSessions> {
  const limit = Math.max(1, Math.floor(maximumSessions));
  const rows = await openClawRoomRowsQuery(env, rootSessionId)
    .where("preparation_pending", "=", 0)
    .orderBy("created_at", "asc")
    .limit(limit + 1)
    .execute();
  return {
    sessions: rows.slice(0, limit).map((row) => interactiveSession(row, [])),
    overflow: rows.length > limit,
  };
}

export async function readOpenClawRootRows(
  env: RuntimeEnv,
  rootSessionId: string,
  maximumSessions: number,
): Promise<InteractiveSessionRow[]> {
  return openClawRoomRowsQuery(env, rootSessionId)
    .orderBy(
      sql<number>`CASE
        WHEN preparation_pending != 0 THEN 0
        WHEN status NOT IN ('stopped', 'expired', 'failed') THEN 1
        ELSE 2
      END`,
      "asc",
    )
    .orderBy("created_at", "asc")
    .limit(Math.max(1, Math.floor(maximumSessions)))
    .execute();
}

export async function readOpenClawRootCompletion(
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<{ total: number; remaining: number }> {
  const result = await sql<{ total: number; remaining: number }>`
    SELECT
      count(*) AS total,
      sum(
        CASE
          WHEN preparation_pending != 0 OR status NOT IN ('stopped', 'expired', 'failed') THEN 1
          ELSE 0
        END
      ) AS remaining
    FROM interactive_sessions
    WHERE (root_session_id = ${rootSessionId} OR id = ${rootSessionId})
      AND (created_by = 'service:openclaw' OR created_by LIKE 'session:%')
      AND runtime != 'github_actions'
      AND work_key IS NULL
  `.execute(database(env));
  return {
    total: Number(result.rows[0]?.total ?? 0),
    remaining: Number(result.rows[0]?.remaining ?? 0),
  };
}

export async function closeOpenClawRootAdmission(
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<void> {
  await database(env)
    .updateTable("interactive_sessions")
    .set({ openclaw_admission_closed: 1 })
    .where("id", "=", rootSessionId)
    .execute();
}

export async function openClawRootAdmissionOpen(
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<boolean> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select("openclaw_admission_closed")
    .where("id", "=", rootSessionId)
    .executeTakeFirst();
  return row?.openclaw_admission_closed === 0;
}

export async function readOpenClawLineageSession(
  env: RuntimeEnv,
  id: string,
  preparationPending: 0 | 1,
): Promise<InteractiveSession | null> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("preparation_pending", "=", preparationPending)
    .executeTakeFirst();
  return row ? interactiveSession(row, []) : null;
}

export async function openClawRoomReservationPosition(
  env: RuntimeEnv,
  rootSessionId: string,
  insertedSessionId: string,
  insertedAt: number,
): Promise<number> {
  const admission = await sql<{ inserted_rowid: number; position: number }>`
    SELECT inserted.rowid AS inserted_rowid, count(candidate.rowid) AS position
    FROM interactive_sessions AS inserted
    JOIN interactive_sessions AS candidate
      ON candidate.rowid <= inserted.rowid
      AND (candidate.root_session_id = ${rootSessionId} OR candidate.id = ${rootSessionId})
      AND (candidate.created_by = 'service:openclaw' OR candidate.created_by LIKE 'session:%')
      AND candidate.runtime != 'github_actions'
      AND candidate.work_key IS NULL
    JOIN interactive_sessions AS room_root
      ON room_root.id = ${rootSessionId}
      AND room_root.openclaw_admission_closed = 0
    WHERE inserted.id = ${insertedSessionId}
      AND inserted.status = 'provisioning'
      AND inserted.preparation_pending = 1
      AND inserted.created_at = ${insertedAt}
      AND inserted.updated_at = ${insertedAt}
    GROUP BY inserted.rowid
  `.execute(database(env));
  return Number(admission.rows[0]?.position ?? 0);
}

export async function removeInteractiveSessionReservation(
  env: RuntimeEnv,
  insertedSessionId: string,
  insertedAt: number,
): Promise<boolean> {
  const db = database(env);
  const ownsReservation = sql<boolean>`EXISTS (
    SELECT 1
    FROM interactive_sessions
    WHERE id = ${insertedSessionId}
      AND status = 'provisioning'
      AND preparation_pending = 1
      AND created_at = ${insertedAt}
      AND updated_at = ${insertedAt}
  )`;
  await executeBatch(env, [
    db
      .deleteFrom("openclaw_request_replays")
      .where("session_id", "=", insertedSessionId)
      .where(ownsReservation),
    db
      .deleteFrom("interactive_session_events")
      .where("session_id", "=", insertedSessionId)
      .where(ownsReservation),
    db
      .deleteFrom("interactive_session_log_archives")
      .where("session_id", "=", insertedSessionId)
      .where(ownsReservation),
    db
      .deleteFrom("interactive_sessions")
      .where("id", "=", insertedSessionId)
      .where("status", "=", "provisioning")
      .where("preparation_pending", "=", 1)
      .where("created_at", "=", insertedAt)
      .where("updated_at", "=", insertedAt),
  ]);
  const current = await db
    .selectFrom("interactive_sessions")
    .select("id")
    .where("id", "=", insertedSessionId)
    .executeTakeFirst();
  return !current;
}

export type AbandonedInteractiveSessionReservation = {
  sessionId: string;
  createdAt: number;
};

export async function readAbandonedInteractiveSessionReservations(
  env: RuntimeEnv,
  staleBefore: number,
  limit: number,
): Promise<AbandonedInteractiveSessionReservation[]> {
  const rows = await database(env)
    .selectFrom("interactive_sessions")
    .select(["id", "created_at"])
    .where("status", "=", "provisioning")
    .where("preparation_pending", "=", 1)
    .where("updated_at", "<=", staleBefore)
    .orderBy("updated_at", "asc")
    .limit(Math.max(1, Math.floor(limit)))
    .execute();
  return rows.map((row) => ({ sessionId: row.id, createdAt: row.created_at }));
}

export async function activateInteractiveSessionReservation(
  env: RuntimeEnv,
  insertedSessionId: string,
  insertedAt: number,
  adapterWorkspaceId: string | null,
  adapterName: string,
): Promise<boolean> {
  const activated = await database(env)
    .updateTable("interactive_sessions")
    .set({
      preparation_pending: 0,
      ...(adapterWorkspaceId
        ? {
            adapter: adapterName,
            adapter_create_pending: 1,
            last_reconciled_at: insertedAt,
            reconcile_error: "runtime adapter create pending",
          }
        : {}),
    })
    .where("id", "=", insertedSessionId)
    .where("status", "=", "provisioning")
    .where("preparation_pending", "=", 1)
    .where("adapter", "is", null)
    .where(sql<boolean>`adapter_workspace_id IS ${adapterWorkspaceId}`)
    .where("adapter_create_pending", "=", 0)
    .where("created_at", "=", insertedAt)
    .where("updated_at", "=", insertedAt)
    .executeTakeFirst();
  return (activated.numUpdatedRows ?? 0n) > 0n;
}

function openClawRoomRowsQuery(env: RuntimeEnv, rootSessionId: string) {
  return database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where((expression) =>
      expression.or([
        expression("root_session_id", "=", rootSessionId),
        expression("id", "=", rootSessionId),
      ]),
    )
    .where((expression) =>
      expression.or([
        expression("created_by", "=", "service:openclaw"),
        expression("created_by", "like", "session:%"),
      ]),
    )
    .where("runtime", "!=", "github_actions")
    .where("work_key", "is", null);
}
