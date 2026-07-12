import { getSandbox } from "@cloudflare/sandbox";
import { sql, type Kysely, type Selectable } from "kysely";

import { retainedRuntimeAdapterFailureMessage } from "../runtime-adapter.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import {
  database,
  type Database,
  type InteractiveSessionCredentialPolicyTable,
  type InteractiveSessionCredentialPolicyRegistrationTable,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { serviceUnavailable } from "./http.ts";
import { expireStandaloneSandboxProvisions } from "./provisioning/standalone-sandbox-repository.ts";
import { safeProviderError } from "./provisioning/result.ts";
import {
  queueSandboxCredentialPolicyCleanup,
  sandboxCredentialPolicyCleanupAuthorizedCondition,
  sandboxLookupIds,
} from "./sandbox-credential-policy-repository.ts";
import { restoreSandboxCredentialPolicyRollback } from "./sandbox-credential-policy-rollback.ts";
import { scanCredentialPolicyCleanupPage } from "./sandbox-credential-policy-scanner.ts";
import { isCurrentSandboxLease, sandboxLeaseInfo } from "./sandbox-lease.ts";
import { isSandboxSessionAlreadyGone } from "./sandbox-session-errors.ts";
import { sandboxControlStub } from "./session-control-do.ts";
import { finalizeTerminalInteractiveSession } from "./session-terminal-finalization.ts";

const credentialPolicyCleanupLimit = 8;
const credentialPolicyCleanupClaimMs = 30_000;

export async function sandboxCredentialPolicyExists(
  env: RuntimeEnv,
  sandboxId: string,
  generation: string,
): Promise<boolean> {
  const stub = sandboxControlStub(env);
  if (!stub) return false;
  const responses = await Promise.all(
    sandboxLookupIds(env, sandboxId).map((lookupId) =>
      stub.fetch(
        `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(lookupId)}`,
      ),
    ),
  );
  if (responses.some((response) => !response.ok && response.status !== 404)) {
    throw new Error("sandbox credential policy lookup failed");
  }
  return responses.every(
    (response) =>
      response.ok && response.headers.get("x-crabfleet-policy-generation") === generation,
  );
}

