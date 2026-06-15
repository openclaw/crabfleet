import { sql, type RawBuilder } from "kysely";

import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";

export function sandboxLookupIds(env: RuntimeEnv, sandboxId: string): string[] {
  const ids = new Set([sandboxId]);
  if (env.SANDBOX) ids.add(env.SANDBOX.idFromName(sandboxId).toString());
  return [...ids];
}

export function activeSandboxCredentialPolicyCondition(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  generation: string,
  updatedAt?: number,
): RawBuilder<boolean> {
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const updatedAtCondition =
    updatedAt === undefined ? sql<boolean>`1 = 1` : sql<boolean>`updated_at = ${updatedAt}`;
  return sql<boolean>`
    (
      SELECT count(DISTINCT lookup_id)
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND lookup_id IN (${sql.join(lookupIds)})
        AND state = 'active'
        AND registration_generation = ${generation}
        AND registration_claim IS NULL
        AND ${updatedAtCondition}
    ) = ${lookupIds.length}
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND (
          state != 'active'
          OR registration_generation != ${generation}
          OR registration_claim IS NOT NULL
          OR NOT (${updatedAtCondition})
        )
    )
  `;
}

export async function activeSandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string | null> {
  const rows = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  const expected = sandboxLookupIds(env, sandboxId);
  const generation = rows[0]?.registration_generation;
  if (
    !generation ||
    !expected.every((lookupId) =>
      rows.some(
        (row) =>
          row.lookup_id === lookupId &&
          row.state === "active" &&
          row.registration_generation === generation &&
          row.registration_claim === null,
      ),
    ) ||
    rows.some(
      (row) =>
        row.state !== "active" ||
        row.registration_generation !== generation ||
        row.registration_claim !== null,
    )
  ) {
    return null;
  }
  return generation;
}
