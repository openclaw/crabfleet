import { sql } from "kysely";

import { allocateInteractiveSessionIdSql, formatInteractiveSessionId } from "../session-id.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

const maximumAllocationAttempts = 100;

export async function nextInteractiveSessionId(env: RuntimeEnv): Promise<string> {
  const db = database(env);
  for (let attempt = 0; attempt < maximumAllocationAttempts; attempt += 1) {
    const result = await sql.raw<{ next_id: number }>(allocateInteractiveSessionIdSql).execute(db);
    const id = formatInteractiveSessionId(Number(result.rows[0]?.next_id));
    if (!id) throw new Error("failed to allocate interactive session id");
    const standalone = await db
      .selectFrom("standalone_sandbox_provisions")
      .select("id")
      .where(sql<boolean>`id = ${id} COLLATE NOCASE`)
      .executeTakeFirst();
    if (!standalone) return id;
  }
  throw new Error("failed to allocate an unreserved interactive session id");
}