async function unregisterSandboxCredentialPolicyLookup(
  env: RuntimeEnv,
  lookupId: string,
  generation: string,
  sessionId: string,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("sandbox credential policy cleanup is unavailable");
  let response: Response;
  try {
    response = await stub.fetch(
      `https://crabfleet.internal/api/session-control/sandbox/${encodeURIComponent(lookupId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ generation, sessionId, tombstonedAt: Date.now() }),
        headers: { "content-type": "application/json" },
      },
    );
  } catch {
    throw serviceUnavailable("sandbox credential policy cleanup failed");
  }
  if (!response.ok) {
    throw serviceUnavailable("sandbox credential policy cleanup failed");
  }
}

async function reconcileStagedCredentialPolicyCleanup(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  let query = database(env)
    .selectFrom("interactive_session_credential_policy_registrations")
    .selectAll()
    .where("state", "=", "cleanup_pending")
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<", now),
      ]),
    )
    .orderBy(sql`COALESCE(last_attempt_at, created_at)`, "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  await mapWithConcurrency(await query.execute(), 3, async (registration) => {
    await reconcileStagedCredentialPolicyRegistration(env, registration, now);
  });
}

async function reconcileStagedCredentialPolicyRegistration(
  env: RuntimeEnv,
  registration: Selectable<InteractiveSessionCredentialPolicyRegistrationTable>,
  now: number,
): Promise<void> {
  const claim = crypto.randomUUID();
  const claimed = await database(env)
    .updateTable("interactive_session_credential_policy_registrations")
    .set({
      cleanup_claim: claim,
      cleanup_claim_expires_at: now + credentialPolicyCleanupClaimMs,
      attempt_count: sql<number>`attempt_count + 1`,
      last_attempt_at: now,
      updated_at: now,
    })
    .where("session_id", "=", registration.session_id)
    .where("sandbox_id", "=", registration.sandbox_id)
    .where("state", "=", "cleanup_pending")
    .where("registration_generation", "=", registration.registration_generation)
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<", now),
      ]),
    )
    .executeTakeFirst();
  if ((claimed.numUpdatedRows ?? 0n) === 0n) return;
  try {
    await Promise.all(
      sandboxLookupIds(env, registration.sandbox_id).map((lookupId) =>
        unregisterSandboxCredentialPolicyLookup(
          env,
          lookupId,
          registration.registration_generation,
          registration.session_id,
        ),
      ),
    );
  } catch (error) {
    await database(env)
      .updateTable("interactive_session_credential_policy_registrations")
      .set({
        last_error: clean(error instanceof Error ? error.message : String(error), 500),
        cleanup_claim: null,
        cleanup_claim_expires_at: null,
        updated_at: Date.now(),
      })
      .where("session_id", "=", registration.session_id)
      .where("sandbox_id", "=", registration.sandbox_id)
      .where("registration_generation", "=", registration.registration_generation)
      .where("cleanup_claim", "=", claim)
      .execute();
    return;
  }
  await database(env)
    .deleteFrom("interactive_session_credential_policy_registrations")
    .where("session_id", "=", registration.session_id)
    .where("sandbox_id", "=", registration.sandbox_id)
    .where("registration_generation", "=", registration.registration_generation)
    .where("cleanup_claim", "=", claim)
    .execute();
  await completeCredentialPolicyCleanupSession(env, registration.session_id, Date.now());
  await completeStandaloneSandboxProvisionCleanupSafely(
    env,
    registration.session_id,
    registration.sandbox_id,
  );
}

async function normalizeCredentialPolicyCleanupGroups(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  const db = database(env);
  const state = sessionId
    ? null
    : await db
        .selectFrom("credential_policy_reconcile_state")
        .select([
          "group_session_id",
          "group_sandbox_id",
          "group_max_session_id",
          "group_max_sandbox_id",
        ])
        .where("id", "=", 1)
        .executeTakeFirst();
  const originalSessionCursor = state?.group_session_id ?? "";
  const originalSandboxCursor = state?.group_sandbox_id ?? "";
  const originalMaxSession = state?.group_max_session_id ?? "";
  const originalMaxSandbox = state?.group_max_sandbox_id ?? "";
  let maximum = sessionId
    ? { session_id: sessionId, sandbox_id: "\uffff" }
    : originalMaxSession
      ? { session_id: originalMaxSession, sandbox_id: originalMaxSandbox }
      : await maximumCredentialPolicyCleanupGroup(db);
  let groups = await readCredentialPolicyCleanupGroups(
    db,
    sessionId ? "" : originalSessionCursor,
    sessionId ? "" : originalSandboxCursor,
    maximum,
    sessionId,
  );
  if (!sessionId && groups.length === 0 && maximum) {
    maximum = await maximumCredentialPolicyCleanupGroup(db);
    groups = await readCredentialPolicyCleanupGroups(db, "", "", maximum);
  }
  for (const group of groups) {
    await queueSandboxCredentialPolicyCleanup(env, group.session_id, group.sandbox_id, now);
  }
  if (!sessionId) {
    const last = groups.at(-1);
    await db
      .updateTable("credential_policy_reconcile_state")
      .set({
        group_session_id: last?.session_id ?? "",
        group_sandbox_id: last?.sandbox_id ?? "",
        group_max_session_id: maximum?.session_id ?? "",
        group_max_sandbox_id: maximum?.sandbox_id ?? "",
        updated_at: now,
      })
      .where("id", "=", 1)
      .where("group_session_id", "=", originalSessionCursor)
      .where("group_sandbox_id", "=", originalSandboxCursor)
      .where("group_max_session_id", "=", originalMaxSession)
      .where("group_max_sandbox_id", "=", originalMaxSandbox)
      .execute();
  }
}

async function readCredentialPolicyCleanupGroups(
  db: Kysely<Database>,
  sessionCursor: string,
  sandboxCursor: string,
  maximum: { session_id: string; sandbox_id: string } | null,
  sessionId?: string,
): Promise<Array<{ session_id: string; sandbox_id: string }>> {
  let query = db
    .selectFrom("interactive_session_credential_policies")
    .select(["session_id", "sandbox_id"])
    .distinct()
    .where("state", "=", "cleanup_pending")
    .where((expression) =>
      expression.or([
        expression("session_id", ">", sessionCursor),
        expression.and([
          expression("session_id", "=", sessionCursor),
          expression("sandbox_id", ">", sandboxCursor),
        ]),
      ]),
    )
    .where((expression) =>
      maximum
        ? expression.or([
            expression("session_id", "<", maximum.session_id),
            expression.and([
              expression("session_id", "=", maximum.session_id),
              expression("sandbox_id", "<=", maximum.sandbox_id),
            ]),
          ])
        : expression("session_id", "=", ""),
    )
    .orderBy("session_id", "asc")
    .orderBy("sandbox_id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  return query.execute();
}

async function maximumCredentialPolicyCleanupGroup(
  db: Kysely<Database>,
): Promise<{ session_id: string; sandbox_id: string } | null> {
  return (
    (await db
      .selectFrom("interactive_session_credential_policies")
      .select(["session_id", "sandbox_id"])
      .where("state", "=", "cleanup_pending")
      .orderBy("session_id", "desc")
      .orderBy("sandbox_id", "desc")
      .executeTakeFirst()) ?? null
  );
}

export async function reconcileSandboxCredentialPolicyCleanupBatch(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  await expireStandaloneSandboxProvisions(env, now, sessionId).catch((error) => {
    console.error("standalone Sandbox expiry failed", error);
  });
  await scanCredentialPolicyCleanupPage(
    env,
    now,
    sandboxCredentialPolicyExists,
    sessionId,
    async ({ registration, registrationExpiresAt, rollbackJson, sessionId: rollbackSessionId }) => {
      const stub = sandboxControlStub(env);
      if (!stub) throw serviceUnavailable("sandbox credential policy rollback is unavailable");
      await restoreSandboxCredentialPolicyRollback(
        stub,
        registration,
        registrationExpiresAt,
        rollbackJson,
        rollbackSessionId,
      );
    },
  ).catch((error) => {
    console.error("credential policy cleanup scan failed", error);
  });
  await reconcileStagedCredentialPolicyCleanup(env, now, sessionId).catch((error) => {
    console.error("staged credential policy cleanup failed", error);
  });
  await normalizeCredentialPolicyCleanupGroups(env, now, sessionId).catch((error) => {
    console.error("credential policy cleanup group normalization failed", error);
  });
  let query = database(env)
    .selectFrom("interactive_session_credential_policies")
    .selectAll()
    .where("state", "=", "cleanup_pending")
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<", now),
      ]),
    )
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.registration_claim IS NOT NULL
          AND registration.registration_claim_expires_at > ${now}
      )
    `)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.state = 'registering'
          AND registration.registration_claim_expires_at > ${now}
      )
    `)
    .orderBy(sql`COALESCE(last_attempt_at, created_at)`, "asc")
    .orderBy("session_id", "asc")
    .orderBy("sandbox_id", "asc")
    .orderBy("lookup_id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  const policies = await query.execute();
  await mapWithConcurrency(policies, 3, async (policy) => {
    await reconcileCredentialPolicyCleanup(env, policy, now);
  });
  let completedSessions = database(env)
    .selectFrom("interactive_sessions")
    .select("id")
    .where("status", "in", ["stopping", "stopped", "expired", "failed"])
    .where("credential_cleanup_terminal_status", "is not", null)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS policy
        WHERE policy.session_id = interactive_sessions.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS registration
        WHERE registration.session_id = interactive_sessions.id
      )
    `)
    .orderBy("stopped_at", "asc")
    .orderBy("id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) completedSessions = completedSessions.where("id", "=", sessionId);
  await mapWithConcurrency(await completedSessions.execute(), 3, async (session) => {
    await completeCredentialPolicyCleanupSession(env, session.id, Date.now());
  });
  let standaloneCleanup = database(env)
    .selectFrom("standalone_sandbox_provisions")
    .select(["id", "sandbox_id"])
    .where("state", "=", "cleanup_pending")
    .orderBy("updated_at", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) standaloneCleanup = standaloneCleanup.where("id", "=", sessionId);
  await mapWithConcurrency(await standaloneCleanup.execute(), 3, async (owner) => {
    await completeStandaloneSandboxProvisionCleanupSafely(env, owner.id, owner.sandbox_id);
  });
}

