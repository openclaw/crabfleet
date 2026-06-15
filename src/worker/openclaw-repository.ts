import { sql } from "kysely";

import { database, type InteractiveSessionRow } from "./database.ts";
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
