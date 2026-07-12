import { sql, type Kysely, type RawBuilder } from "kysely";

import { retainedRuntimeAdapterFailureMessage } from "../runtime-adapter.ts";
import { completeTerminalFinalization } from "../terminal-finalization.ts";
import { database, executeBatch, type CompilableQuery, type Database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import { archiveInteractiveSessionLogs } from "./session-log-archive.ts";
import { hasNoCredentialPolicyLifecycle } from "./session-cleanup.ts";
import { countInteractiveSessionEvents } from "./session-repository.ts";

export type TerminalInteractiveSessionStatus = "stopped" | "expired" | "failed";

export type TerminalInteractiveSessionFailureEvidence = {
  terminal_failure_reason: string | null;
  reconcile_error: string | null;
  last_event: string | null;
};

export function terminalFinalizationPendingQuery(
  db: Kysely<Database>,
  id: string,
): CompilableQuery {
  return db
    .updateTable("interactive_sessions")
    .set({ terminal_finalize_pending: 1 })
    .where("id", "=", id)
    .where("status", "in", deadInteractiveSessionStatuses);
}

export function terminalInteractiveSessionFinalizationMessage(
  status: TerminalInteractiveSessionStatus,
  terminal: TerminalInteractiveSessionFailureEvidence | undefined,
): string {
  if (status === "failed") {
    return retainedRuntimeAdapterFailureMessage(
      terminal?.terminal_failure_reason ?? null,
      terminal?.reconcile_error ?? null,
      terminal?.last_event ?? null,
    );
  }
  return status === "expired" ? "interactive workspace expired" : "interactive workspace stopped";
}

export function terminalFinalizationClearPendingQuery(
  id: string,
  status: TerminalInteractiveSessionStatus,
  sessionLogsEnabled: boolean,
): RawBuilder<unknown> {
  return sql`
    UPDATE interactive_sessions
    SET terminal_finalize_pending = 0
    WHERE id = ${id}
      AND status = ${status}
      AND terminal_finalize_pending > 0
      AND EXISTS (
        SELECT 1
        FROM interactive_session_log_archives AS archive
        WHERE archive.session_id = interactive_sessions.id
          AND archive.session_updated_at = interactive_sessions.updated_at
      )
      AND ${hasNoCredentialPolicyLifecycle(id)}
      AND COALESCE(
        (
          SELECT event_count
          FROM interactive_session_log_archives
          WHERE session_id = ${id}
        ),
        -1
      ) >= (
        SELECT count(*)
        FROM interactive_session_events
        WHERE session_id = ${id}
      )
      AND (
        ${sessionLogsEnabled ? 1 : 0} = 0
        OR EXISTS (
          SELECT 1
          FROM interactive_session_log_archives
          WHERE session_id = ${id}
            AND events_key IS NOT NULL
            AND transcript_key IS NOT NULL
            AND summary_key IS NOT NULL
        )
      )
  `;
}

export async function finalizeTerminalInteractiveSession(
  env: RuntimeEnv,
  id: string,
  status: TerminalInteractiveSessionStatus,
  now: number,
): Promise<void> {
  const db = database(env);
  const terminal = await db
    .selectFrom("interactive_sessions")
    .select(["terminal_failure_reason", "reconcile_error", "last_event"])
    .where("id", "=", id)
    .where("status", "=", status)
    .executeTakeFirst();
  const message = terminalInteractiveSessionFinalizationMessage(status, terminal);
  await completeTerminalFinalization({
    ensureEvent: async () => {
      await executeBatch(env, [
        sql`
          INSERT INTO interactive_session_events (session_id, actor, message, created_at)
          SELECT ${id}, 'system', ${message}, COALESCE(stopped_at, ${now})
          FROM interactive_sessions AS session
          WHERE session.id = ${id}
            AND session.status = ${status}
            AND NOT EXISTS (
              SELECT 1
              FROM interactive_session_events AS event
              WHERE event.session_id = session.id
                AND event.actor = 'system'
                AND event.message = ${message}
            )
        `,
        terminalFinalizationPendingQuery(db, id),
      ]);
      return true;
    },
    readArchiveState: async () => {
      const [currentArchive, eventCount, currentSession] = await Promise.all([
        db
          .selectFrom("interactive_session_log_archives")
          .selectAll()
          .where("session_id", "=", id)
          .executeTakeFirst(),
        countInteractiveSessionEvents(env, id),
        db
          .selectFrom("interactive_sessions")
          .select("updated_at")
          .where("id", "=", id)
          .executeTakeFirst(),
      ]);
      return {
        eventCount,
        archiveEventCount: currentArchive?.event_count ?? null,
        archiveSessionVersionMatches:
          currentArchive?.session_updated_at === currentSession?.updated_at,
        archiveObjectsReady: Boolean(
          !env.SESSION_LOGS ||
          (currentArchive?.events_key &&
            currentArchive.transcript_key &&
            currentArchive.summary_key),
        ),
      };
    },
    archive: () => archiveInteractiveSessionLogs(env, id, now, { force: true }),
    clearPending: async () => {
      const cleared = await terminalFinalizationClearPendingQuery(
        id,
        status,
        Boolean(env.SESSION_LOGS),
      ).execute(db);
      if ((cleared.numAffectedRows ?? 0n) > 0n) return true;
      const current = await db
        .selectFrom("interactive_sessions")
        .select("terminal_finalize_pending")
        .where("id", "=", id)
        .executeTakeFirst();
      return !current || current.terminal_finalize_pending === 0;
    },
  });
}
