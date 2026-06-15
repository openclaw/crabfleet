import { database, executeBatch } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { archiveInteractiveSessionLogs } from "./session-log-archive.ts";
import { terminalFinalizationPendingQuery } from "./session-terminal-finalization.ts";

export type AppendInteractiveSessionEventInput = {
  sessionId: string;
  actor: string;
  message: string;
  now: number;
};

export type InteractiveSessionEventArchive = (sessionId: string, now: number) => Promise<void>;

export async function appendInteractiveSessionEventRecord(
  env: RuntimeEnv,
  input: AppendInteractiveSessionEventInput,
  archive: InteractiveSessionEventArchive = (sessionId, now) =>
    archiveInteractiveSessionLogs(env, sessionId, now),
): Promise<void> {
  const db = database(env);
  await executeBatch(env, [
    db.insertInto("interactive_session_events").values({
      session_id: input.sessionId,
      actor: input.actor,
      message: clean(input.message, 1000),
      created_at: input.now,
    }),
    terminalFinalizationPendingQuery(db, input.sessionId),
  ]);
  await archive(input.sessionId, input.now).catch(() => undefined);
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
