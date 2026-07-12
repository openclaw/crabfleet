import { sql, type RawBuilder } from "kysely";

import { isCurrentCredentialPolicyGeneration } from "../credential-policy-fence.ts";
import { runtimeAdapterName } from "../runtime-adapter.ts";
import {
  type SandboxCredentialPolicy,
  type SandboxCredentialPolicyRegistration,
} from "./session-control-policy.ts";
import type { SandboxCredentialPolicyRollbackRecord } from "./sandbox-credential-policy-rollback.ts";
import { database, executeBatch, type CompilableQuery } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  type SandboxCurrentLeaseFence,
  type SandboxLeaseRefreshFence,
  type StandaloneSandboxProvisionFence,
  sandboxLeasePrefix,
} from "./sandbox-lease.ts";

const credentialPolicyRegistrationClaimMs = 60_000;

function newSandboxCredentialPolicyGeneration(): string {
  return `generation:${crypto.randomUUID()}`;
}

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
    !isCurrentCredentialPolicyGeneration(generation) ||
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

export async function incompleteSandboxCredentialPolicyGeneration(
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
  const expected = new Set(sandboxLookupIds(env, sandboxId));
  const generation = rows[0]?.registration_generation;
  if (
    rows.length === 0 ||
    !isCurrentCredentialPolicyGeneration(generation) ||
    !rows.some((row) => row.lookup_id === sandboxId) ||
    rows.some(
      (row) =>
        row.state !== "active" ||
        row.registration_generation !== generation ||
        row.registration_claim !== null,
    ) ||
    (rows.length === expected.size && rows.every((row) => expected.has(row.lookup_id)))
  ) {
    return null;
  }
  return generation;
}

export async function sandboxCredentialPolicyLookupIdsForGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  generation: string,
): Promise<string[]> {
  const rows = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select("lookup_id")
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "active")
    .where("registration_generation", "=", generation)
    .where("registration_claim", "is", null)
    .orderBy("lookup_id")
    .execute();
  return rows.map((row) => row.lookup_id);
}

export async function sandboxCredentialPolicyPersistedLookupIds(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string[]> {
  const rows = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select("lookup_id")
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .orderBy("lookup_id")
    .execute();
  return rows.map((row) => row.lookup_id);
}

export async function sandboxCredentialPolicyHasDurableOwner(
  env: RuntimeEnv,
  lookupId: string,
  generation: string,
  policy: SandboxCredentialPolicy,
  now: number,
): Promise<boolean> {
  if (
    !generation ||
    policy.sandboxId !== lookupId ||
    typeof policy.sessionId !== "string" ||
    !policy.sessionId ||
    !Array.isArray(policy.allowedHosts) ||
    typeof policy.githubRepo !== "string" ||
    typeof policy.owner !== "string" ||
    (policy.expiresAt !== undefined &&
      (!Number.isFinite(policy.expiresAt) || policy.expiresAt <= now))
  ) {
    return false;
  }
  const db = database(env);
  const refs = await db
    .selectFrom("interactive_session_credential_policies")
    .select("sandbox_id")
    .where("session_id", "=", policy.sessionId)
    .where("lookup_id", "=", lookupId)
    .where("state", "=", "active")
    .where("registration_generation", "=", generation)
    .where("registration_claim", "is", null)
    .execute();
  if (refs.length !== 1) return false;
  const canonicalSandboxId = refs[0]?.sandbox_id;
  if (
    !canonicalSandboxId ||
    (await activeSandboxCredentialPolicyGeneration(env, policy.sessionId, canonicalSandboxId)) !==
      generation
  ) {
    return false;
  }
  const standalone = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "ownership_claim", "ownership_claim_expires_at", "expires_at"])
    .where("id", "=", policy.sessionId)
    .where("sandbox_id", "=", canonicalSandboxId)
    .executeTakeFirst();
  if (standalone) {
    const ownerActive =
      standalone.state === "active" ||
      (standalone.state === "provisioning" &&
        Boolean(standalone.ownership_claim) &&
        (standalone.ownership_claim_expires_at ?? 0) > now);
    return Boolean(
      ownerActive &&
      policy.expiresAt !== undefined &&
      policy.expiresAt === standalone.expires_at &&
      policy.expiresAt > now,
    );
  }
  const owner = await sql<{ expected: number }>`
    SELECT CASE
      WHEN ${sandboxCredentialPolicyCleanupAuthorizedCondition(
        policy.sessionId,
        canonicalSandboxId,
        now,
      )}
      THEN 0
      ELSE 1
    END AS expected
  `.execute(db);
  return owner.rows[0]?.expected === 1;
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
  const stagedWriteAllowed =
    state === "cleanup_pending"
      ? sql<boolean>`1 = 1`
      : sql<boolean>`NOT EXISTS (
          SELECT 1
          FROM interactive_session_credential_policy_registrations AS staged
          WHERE staged.session_id = ${sessionId}
            AND staged.sandbox_id = ${sandboxId}
            AND staged.registration_generation != ${generation}
        )`;
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
      AND ${stagedWriteAllowed}
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
    newSandboxCredentialPolicyGeneration()
  );
}

