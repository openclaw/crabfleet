import { sql } from "kysely";

import { parseGitHubActionsWorkState } from "../github-actions-runtime.ts";
import { obsoleteSessionArchiveObjectKeys, sessionArchiveAttemptKeys } from "../session-archive.ts";
import {
  database,
  type InteractiveSessionLogArchiveTable,
  type InteractiveSessionRow,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  interactiveSessionEvent,
  type InteractiveSession,
  type InteractiveSessionEventRow,
} from "./session-model.ts";
import {
  countInteractiveSessionEvents,
  readInteractiveSessionEventRows,
} from "./session-repository.ts";

export async function archiveInteractiveSessionLogs(
  env: RuntimeEnv,
  id: string,
  now = Date.now(),
  options: { force?: boolean } = {},
): Promise<void> {
  const db = database(env);
  const [sessionRow, currentArchive, eventCount] = await Promise.all([
    db.selectFrom("interactive_sessions").selectAll().where("id", "=", id).executeTakeFirst(),
    db
      .selectFrom("interactive_session_log_archives")
      .selectAll()
      .where("session_id", "=", id)
      .executeTakeFirst(),
    countInteractiveSessionEvents(env, id),
  ]);
  if (!sessionRow) return;
  if (!shouldArchiveInteractiveSessionLogs(currentArchive, eventCount, now, options.force)) {
    return;
  }
  const events = await readInteractiveSessionEventRows(env, id);
  const latestEventAt = events.at(-1)?.created_at ?? now;
  const attemptedArchive = sessionArchiveAttemptKeys(
    sessionLogArchiveBase(id),
    events.length,
    latestEventAt,
    now,
    crypto.randomUUID(),
  );
  const eventsKey = attemptedArchive.events_key;
  const transcriptKey = attemptedArchive.transcript_key;
  const summaryKey = attemptedArchive.summary_key;
  if (env.SESSION_LOGS) {
    await Promise.all([
      env.SESSION_LOGS.put(eventsKey, sessionLogEventsNdjson(events), {
        httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" },
      }),
      env.SESSION_LOGS.put(transcriptKey, sessionLogTranscript(sessionRow, events), {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
      env.SESSION_LOGS.put(
        summaryKey,
        JSON.stringify(sessionLogSummary(sessionRow, events), null, 2),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      ),
    ]);
  }
  await sql`
    INSERT INTO interactive_session_log_archives (
      session_id,
      event_count,
      session_updated_at,
      events_key,
      transcript_key,
      summary_key,
      archived_at,
      updated_at
    )
    VALUES (
      ${id},
      ${events.length},
      ${sessionRow.updated_at},
      ${env.SESSION_LOGS ? eventsKey : null},
      ${env.SESSION_LOGS ? transcriptKey : null},
      ${env.SESSION_LOGS ? summaryKey : null},
      ${now},
      ${now}
    )
    ON CONFLICT(session_id) DO UPDATE SET
      event_count = excluded.event_count,
      session_updated_at = excluded.session_updated_at,
      events_key = excluded.events_key,
      transcript_key = excluded.transcript_key,
      summary_key = excluded.summary_key,
      updated_at = excluded.updated_at
    WHERE excluded.event_count > interactive_session_log_archives.event_count
      OR (
        excluded.event_count = interactive_session_log_archives.event_count
        AND (
          (
            excluded.session_updated_at IS NOT NULL
            AND interactive_session_log_archives.session_updated_at IS NULL
          )
          OR (
            excluded.session_updated_at > interactive_session_log_archives.session_updated_at
          )
          OR (
            excluded.session_updated_at IS interactive_session_log_archives.session_updated_at
            AND (
              interactive_session_log_archives.events_key IS NULL
              OR interactive_session_log_archives.transcript_key IS NULL
              OR interactive_session_log_archives.summary_key IS NULL
              OR excluded.updated_at >= interactive_session_log_archives.updated_at
            )
          )
        )
      )
  `.execute(db);
  if (!env.SESSION_LOGS) return;
  const latestArchive = await db
    .selectFrom("interactive_session_log_archives")
    .selectAll()
    .where("session_id", "=", id)
    .executeTakeFirst();
  await cleanupSessionLogArchiveObjects(
    env,
    obsoleteSessionArchiveObjectKeys(latestArchive, currentArchive, attemptedArchive),
  );
}

export function shouldArchiveInteractiveSessionLogs(
  current: InteractiveSessionLogArchiveTable | undefined,
  eventCount: number,
  now: number,
  force = false,
): boolean {
  if (force) return true;
  if (!current) return true;
  if (eventCount < current.event_count) return false;
  if (eventCount <= 2 && eventCount > current.event_count) return true;
  if (eventCount >= current.event_count + 20) return true;
  return now >= current.updated_at + 60_000;
}

export async function cleanupSessionLogArchiveObjects(
  env: RuntimeEnv,
  archive:
    | Pick<InteractiveSessionLogArchiveTable, "events_key" | "transcript_key" | "summary_key">
    | undefined,
): Promise<void> {
  if (!env.SESSION_LOGS || !archive) return;
  const keys = [archive.events_key, archive.transcript_key, archive.summary_key].filter(
    (key): key is string => Boolean(key),
  );
  if (!keys.length) return;
  await Promise.all(keys.map((key) => env.SESSION_LOGS?.delete(key)));
}

export function sessionLogArchiveBase(id: string): string {
  return `orgs/openclaw/interactive-sessions/${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

export function sessionLogEventsNdjson(events: InteractiveSessionEventRow[]): string {
  return events.map((row) => JSON.stringify(interactiveSessionEvent(row))).join("\n") + "\n";
}

export function sessionLogTranscript(
  session: InteractiveSession | InteractiveSessionRow,
  events: InteractiveSessionEventRow[],
): string {
  const parentSessionId =
    "parentSessionId" in session ? session.parentSessionId : session.parent_session_id;
  const rootSessionId =
    "rootSessionId" in session ? session.rootSessionId : session.root_session_id;
  const createdBy = "createdBy" in session ? session.createdBy : session.created_by;
  const lines = [
    `# ${session.id}`,
    "",
    `repo: ${session.repo}`,
    `branch: ${session.branch}`,
    `runtime: ${session.runtime}`,
    `owner: ${session.owner}`,
    `created_by: ${createdBy}`,
    `parent: ${parentSessionId ?? "none"}`,
    `root: ${rootSessionId ?? session.id}`,
    `status: ${session.status}`,
    ...("workKey" in session
      ? [
          `work_key: ${session.workKey ?? "none"}`,
          `work_kind: ${session.workKind ?? "none"}`,
          `work_state: ${session.workState ?? "none"}`,
          `work_phase: ${session.workPhase || "none"}`,
          `source_url: ${session.sourceUrl ?? "none"}`,
          `github_run_url: ${session.githubRunUrl ?? "none"}`,
          `codex_thread_id: ${session.codexThreadId ?? "none"}`,
          `codex_turn_id: ${session.codexTurnId ?? "none"}`,
          `last_heartbeat_at: ${session.lastHeartbeatAt ?? "none"}`,
          `completion_reason: ${session.completionReason ?? "none"}`,
        ]
      : [
          `work_key: ${session.work_key ?? "none"}`,
          `work_kind: ${session.work_kind ?? "none"}`,
          `work_state: ${session.work_state || "none"}`,
          `work_phase: ${session.work_phase || "none"}`,
          `source_url: ${session.source_url ?? "none"}`,
          `github_run_url: ${session.github_run_url ?? "none"}`,
          `codex_thread_id: ${session.codex_thread_id ?? "none"}`,
          `codex_turn_id: ${session.codex_turn_id ?? "none"}`,
          `last_heartbeat_at: ${session.last_heartbeat_at ?? "none"}`,
          `completion_reason: ${session.completion_reason ?? "none"}`,
        ]),
    `purpose: ${session.purpose}`,
    `summary: ${session.summary}`,
    "",
    "## Events",
    "",
  ];
  for (const event of events) {
    lines.push(`- ${new Date(event.created_at).toISOString()} ${event.actor}: ${event.message}`);
  }
  return `${lines.join("\n")}\n`;
}

export function sessionLogSummary(
  session: InteractiveSessionRow,
  events: InteractiveSessionEventRow[],
): Record<string, unknown> {
  return {
    id: session.id,
    parentSessionId: session.parent_session_id,
    rootSessionId: session.root_session_id ?? session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    owner: session.owner,
    createdBy: session.created_by,
    purpose: session.purpose,
    summary: session.summary,
    status: session.status,
    workKey: session.work_key,
    workKind: session.work_kind,
    workState: parseGitHubActionsWorkState(session.work_state),
    workPhase: session.work_phase,
    sourceUrl: session.source_url,
    githubRunUrl: session.github_run_url,
    codexThreadId: session.codex_thread_id,
    codexTurnId: session.codex_turn_id,
    lastHeartbeatAt: session.last_heartbeat_at,
    completionReason: session.completion_reason,
    eventCount: events.length,
    firstEventAt: events[0]?.created_at ?? null,
    lastEventAt: events.at(-1)?.created_at ?? null,
    lastEvent: events.at(-1)?.message ?? session.last_event,
    updatedAt: session.updated_at,
  };
}
