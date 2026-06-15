import type { Insertable } from "kysely";

import {
  database,
  executeBatch,
  type InteractiveSessionRow,
  type InteractiveSessionTable,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

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