export function currentSandboxCredentialPolicyGeneration(
  generations: readonly string[],
): string | null {
  const unique = [...new Set(generations)];
  if (unique.length !== 1) return null;
  return isCurrentCredentialPolicyGeneration(unique[0]) ? unique[0] : null;
}

export async function existingSandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string | null> {
  const existing = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select("registration_generation")
    .distinct()
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  return currentSandboxCredentialPolicyGeneration(
    existing.map((row) => row.registration_generation),
  );
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

function noLivePolicyTableRegistrationCondition(
  sessionId: string,
  sandboxId: string,
  now: number,
): RawBuilder<boolean> {
  return sql<boolean>`NOT EXISTS (
    SELECT 1
    FROM interactive_session_credential_policies
    WHERE session_id = ${sessionId}
      AND sandbox_id = ${sandboxId}
      AND state = 'registering'
      AND registration_claim IS NOT NULL
      AND registration_claim_expires_at > ${now}
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
  return [
    sql`
      INSERT INTO interactive_session_credential_policy_registrations (
        session_id,
        sandbox_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        lookup_ids_json,
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
        'registering',
        ${registration.generation},
        ${registration.claim},
        ${registrationExpiresAt},
        ${JSON.stringify(registration.lookupIds)},
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        ${now},
        ${now}
      WHERE ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
        AND ${noLivePolicyTableRegistrationCondition(sessionId, sandboxId, now)}
        AND NOT EXISTS (
          SELECT 1
          FROM interactive_session_credential_policies
          WHERE session_id = ${sessionId}
            AND sandbox_id = ${sandboxId}
            AND state = 'cleanup_pending'
        )
      ON CONFLICT(session_id, sandbox_id) DO UPDATE SET
        state = 'registering',
        registration_generation = excluded.registration_generation,
        registration_claim = excluded.registration_claim,
        registration_claim_expires_at = excluded.registration_claim_expires_at,
        lookup_ids_json = excluded.lookup_ids_json,
        repair_generation = NULL,
        rollback_policies_json = NULL,
        last_error = NULL,
        cleanup_claim = NULL,
        cleanup_claim_expires_at = NULL,
        updated_at = excluded.updated_at
      WHERE interactive_session_credential_policy_registrations.state != 'cleanup_pending'
        AND (
          interactive_session_credential_policy_registrations.registration_claim IS NULL
          OR interactive_session_credential_policy_registrations.registration_claim_expires_at <= ${now}
        )
        AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
        AND ${noLivePolicyTableRegistrationCondition(sessionId, sandboxId, now)}
        AND NOT EXISTS (
          SELECT 1
          FROM interactive_session_credential_policies
          WHERE session_id = ${sessionId}
            AND sandbox_id = ${sandboxId}
            AND state = 'cleanup_pending'
        )
    `,
  ];
}

export async function beginSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<SandboxCredentialPolicyRegistration> {
  const db = database(env);
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const registration = {
    generation: newSandboxCredentialPolicyGeneration(),
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
    .selectFrom("interactive_session_credential_policy_registrations")
    .select([
      "state",
      "registration_generation",
      "registration_claim",
      "registration_claim_expires_at",
      "lookup_ids_json",
    ])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .executeTakeFirst();
  if (
    claimed?.state !== "registering" ||
    claimed.registration_generation !== registration.generation ||
    claimed.registration_claim !== registration.claim ||
    claimed.registration_claim_expires_at !== registrationExpiresAt ||
    claimed.lookup_ids_json !== JSON.stringify(registration.lookupIds)
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
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      registration_claim_expires_at: registrationExpiresAt,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where("registration_claim_expires_at", ">", now)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .where(noLivePolicyTableRegistrationCondition(sessionId, sandboxId, now))
    .executeTakeFirst();
  return Number(renewed.numUpdatedRows ?? 0n) === 1 ? registrationExpiresAt : null;
}

export async function claimSandboxCredentialPolicyRegistrationRecovery(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  expiredRegistration: SandboxCredentialPolicyRegistration,
  expiredRegistrationExpiresAt: number,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<{
  registration: SandboxCredentialPolicyRegistration;
  registrationExpiresAt: number;
} | null> {
  const now = Date.now();
  const registration = {
    ...expiredRegistration,
    claim: `registration:${crypto.randomUUID()}`,
  };
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  const claimed = await database(env)
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      registration_claim: registration.claim,
      registration_claim_expires_at: registrationExpiresAt,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "registering")
    .where("registration_generation", "=", expiredRegistration.generation)
    .where("registration_claim", "=", expiredRegistration.claim)
    .where("registration_claim_expires_at", "=", expiredRegistrationExpiresAt)
    .where("registration_claim_expires_at", "<=", now)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .where(noLivePolicyTableRegistrationCondition(sessionId, sandboxId, now))
    .executeTakeFirst();
  return Number(claimed.numUpdatedRows ?? 0n) === 1
    ? { registration, registrationExpiresAt }
    : null;
}

export async function recordSandboxCredentialPolicyRollback(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  rollback: readonly SandboxCredentialPolicyRollbackRecord[],
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<boolean> {
  const now = Date.now();
  const recorded = await database(env)
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      rollback_policies_json: JSON.stringify(rollback),
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where("registration_claim_expires_at", ">", now)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .executeTakeFirst();
  return Number(recorded.numUpdatedRows ?? 0n) === 1;
}

export async function stageSandboxCredentialPolicyReferenceRepair(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  repairGeneration: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<boolean> {
  const now = Date.now();
  const staged = await sql<{ repair_generation: string }>`
    UPDATE interactive_session_credential_policy_registrations
    SET repair_generation = ${repairGeneration}, updated_at = ${now}
    WHERE session_id = ${sessionId}
      AND sandbox_id = ${sandboxId}
      AND state = 'registering'
      AND registration_generation = ${registration.generation}
      AND registration_claim = ${registration.claim}
      AND registration_claim_expires_at > ${now}
      AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
    RETURNING repair_generation
  `.execute(database(env));
  return staged.rows.length === 1 && staged.rows[0]?.repair_generation === repairGeneration;
}

export async function repairSandboxCredentialPolicyReferences(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  repairGeneration: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  registrationExpiresAt: number,
): Promise<boolean> {
  const now = Date.now();
  const repairAuthorized = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM interactive_session_credential_policy_registrations AS staged
      WHERE staged.session_id = ${sessionId}
        AND staged.sandbox_id = ${sandboxId}
        AND staged.state = 'registering'
        AND staged.registration_generation = ${registration.generation}
        AND staged.registration_claim = ${registration.claim}
        AND staged.registration_claim_expires_at = ${registrationExpiresAt}
        AND staged.registration_claim_expires_at > ${now}
        AND staged.repair_generation = ${repairGeneration}
    )
    AND EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies AS surviving
      WHERE surviving.session_id = ${sessionId}
        AND surviving.sandbox_id = ${sandboxId}
        AND surviving.state = 'active'
        AND surviving.registration_generation = ${repairGeneration}
        AND surviving.registration_claim IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies AS conflicting
      WHERE conflicting.session_id = ${sessionId}
        AND conflicting.sandbox_id = ${sandboxId}
        AND (
          conflicting.registration_generation != ${repairGeneration}
          OR NOT (
            (
              conflicting.state = 'active'
              AND conflicting.registration_claim IS NULL
            )
            OR (
              conflicting.state = 'registering'
              AND conflicting.registration_claim = ${registration.claim}
              AND conflicting.registration_claim_expires_at = ${registrationExpiresAt}
            )
          )
        )
    )
    AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
  `;
  const inserts = registration.lookupIds.map(
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
        ${repairGeneration},
        ${registration.claim},
        ${registrationExpiresAt},
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        ${now},
        ${now}
      WHERE ${repairAuthorized}
      ON CONFLICT(session_id, sandbox_id, lookup_id) DO NOTHING
    `,
  );
  const promotions = registration.lookupIds.map(
    (lookupId) => sql`
      UPDATE interactive_session_credential_policies
      SET
        state = 'active',
        registration_claim = NULL,
        registration_claim_expires_at = NULL,
        updated_at = ${now}
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND lookup_id = ${lookupId}
        AND state = 'registering'
        AND registration_generation = ${repairGeneration}
        AND registration_claim = ${registration.claim}
        AND registration_claim_expires_at = ${registrationExpiresAt}
        AND ${repairAuthorized}
    `,
  );
  await executeBatch(env, [...inserts, ...promotions]);
  const refs = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  return (
    registration.lookupIds.every((lookupId) =>
      refs.some(
        (ref) =>
          ref.lookup_id === lookupId &&
          ref.state === "active" &&
          ref.registration_generation === repairGeneration &&
          ref.registration_claim === null,
      ),
    ) &&
    refs.every(
      (ref) =>
        ref.state === "active" &&
        ref.registration_generation === repairGeneration &&
        ref.registration_claim === null,
    )
  );
}

export async function claimObsoleteSandboxCredentialPolicyReferences(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  repairGeneration: string,
  obsoleteLookupIds: readonly string[],
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  registrationExpiresAt: number,
): Promise<string[]> {
  if (obsoleteLookupIds.length === 0) return [];
  const now = Date.now();
  const claimed = await sql<{ lookup_id: string }>`
    UPDATE interactive_session_credential_policies
    SET
      state = 'cleanup_pending',
      cleanup_claim = ${registration.claim},
      cleanup_claim_expires_at = ${registrationExpiresAt},
      last_error = 'obsolete sandbox credential policy namespace',
      updated_at = ${now}
    WHERE session_id = ${sessionId}
      AND sandbox_id = ${sandboxId}
      AND lookup_id IN (${sql.join(obsoleteLookupIds)})
      AND state = 'active'
      AND registration_generation = ${repairGeneration}
      AND registration_claim IS NULL
      AND EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS staged
        WHERE staged.session_id = ${sessionId}
          AND staged.sandbox_id = ${sandboxId}
          AND staged.state = 'registering'
          AND staged.registration_generation = ${registration.generation}
          AND staged.registration_claim = ${registration.claim}
          AND staged.registration_claim_expires_at = ${registrationExpiresAt}
          AND staged.registration_claim_expires_at > ${now}
          AND staged.repair_generation = ${repairGeneration}
      )
      AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
    RETURNING lookup_id
  `.execute(database(env));
  return claimed.rows.map((row) => row.lookup_id).sort();
}

export async function retireObsoleteSandboxCredentialPolicyReference(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  repairGeneration: string,
  lookupId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  registrationExpiresAt: number,
): Promise<boolean> {
  const now = Date.now();
  const retired = await sql<{ lookup_id: string }>`
    DELETE FROM interactive_session_credential_policies
    WHERE session_id = ${sessionId}
      AND sandbox_id = ${sandboxId}
      AND lookup_id = ${lookupId}
      AND state = 'cleanup_pending'
      AND registration_generation = ${repairGeneration}
      AND cleanup_claim = ${registration.claim}
      AND cleanup_claim_expires_at = ${registrationExpiresAt}
      AND EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS staged
        WHERE staged.session_id = ${sessionId}
          AND staged.sandbox_id = ${sandboxId}
          AND staged.state = 'registering'
          AND staged.registration_generation = ${registration.generation}
          AND staged.registration_claim = ${registration.claim}
          AND staged.registration_claim_expires_at = ${registrationExpiresAt}
          AND staged.registration_claim_expires_at > ${now}
          AND staged.repair_generation = ${repairGeneration}
      )
      AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
    RETURNING lookup_id
  `.execute(database(env));
  return retired.rows[0]?.lookup_id === lookupId;
}

export async function deferSandboxCredentialPolicyRollback(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  reason: string,
): Promise<void> {
  const now = Date.now();
  await database(env)
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      registration_claim_expires_at: now,
      last_error: reason,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where("rollback_policies_json", "is not", null)
    .execute();
}

export async function finishSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<boolean> {
  const now = Date.now();
  let batchError: unknown;
  try {
    await executeBatch(
      env,
      sandboxCredentialPolicyPromotionQueries(
        env,
        sessionId,
        sandboxId,
        registration,
        ownershipFence,
        now,
      ),
    );
  } catch (error) {
    batchError = error;
  }
  try {
    if (await sandboxCredentialPolicyPromotionCompleted(env, sessionId, sandboxId, registration)) {
      return true;
    }
  } catch (readError) {
    try {
      if (
        await sandboxCredentialPolicyPromotionCompleted(env, sessionId, sandboxId, registration)
      ) {
        return true;
      }
    } catch {
      // Preserve the first observable failure when verification remains unavailable.
    }
    if (batchError) throw batchError;
    throw readError;
  }
  if (batchError) throw batchError;
  return false;
}

async function sandboxCredentialPolicyPromotionCompleted(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
): Promise<boolean> {
  const db = database(env);
  const active = await db
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .execute();
  const staged = await db
    .selectFrom("interactive_session_credential_policy_registrations")
    .select("registration_generation")
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .executeTakeFirst();
  return (
    !staged &&
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
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      state: "cleanup_pending",
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

export function sandboxCredentialPolicyPromotionQueries(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now: number,
): CompilableQuery[] {
  const promotionAuthorized = sql<boolean>`
    EXISTS (
      SELECT 1
      FROM interactive_session_credential_policy_registrations
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND state = 'registering'
        AND registration_generation = ${registration.generation}
        AND registration_claim = ${registration.claim}
    )
    AND ${noLivePolicyTableRegistrationCondition(sessionId, sandboxId, now)}
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND state = 'cleanup_pending'
    )
    AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
  `;
  const promotions = registration.lookupIds.map(
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
        'active',
        ${registration.generation},
        NULL,
        NULL,
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        ${now},
        ${now}
      WHERE ${promotionAuthorized}
      ON CONFLICT(session_id, sandbox_id, lookup_id) DO UPDATE SET
        state = 'active',
        registration_generation = excluded.registration_generation,
        registration_claim = NULL,
        registration_claim_expires_at = NULL,
        last_error = NULL,
        cleanup_claim = NULL,
        cleanup_claim_expires_at = NULL,
        updated_at = excluded.updated_at
      WHERE interactive_session_credential_policies.state != 'cleanup_pending'
        AND ${promotionAuthorized}
    `,
  );
  const promotionComplete = sql<boolean>`
    (
      SELECT count(DISTINCT lookup_id)
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND lookup_id IN (${sql.join(registration.lookupIds)})
        AND state = 'active'
        AND registration_generation = ${registration.generation}
        AND registration_claim IS NULL
    ) = ${registration.lookupIds.length}
  `;
  return [
    ...promotions,
    sql`
      DELETE FROM interactive_session_credential_policy_registrations
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND state = 'registering'
        AND registration_generation = ${registration.generation}
        AND registration_claim = ${registration.claim}
        AND ${promotionComplete}
    `,
  ];
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