async function reconcileCredentialPolicyCleanup(
  env: RuntimeEnv,
  policy: Selectable<InteractiveSessionCredentialPolicyTable>,
  now: number,
): Promise<void> {
  const claim = crypto.randomUUID();
  const claimed = await sql`
    UPDATE interactive_session_credential_policies
    SET cleanup_claim = ${claim},
        cleanup_claim_expires_at = ${now + credentialPolicyCleanupClaimMs},
        attempt_count = attempt_count + 1,
        last_attempt_at = ${now},
        updated_at = ${now}
    WHERE session_id = ${policy.session_id}
      AND sandbox_id = ${policy.sandbox_id}
      AND lookup_id = ${policy.lookup_id}
      AND registration_generation = ${policy.registration_generation}
      AND state = 'cleanup_pending'
      AND (cleanup_claim IS NULL OR cleanup_claim_expires_at < ${now})
      AND ${sandboxCredentialPolicyCleanupAuthorizedCondition(
        policy.session_id,
        policy.sandbox_id,
        now,
      )}
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.registration_claim IS NOT NULL
          AND registration.registration_claim_expires_at > ${now}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.state = 'registering'
          AND registration.registration_claim_expires_at > ${now}
      )
  `.execute(database(env));
  if ((claimed.numAffectedRows ?? 0n) === 0n) return;
  try {
    await unregisterSandboxCredentialPolicyLookup(
      env,
      policy.lookup_id,
      policy.registration_generation,
      policy.session_id,
    );
  } catch (error) {
    await database(env)
      .updateTable("interactive_session_credential_policies")
      .set({
        last_error: clean(error instanceof Error ? error.message : String(error), 500),
        cleanup_claim: null,
        cleanup_claim_expires_at: null,
        updated_at: Date.now(),
      })
      .where("session_id", "=", policy.session_id)
      .where("sandbox_id", "=", policy.sandbox_id)
      .where("lookup_id", "=", policy.lookup_id)
      .where("registration_generation", "=", policy.registration_generation)
      .where("cleanup_claim", "=", claim)
      .execute();
    return;
  }
  await database(env)
    .deleteFrom("interactive_session_credential_policies")
    .where("session_id", "=", policy.session_id)
    .where("sandbox_id", "=", policy.sandbox_id)
    .where("lookup_id", "=", policy.lookup_id)
    .where("registration_generation", "=", policy.registration_generation)
    .where("cleanup_claim", "=", claim)
    .execute();
  await completeCredentialPolicyCleanupSession(env, policy.session_id, Date.now());
  await completeStandaloneSandboxProvisionCleanupSafely(env, policy.session_id, policy.sandbox_id);
}

