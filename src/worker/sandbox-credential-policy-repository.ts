import { sql, type RawBuilder } from "kysely";

import { runtimeAdapterName } from "../runtime-adapter.ts";
import {
  credentialPolicyLegacyGenerationPrefix,
  credentialPolicyLegacyRepairClaimPrefix,
  type SandboxCredentialPolicyRegistration,
} from "./session-control-policy.ts";
import { database, executeBatch, type CompilableQuery } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  type SandboxCurrentLeaseFence,
  type SandboxLeaseRefreshFence,
  type StandaloneSandboxProvisionFence,
  sandboxLeasePrefix,
} from "./sandbox-lease.ts";

const credentialPolicyRegistrationClaimMs = 60_000;

export type SandboxManagedOwnershipFence = SandboxCurrentLeaseFence | SandboxLeaseRefreshFence;

export type SandboxCredentialPolicyOwnershipFence =
  | SandboxManagedOwnershipFence
  | StandaloneSandboxProvisionFence;

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

export function sandboxCredentialPolicyRefQueries(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  state: "registering" | "active" | "cleanup_pending",
  generation: string,
  now: number,
  authorizationCondition: RawBuilder<boolean>,
): CompilableQuery[] {
  return sandboxLookupIds(env, sandboxId).map(
    (lookupId) => sql`
    INSERT INTO interactive_session_credential_policies (
      session_id,
      sandbox_id,
      lookup_id,
      state,
      registration_generation,
      registration_claim,
      registration_claim_expires_at,
      attempt_count,
      last_attempt_at,
      last_error,
      cleanup_claim,
      cleanup_claim_expires_at,
      created_at,
      updated_at
    ) SELECT
      ${sessionId},
      ${sandboxId},
      ${lookupId},
      ${state},
      ${generation},
      NULL,
      NULL,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      ${now},
      ${now}
    WHERE ${authorizationCondition}
    ON CONFLICT(session_id, sandbox_id, lookup_id) DO UPDATE SET
      state = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR excluded.state = 'cleanup_pending'
        THEN 'cleanup_pending'
        WHEN interactive_session_credential_policies.registration_claim IS NOT NULL
        THEN interactive_session_credential_policies.state
        ELSE excluded.state
      END,
      last_error = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.last_error
        ELSE NULL
      END,
      cleanup_claim = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.cleanup_claim
        ELSE NULL
      END,
      cleanup_claim_expires_at = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.cleanup_claim_expires_at
        ELSE NULL
      END,
      updated_at = excluded.updated_at
  `,
  );
}

