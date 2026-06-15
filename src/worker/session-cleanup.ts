import { sql, type RawBuilder, type Selectable } from "kysely";

import {
  database,
  executeBatch,
  type InteractiveSessionLogArchiveTable,
  type InteractiveSessionRow,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import { cleanupSessionLogArchiveObjects } from "./session-log-archive.ts";

const terminalCleanupDeletePending = 2;
type SessionReference = string | RawBuilder<unknown>;

function hasNoCredentialPolicy(sessionId: SessionReference): RawBuilder<boolean> {
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
    )
  `;
}

function hasNoActiveDescendants(sessionId: SessionReference): RawBuilder<boolean> {
  return sql<boolean>`
    NOT EXISTS (
      WITH RECURSIVE active_ancestor(id) AS (
        SELECT parent_session_id
        FROM interactive_sessions
        WHERE status NOT IN ('stopped', 'expired', 'failed')
          AND parent_session_id IS NOT NULL
        UNION
        SELECT session.parent_session_id
        FROM interactive_sessions AS session
        JOIN active_ancestor ON session.id = active_ancestor.id
        WHERE session.parent_session_id IS NOT NULL
      )
      SELECT 1
      FROM active_ancestor
      WHERE id = ${sessionId}
    )
  `;
}

function archiveCoversAllEvents(sessionId: SessionReference): RawBuilder<boolean> {
  return sql<boolean>`
    COALESCE(
      (
        SELECT event_count
        FROM interactive_session_log_archives
        WHERE session_id = ${sessionId}
      ),
      -1
    ) >= (
      SELECT count(*)
      FROM interactive_session_events
      WHERE session_id = ${sessionId}
    )
  `;
}

function archiveObjectsAreComplete(
  sessionId: SessionReference,
  sessionLogsEnabled: boolean,
): RawBuilder<boolean> {
  return sql<boolean>`
    ${sessionLogsEnabled ? 1 : 0} = 0
    OR EXISTS (
      SELECT 1
      FROM interactive_session_log_archives
      WHERE session_id = ${sessionId}
        AND events_key IS NOT NULL
        AND transcript_key IS NOT NULL
        AND summary_key IS NOT NULL
    )
  `;
}

export type InteractiveSessionCleanupCandidate = {
  row: InteractiveSessionRow;
  archive: Selectable<InteractiveSessionLogArchiveTable> | undefined;
};

export type InteractiveSessionCleanupStore = {
  readCandidates(ids: readonly string[]): Promise<InteractiveSessionCleanupCandidate[]>;
  deleteCandidate(candidate: InteractiveSessionCleanupCandidate): Promise<boolean>;
  cleanupArchive(archive: Selectable<InteractiveSessionLogArchiveTable> | undefined): Promise<void>;
  reportArchiveCleanupFailure(sessionId: string, error: unknown): void;
};

export class InteractiveSessionCleanupService {
  private readonly store: InteractiveSessionCleanupStore;

  constructor(store: InteractiveSessionCleanupStore) {
    this.store = store;
  }

  async cleanup(
    ids: readonly string[],
    canManage: (row: InteractiveSessionRow) => boolean,
  ): Promise<string[]> {
    const candidates = (await this.store.readCandidates(ids)).filter(({ row }) => canManage(row));
    return (
      await Promise.all(
        candidates.map(async (candidate) => {
          if (!(await this.store.deleteCandidate(candidate))) return null;
          await this.store.cleanupArchive(candidate.archive).catch((error) => {
            this.store.reportArchiveCleanupFailure(candidate.row.id, error);
          });
          return candidate.row.id;
        }),
      )
    ).filter((id): id is string => Boolean(id));
  }
}

export function createInteractiveSessionCleanupService(
  env: RuntimeEnv,
  reportArchiveCleanupFailure: (sessionId: string, error: unknown) => void = (sessionId, error) => {
    console.error(`session archive object cleanup leaked for ${sessionId}`, error);
  },
): InteractiveSessionCleanupService {
  return new InteractiveSessionCleanupService({
    readCandidates: (ids) => readInteractiveSessionCleanupCandidates(env, ids),
    deleteCandidate: ({ row, archive }) => deleteFinalizedInteractiveSession(env, row, archive),
    cleanupArchive: (archive) => cleanupSessionLogArchiveObjects(env, archive),
    reportArchiveCleanupFailure,
  });
}

export async function readInteractiveSessionCleanupCandidates(
  env: RuntimeEnv,
  ids: readonly string[],
): Promise<InteractiveSessionCleanupCandidate[]> {
  const db = database(env);
  let query = db
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("status", "in", deadInteractiveSessionStatuses)
    .where("terminal_finalize_pending", "=", 0)
    .where(hasNoCredentialPolicy(sql.ref("interactive_sessions.id")))
    .where(archiveCoversAllEvents(sql.ref("interactive_sessions.id")))
    .where(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM interactive_session_log_archives AS archive
        WHERE archive.session_id = interactive_sessions.id
          AND archive.session_updated_at = interactive_sessions.updated_at
      )
    `)
    .where(hasNoActiveDescendants(sql.ref("interactive_sessions.id")))
    .where(
      archiveObjectsAreComplete(sql.ref("interactive_sessions.id"), Boolean(env.SESSION_LOGS)),
    );
  if (ids.length) query = query.where("id", "in", ids);
  const rows = await query.execute();
  return Promise.all(
    rows.map(async (row) => ({
      row,
      archive: await db
        .selectFrom("interactive_session_log_archives")
        .selectAll()
        .where("session_id", "=", row.id)
        .executeTakeFirst(),
    })),
  );
}