async function completeStandaloneSandboxProvisionCleanupSafely(
  env: RuntimeEnv,
  provisionId: string,
  sandboxId: string,
): Promise<void> {
  try {
    await completeStandaloneSandboxProvisionCleanup(env, provisionId, sandboxId);
  } catch (error) {
    const now = Date.now();
    const message = `standalone Sandbox cleanup pending: ${safeProviderError(error, [
      provisionId,
      sandboxId,
    ])}`;
    try {
      await database(env)
        .updateTable("standalone_sandbox_provisions")
        .set({
          message,
          updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
        })
        .where("id", "=", provisionId)
        .where("sandbox_id", "=", sandboxId)
        .where("state", "=", "cleanup_pending")
        .execute();
    } catch (persistError) {
      console.error("standalone Sandbox cleanup failure persistence failed", persistError);
    }
  }
}

async function completeStandaloneSandboxProvisionCleanup(
  env: RuntimeEnv,
  provisionId: string,
  sandboxId: string,
): Promise<void> {
  const db = database(env);
  const owner = await db
    .selectFrom("standalone_sandbox_provisions")
    .selectAll()
    .where("id", "=", provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "cleanup_pending")
    .executeTakeFirst();
  if (!owner) return;
  if (owner.lease_id) {
    if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
    if (!isCurrentSandboxLease(owner.lease_id)) {
      throw serviceUnavailable("standalone Sandbox cleanup lease is invalid");
    }
    const lease = sandboxLeaseInfo({ id: owner.id, leaseId: owner.lease_id });
    if (lease.sandboxId !== owner.sandbox_id) {
      throw serviceUnavailable("standalone Sandbox cleanup ownership is inconsistent");
    }
    try {
      await getSandbox(env.SANDBOX, owner.sandbox_id).deleteSession(lease.terminalSessionId);
    } catch (error) {
      if (!isSandboxSessionAlreadyGone(error, lease.terminalSessionId)) throw error;
    }
  }
  await db
    .deleteFrom("standalone_sandbox_provisions")
    .where("id", "=", provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("request_hash", "=", owner.request_hash)
    .where("state", "=", "cleanup_pending")
    .where("updated_at", "=", owner.updated_at)
    .where(sql<boolean>`lease_id IS ${owner.lease_id}`)
    .where(sql<boolean>`expires_at IS ${owner.expires_at}`)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS policy
        WHERE policy.session_id = ${provisionId}
          AND policy.sandbox_id = ${sandboxId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations AS registration
        WHERE registration.session_id = ${provisionId}
          AND registration.sandbox_id = ${sandboxId}
      )
    `)
    .execute();
}

async function completeCredentialPolicyCleanupSession(
  env: RuntimeEnv,
  sessionId: string,
  now: number,
): Promise<void> {
  const db = database(env);
  const remaining = await sql<{ count: number }>`
    SELECT
      (
        SELECT count(*)
        FROM interactive_session_credential_policies
        WHERE session_id = ${sessionId}
      ) + (
        SELECT count(*)
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = ${sessionId}
      ) AS count
  `.execute(db);
  if (Number(remaining.rows[0]?.count ?? 0) > 0) return;
  const session = await db
    .selectFrom("interactive_sessions")
    .select([
      "status",
      "credential_cleanup_terminal_status",
      "terminal_failure_reason",
      "reconcile_error",
      "last_event",
      "stopped_at",
      "updated_at",
    ])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  const terminalStatus = session?.credential_cleanup_terminal_status;
  if (!session || !terminalStatus) return;
  const failureMessage = retainedRuntimeAdapterFailureMessage(
    session.terminal_failure_reason,
    session.reconcile_error,
    session.last_event,
  );
  const updated = await db
    .updateTable("interactive_sessions")
    .set({
      status: terminalStatus,
      credential_cleanup_terminal_status: null,
      terminal_status: null,
      adapter_create_pending: 0,
      terminal_finalize_pending: 1,
      sandbox_refresh_sandbox_id: null,
      sandbox_refresh_claim: null,
      sandbox_refresh_claim_expires_at: null,
      terminal_failure_reason: terminalStatus === "failed" ? failureMessage : null,
      reconcile_error: terminalStatus === "failed" ? failureMessage : null,
      stopped_at: session.stopped_at ?? now,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      last_event:
        terminalStatus === "failed"
          ? failureMessage
          : terminalStatus === "expired"
            ? "interactive workspace expired after credential cleanup"
            : "interactive workspace stopped after credential cleanup",
    })
    .where("id", "=", sessionId)
    .where("status", "=", session.status)
    .where("updated_at", "=", session.updated_at)
    .where("credential_cleanup_terminal_status", "=", terminalStatus)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies
        WHERE session_id = ${sessionId}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = ${sessionId}
      )
    `)
    .executeTakeFirst();
  if ((updated.numUpdatedRows ?? 0n) === 0n) return;
  await finalizeTerminalInteractiveSession(
    env,
    sessionId,
    terminalStatus,
    session.stopped_at ?? now,
  ).catch(() => undefined);
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