export function sandboxCredentialPolicyCleanupAuthorizedCondition(
  sessionId: string,
  sandboxId: string,
  now: number,
): RawBuilder<boolean> {
  const leasePrefix = `${sandboxLeasePrefix}${sandboxId}`;
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM standalone_sandbox_provisions AS owner
      WHERE owner.id = ${sessionId}
        AND owner.sandbox_id = ${sandboxId}
        AND (
          owner.state = 'active'
          OR (
            owner.state = 'provisioning'
            AND owner.ownership_claim IS NOT NULL
            AND owner.ownership_claim_expires_at > ${now}
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_sessions AS session
      WHERE session.id = ${sessionId}
        AND (session.adapter IS NULL OR session.adapter != ${runtimeAdapterName})
        AND session.status IN ('provisioning', 'pending_adapter', 'ready', 'attached', 'detached')
        AND session.credential_cleanup_terminal_status IS NULL
        AND session.agent_token_hash IS NOT NULL
        AND (
          (
            session.lease_id IS NOT NULL
            AND substr(session.lease_id, 1, ${leasePrefix.length}) = ${leasePrefix}
            AND (
              length(session.lease_id) = ${leasePrefix.length}
              OR substr(session.lease_id, ${leasePrefix.length + 1}, 1) = ':'
            )
          )
          OR (
            session.sandbox_refresh_sandbox_id = ${sandboxId}
            AND session.sandbox_refresh_claim IS NOT NULL
            AND session.sandbox_refresh_claim_expires_at > ${now}
          )
        )
    )
  `;
}

export async function sandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string> {
  return (
    (await existingSandboxCredentialPolicyGeneration(env, sessionId, sandboxId)) ??
    `generation:${crypto.randomUUID()}`
  );
}

export async function existingSandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string | null> {
  const existing = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select("registration_generation")
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .orderBy("lookup_id", "asc")
    .executeTakeFirst();
  return existing?.registration_generation ?? null;
}

export async function queueSandboxCredentialPolicyCleanup(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  now = Date.now(),
): Promise<void> {
  const generation = await sandboxCredentialPolicyGeneration(env, sessionId, sandboxId);
  await executeBatch(
    env,
    sandboxCredentialPolicyRefQueries(
      env,
      sessionId,
      sandboxId,
      "cleanup_pending",
      generation,
      now,
      sandboxCredentialPolicyCleanupAuthorizedCondition(sessionId, sandboxId, now),
    ),
  );
}

export function sandboxManagedOwnershipCondition(
  ownershipFence: SandboxManagedOwnershipFence,
  now: number,
): RawBuilder<boolean> {
  if ("leaseId" in ownershipFence) {
    return sql<boolean>`
      lease_id = ${ownershipFence.leaseId}
      AND sandbox_refresh_sandbox_id IS NULL
      AND sandbox_refresh_claim IS NULL
      AND sandbox_refresh_claim_expires_at IS NULL
    `;
  }
  return sql<boolean>`
    lease_id IS ${ownershipFence.refreshLeaseId}
    AND sandbox_refresh_sandbox_id = ${ownershipFence.sandboxId}
    AND sandbox_refresh_claim = ${ownershipFence.claim}
    AND sandbox_refresh_claim_expires_at > ${now}
  `;
}

export function sandboxManagedStoredOwnershipCondition(
  ownershipFence: SandboxManagedOwnershipFence,
): RawBuilder<boolean> {
  if ("leaseId" in ownershipFence) {
    return sql<boolean>`
      lease_id = ${ownershipFence.leaseId}
      AND sandbox_refresh_sandbox_id IS NULL
      AND sandbox_refresh_claim IS NULL
      AND sandbox_refresh_claim_expires_at IS NULL
    `;
  }
  return sql<boolean>`
    lease_id IS ${ownershipFence.refreshLeaseId}
    AND sandbox_refresh_sandbox_id = ${ownershipFence.sandboxId}
    AND sandbox_refresh_claim = ${ownershipFence.claim}
    AND sandbox_refresh_claim_expires_at = ${ownershipFence.expiresAt}
  `;
}

export function sandboxCredentialPolicyOwnerCondition(
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now: number,
): RawBuilder<boolean> {
  if ("provisionId" in ownershipFence) {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM standalone_sandbox_provisions AS owner
      WHERE owner.id = ${sessionId}
        AND owner.id = ${ownershipFence.provisionId}
        AND owner.sandbox_id = ${sandboxId}
        AND owner.sandbox_id = ${ownershipFence.sandboxId}
        AND owner.state = 'provisioning'
        AND owner.ownership_claim = ${ownershipFence.claim}
        AND owner.ownership_claim_expires_at > ${now}
    )`;
  }
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM interactive_sessions
    WHERE id = ${sessionId}
      AND ${sandboxId} = ${ownershipFence.sandboxId}
      AND (adapter IS NULL OR adapter != ${runtimeAdapterName})
      AND status IN ('provisioning', 'pending_adapter', 'ready', 'attached', 'detached')
      AND credential_cleanup_terminal_status IS NULL
      AND agent_token_hash IS NOT NULL
      AND ${sandboxManagedOwnershipCondition(ownershipFence, now)}
  )`;
}

export function sandboxCredentialPolicyRegistrationQueries(
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  registrationExpiresAt: number,
  now: number,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): CompilableQuery[] {
  return registration.lookupIds.map(
    (lookupId) => sql`
      INSERT INTO interactive_session_credential_policies (
        session_id,
        sandbox_id,
        lookup_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        attempt_count,
        last_attempt_at,
        last_error,
        cleanup_claim,
        cleanup_claim_expires_at,
        created_at,
        updated_at
      )
      SELECT
        ${sessionId},
        ${sandboxId},
        ${lookupId},
        'registering',
        ${registration.generation},
        ${registration.claim},
        ${registrationExpiresAt},
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        ${now},
        ${now}
      WHERE ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
      ON CONFLICT(session_id, sandbox_id, lookup_id) DO UPDATE SET
        state = 'registering',
        registration_generation = excluded.registration_generation,
        registration_claim = excluded.registration_claim,
        registration_claim_expires_at = excluded.registration_claim_expires_at,
        last_error = NULL,
        cleanup_claim = NULL,
        cleanup_claim_expires_at = NULL,
        updated_at = excluded.updated_at
      WHERE interactive_session_credential_policies.state != 'cleanup_pending'
        AND (
          interactive_session_credential_policies.registration_claim IS NULL
          OR interactive_session_credential_policies.registration_claim_expires_at <= ${now}
        )
        AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
    `,
  );
}

export async function beginSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<SandboxCredentialPolicyRegistration> {
  const db = database(env);
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const existing = await db
    .selectFrom("interactive_session_credential_policies")
    .select("registration_generation")
    .distinct()
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  if (existing.length > 1) {
    throw new Error("sandbox credential policy generations are inconsistent");
  }
  const registration = {
    generation: existing[0]?.registration_generation ?? `generation:${crypto.randomUUID()}`,
    claim: `registration:${crypto.randomUUID()}`,
    lookupIds,
  };
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  await executeBatch(
    env,
    sandboxCredentialPolicyRegistrationQueries(
      sessionId,
      sandboxId,
      registration,
      registrationExpiresAt,
      now,
      ownershipFence,
    ),
  );
  const claimed = await db
    .selectFrom("interactive_session_credential_policies")
    .select([
      "lookup_id",
      "state",
      "registration_generation",
      "registration_claim",
      "registration_claim_expires_at",
    ])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  if (
    claimed.length !== lookupIds.length ||
    claimed.some(
      (row) =>
        row.state !== "registering" ||
        row.registration_generation !== registration.generation ||
        row.registration_claim !== registration.claim ||
        row.registration_claim_expires_at !== registrationExpiresAt,
    )
  ) {
    await abandonSandboxCredentialPolicyRegistration(
      env,
      sessionId,
      sandboxId,
      registration,
      "sandbox credential policy registration claim was not acquired",
    );
    throw new Error("sandbox credential policy registration is unavailable");
  }
  return registration;
}

export async function beginLegacySandboxCredentialPolicyRepair(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCurrentLeaseFence,
): Promise<SandboxCredentialPolicyRegistration> {
  const db = database(env);
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const existing = await db
    .selectFrom("interactive_session_credential_policies")
    .select(["registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  const generations = [...new Set(existing.map((row) => row.registration_generation))];
  const existingGeneration = generations[0];
  if (!existingGeneration || generations.length !== 1) {
    throw new Error("legacy sandbox credential policy generations are inconsistent");
  }
  const resuming = existing.some((row) =>
    row.registration_claim?.startsWith(credentialPolicyLegacyRepairClaimPrefix),
  );
  if (!existingGeneration.startsWith(credentialPolicyLegacyGenerationPrefix) && !resuming) {
    throw new Error("legacy sandbox credential policy repair is not pending");
  }
  const registration: SandboxCredentialPolicyRegistration = {
    generation: existingGeneration.startsWith(credentialPolicyLegacyGenerationPrefix)
      ? `generation:${crypto.randomUUID()}`
      : existingGeneration,
    claim: `${credentialPolicyLegacyRepairClaimPrefix}${crypto.randomUUID()}`,
    lookupIds,
  };
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  await executeBatch(
    env,
    sandboxCredentialPolicyRegistrationQueries(
      sessionId,
      sandboxId,
      registration,
      registrationExpiresAt,
      now,
      ownershipFence,
    ),
  );
  const claimed = await db
    .selectFrom("interactive_session_credential_policies")
    .select([
      "lookup_id",
      "state",
      "registration_generation",
      "registration_claim",
      "registration_claim_expires_at",
    ])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  if (
    claimed.length !== lookupIds.length ||
    claimed.some(
      (row) =>
        row.state !== "registering" ||
        row.registration_generation !== registration.generation ||
        row.registration_claim !== registration.claim ||
        row.registration_claim_expires_at !== registrationExpiresAt,
    )
  ) {
    throw new Error("legacy sandbox credential policy repair claim was not acquired");
  }
  return registration;
}

export async function renewSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<number | null> {
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  const renewed = await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      registration_claim_expires_at: registrationExpiresAt,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .executeTakeFirst();
  return Number(renewed.numUpdatedRows ?? 0n) === registration.lookupIds.length
    ? registrationExpiresAt
    : null;
}

export async function finishSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<boolean> {
  const now = Date.now();
  const db = database(env);
  await db
    .updateTable("interactive_session_credential_policies")
    .set({
      state: "active",
      registration_claim: null,
      registration_claim_expires_at: null,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .execute();
  const active = await db
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .execute();
  return (
    active.length === registration.lookupIds.length &&
    active.every(
      (row) =>
        row.state === "active" &&
        row.registration_generation === registration.generation &&
        row.registration_claim === null,
    )
  );
}

export async function abandonSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  reason: string,
): Promise<void> {
  const now = Date.now();
  await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      state: sql<"registering" | "cleanup_pending">`CASE
        WHEN ${sandboxCredentialPolicyCleanupAuthorizedCondition(sessionId, sandboxId, now)}
        THEN 'cleanup_pending'
        ELSE 'registering'
      END`,
      registration_claim: null,
      registration_claim_expires_at: null,
      last_error: reason,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .execute();
}

export async function standaloneSandboxPolicyExpiresAt(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  fence: StandaloneSandboxProvisionFence,
): Promise<number | null> {
  const now = Date.now();
  const owner = await database(env)
    .selectFrom("standalone_sandbox_provisions")
    .select("expires_at")
    .where("id", "=", sessionId)
    .where("id", "=", fence.provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("sandbox_id", "=", fence.sandboxId)
    .where("state", "=", "provisioning")
    .where("ownership_claim", "=", fence.claim)
    .where("ownership_claim_expires_at", ">", now)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return owner?.expires_at ?? null;
}

export async function recordSandboxCredentialPolicyRefs(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  state: "registering" | "active" | "cleanup_pending",
  generation: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now = Date.now(),
): Promise<boolean> {
  const lookupIds = sandboxLookupIds(env, sandboxId);
  if (state === "active") {
    await promoteSandboxCredentialPolicyRegistration(
      env,
      sessionId,
      sandboxId,
      generation,
      ownershipFence,
      now,
    );
  }
  await executeBatch(
    env,
    sandboxCredentialPolicyRefQueries(
      env,
      sessionId,
      sandboxId,
      state,
      generation,
      now,
      sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now),
    ),
  );
  const refs = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  return (
    refs.length === lookupIds.length &&
    refs.every(
      (ref) =>
        ref.state === state &&
        ref.registration_generation === generation &&
        ref.registration_claim === null,
    )
  );
}

export async function promoteSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  generation: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now: number,
): Promise<void> {
  await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      state: "active",
      registration_claim: null,
      registration_claim_expires_at: null,
      last_error: null,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", sandboxLookupIds(env, sandboxId))
    .where("state", "=", "registering")
    .where("registration_generation", "=", generation)
    .where((expression) =>
      expression.or([
        expression("registration_claim", "is", null),
        expression("registration_claim_expires_at", "<=", now),
      ]),
    )
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .execute();
}