export async function deleteFinalizedInteractiveSession(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  archive: Selectable<InteractiveSessionLogArchiveTable> | undefined,
): Promise<boolean> {
  const db = database(env);
  const claimToken = `cleanup:${crypto.randomUUID()}`;
  const finalClaim = db
    .updateTable("interactive_sessions")
    .set({
      terminal_finalize_pending: terminalCleanupDeletePending,
      reconcile_error: claimToken,
    })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("updated_at", "=", row.updated_at)
    .where("terminal_finalize_pending", "=", 0)
    .where(hasNoCredentialPolicy(row.id))
    .where(hasNoActiveDescendants(row.id))
    .where(sql<boolean>`
      ${archive ? 1 : 0} = 1
        AND EXISTS (
          SELECT 1
          FROM interactive_session_log_archives
          WHERE session_id = ${row.id}
            AND event_count = ${archive?.event_count ?? -1}
            AND session_updated_at IS ${archive?.session_updated_at ?? null}
            AND session_updated_at = ${row.updated_at}
            AND events_key IS ${archive?.events_key ?? null}
            AND transcript_key IS ${archive?.transcript_key ?? null}
            AND summary_key IS ${archive?.summary_key ?? null}
            AND archived_at = ${archive?.archived_at ?? -1}
            AND updated_at = ${archive?.updated_at ?? -1}
        )
    `)
    .where(archiveCoversAllEvents(row.id))
    .where(archiveObjectsAreComplete(row.id, Boolean(env.SESSION_LOGS)));
  const ownsFinalClaim = sql<boolean>`EXISTS (
    SELECT 1
    FROM interactive_sessions
    WHERE id = ${row.id}
      AND status = ${row.status}
      AND updated_at = ${row.updated_at}
      AND terminal_finalize_pending = ${terminalCleanupDeletePending}
      AND reconcile_error = ${claimToken}
  )`;
  // D1 batches are transactional, so no event can interleave between the claim and row deletes.
  await executeBatch(env, [
    finalClaim,
    db
      .deleteFrom("interactive_session_events")
      .where("session_id", "=", row.id)
      .where(ownsFinalClaim),
    db
      .deleteFrom("interactive_session_log_archives")
      .where("session_id", "=", row.id)
      .where(ownsFinalClaim),
    db
      .deleteFrom("interactive_sessions")
      .where("id", "=", row.id)
      .where("status", "=", row.status)
      .where("updated_at", "=", row.updated_at)
      .where("terminal_finalize_pending", "=", terminalCleanupDeletePending)
      .where("reconcile_error", "=", claimToken),
  ]);
  const current = await db
    .selectFrom("interactive_sessions")
    .select("id")
    .where("id", "=", row.id)
    .executeTakeFirst();
  return !current;
}
