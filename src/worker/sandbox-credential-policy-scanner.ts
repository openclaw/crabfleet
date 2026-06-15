import { sql, type Kysely } from "kysely";

import { credentialPolicySandboxIsExpected } from "../credential-policy-fence.ts";
import { runtimeAdapterName } from "../runtime-adapter.ts";
import { database, executeBatch, type Database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { InteractiveSessionStatus } from "./models.ts";
import {
  recordSandboxCredentialPolicyRefs,
  sandboxCredentialPolicyCleanupAuthorizedCondition,
  type SandboxCredentialPolicyOwnershipFence,
} from "./sandbox-credential-policy-repository.ts";
import { sandboxLeaseInfo, sandboxLeasePrefix } from "./sandbox-lease.ts";

const credentialPolicyScanLimit = 32;
export const credentialPolicyProvisioningStaleMs = 15 * 60_000;

export type CredentialPolicyScanRow = {
  scan_rowid: number;
  session_id: string;
  sandbox_id: string;
  lookup_id: string;
  policy_state: "registering" | "active";
  registration_generation: string;
  registration_claim: string | null;
  registration_claim_expires_at: number | null;
  policy_updated_at: number;
  matched_session_id: string | null;
  session_adapter: string | null;
  session_status: InteractiveSessionStatus | null;
  session_lease_id: string | null;
  credential_cleanup_terminal_status: "stopped" | "expired" | "failed" | null;
  session_sandbox_refresh_sandbox_id: string | null;
  session_sandbox_refresh_claim: string | null;
  session_sandbox_refresh_claim_expires_at: number | null;
  session_agent_token_hash: string | null;
  session_updated_at: number | null;
  matched_standalone_id: string | null;
  standalone_state: "provisioning" | "active" | "cleanup_pending" | null;
  standalone_claim: string | null;
  standalone_claim_expires_at: number | null;
  standalone_updated_at: number | null;
};

export type SandboxCredentialPolicyExists = (
  env: RuntimeEnv,
  sandboxId: string,
  generation: string,
) => Promise<boolean>;

export async function scanCredentialPolicyCleanupPage(
  env: RuntimeEnv,
  now: number,
  policyExists: SandboxCredentialPolicyExists,
  sessionId?: string,
): Promise<void> {
  const db = database(env);
  const state = sessionId
    ? null
    : await db
        .selectFrom("credential_policy_reconcile_state")
        .select(["last_rowid", "scan_max_rowid"])
        .where("id", "=", 1)
        .executeTakeFirst();
  const originalCursor = state?.last_rowid ?? 0;
  const originalMaxRowid = state?.scan_max_rowid ?? 0;
  let cursor = sessionId ? 0 : originalCursor;
  let maxRowid = sessionId
    ? Number.MAX_SAFE_INTEGER
    : originalMaxRowid || (await maximumCredentialPolicyRowid(db));
  let rows = await readCredentialPolicyScanPage(db, cursor, maxRowid, sessionId);
  if (!sessionId && rows.length === 0 && (cursor > 0 || maxRowid > 0)) {
    cursor = 0;
    maxRowid = await maximumCredentialPolicyRowid(db);
    rows = await readCredentialPolicyScanPage(db, cursor, maxRowid);
  }
  const attemptedRepairs = new Set<string>();
  const repairedRegistrations = new Set<string>();
  const deferredRegistrations = new Set<string>();
  for (const row of rows) {
    const registrationKey = `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`;
    if (attemptedRepairs.has(registrationKey)) continue;
    attemptedRepairs.add(registrationKey);
    try {
      if (await repairActiveSandboxCredentialPolicyRegistration(env, row, now, policyExists)) {
        repairedRegistrations.add(registrationKey);
      }
    } catch (error) {
      deferredRegistrations.add(registrationKey);
      console.error("active sandbox credential policy repair failed", error);
    }
  }
  const candidates = rows.filter(
    (row) =>
      !repairedRegistrations.has(
        `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`,
      ) &&
      !deferredRegistrations.has(
        `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`,
      ) &&
      credentialPolicyScanRequiresCleanup(row, now),
  );
  for (const row of candidates) {
    const transitionRevision = Math.max(
      now,
      row.policy_updated_at + 1,
      (row.session_updated_at ?? 0) + 1,
      (row.standalone_updated_at ?? 0) + 1,
    );
    let policyTransition = db
      .updateTable("interactive_session_credential_policies")
      .set({ state: "cleanup_pending", updated_at: transitionRevision })
      .where("session_id", "=", row.session_id)
      .where("sandbox_id", "=", row.sandbox_id)
      .where("lookup_id", "=", row.lookup_id)
      .where("state", "=", row.policy_state)
      .where("registration_generation", "=", row.registration_generation)
      .where("updated_at", "=", row.policy_updated_at)
      .where(
        sandboxCredentialPolicyCleanupAuthorizedCondition(row.session_id, row.sandbox_id, now),
      );
    policyTransition = row.registration_claim
      ? policyTransition.where("registration_claim", "=", row.registration_claim)
      : policyTransition.where("registration_claim", "is", null);
    policyTransition =
      row.registration_claim_expires_at === null
        ? policyTransition.where("registration_claim_expires_at", "is", null)
        : policyTransition.where(
            "registration_claim_expires_at",
            "=",
            row.registration_claim_expires_at,
          );
    if (row.matched_standalone_id) {
      if (!row.standalone_state || row.standalone_updated_at === null) continue;
      let ownerTransition = db
        .updateTable("standalone_sandbox_provisions")
        .set({
          state: "cleanup_pending",
          ownership_claim: null,
          ownership_claim_expires_at: null,
          updated_at: transitionRevision,
        })
        .where("id", "=", row.matched_standalone_id)
        .where("sandbox_id", "=", row.sandbox_id)
        .where("state", "=", row.standalone_state)
        .where("updated_at", "=", row.standalone_updated_at);
      ownerTransition = row.standalone_claim
        ? ownerTransition.where("ownership_claim", "=", row.standalone_claim)
        : ownerTransition.where("ownership_claim", "is", null);
      ownerTransition =
        row.standalone_claim_expires_at === null
          ? ownerTransition.where("ownership_claim_expires_at", "is", null)
          : ownerTransition.where(
              "ownership_claim_expires_at",
              "=",
              row.standalone_claim_expires_at,
            );
      await executeBatch(env, [ownerTransition, policyTransition]);
      continue;
    }
    if (!row.matched_session_id || row.session_adapter === runtimeAdapterName) {
      await executeBatch(env, [policyTransition]);
      continue;
    }
    const sessionTransition = sql`
        UPDATE interactive_sessions
        SET terminal_failure_reason = CASE
              WHEN credential_cleanup_terminal_status = 'failed'
                OR status = 'failed'
                OR (
                  credential_cleanup_terminal_status IS NULL
                  AND status NOT IN ('stopping', 'stopped', 'expired')
                )
              THEN COALESCE(
                NULLIF(terminal_failure_reason, ''),
                NULLIF(reconcile_error, ''),
                NULLIF(last_event, ''),
                'sandbox credential registration cleanup failed'
              )
              ELSE terminal_failure_reason
            END,
            status = 'stopping',
            credential_cleanup_terminal_status = CASE
              WHEN credential_cleanup_terminal_status = 'failed' OR status = 'failed'
                THEN 'failed'
              WHEN credential_cleanup_terminal_status = 'expired' OR status = 'expired'
                THEN 'expired'
              WHEN credential_cleanup_terminal_status = 'stopped'
                OR status IN ('stopping', 'stopped')
                THEN 'stopped'
              ELSE 'failed'
            END,
            terminal_status = NULL,
            adapter_create_pending = 0,
            terminal_finalize_pending = 0,
            sandbox_refresh_sandbox_id = NULL,
            sandbox_refresh_claim = NULL,
            sandbox_refresh_claim_expires_at = NULL,
            agent_token_hash = NULL,
            attach_url = NULL,
            vnc_url = NULL,
            controller = NULL,
            control_requested_by = NULL,
            control_requested_at = NULL,
            control_granted_at = NULL,
            control_expires_at = NULL,
            reconcile_error = CASE
              WHEN credential_cleanup_terminal_status = 'failed'
                OR status = 'failed'
                OR (
                  credential_cleanup_terminal_status IS NULL
                  AND status NOT IN ('stopping', 'stopped', 'expired')
                )
              THEN COALESCE(
                NULLIF(terminal_failure_reason, ''),
                NULLIF(reconcile_error, ''),
                NULLIF(last_event, ''),
                'sandbox credential registration cleanup failed'
              )
              ELSE 'sandbox credential registration cleanup pending'
            END,
            stopped_at = COALESCE(stopped_at, ${now}),
            updated_at = ${transitionRevision},
            last_event = 'sandbox credential registration cleanup pending'
        WHERE id = ${row.matched_session_id}
          AND adapter IS ${row.session_adapter}
          AND status IS ${row.session_status}
          AND lease_id IS ${row.session_lease_id}
          AND credential_cleanup_terminal_status IS ${row.credential_cleanup_terminal_status}
          AND sandbox_refresh_sandbox_id IS ${row.session_sandbox_refresh_sandbox_id}
          AND sandbox_refresh_claim IS ${row.session_sandbox_refresh_claim}
          AND sandbox_refresh_claim_expires_at IS ${row.session_sandbox_refresh_claim_expires_at}
          AND agent_token_hash IS ${row.session_agent_token_hash}
          AND updated_at IS ${row.session_updated_at}
      `;
    await executeBatch(env, [sessionTransition, policyTransition]);
  }
  if (!sessionId) {
    const nextCursor = rows.at(-1)?.scan_rowid ?? 0;
    await sql`
      UPDATE credential_policy_reconcile_state
      SET last_rowid = ${nextCursor}, scan_max_rowid = ${maxRowid}, updated_at = ${now}
      WHERE id = 1
        AND last_rowid = ${originalCursor}
        AND scan_max_rowid = ${originalMaxRowid}
    `.execute(db);
  }
}

async function readCredentialPolicyScanPage(
  db: Kysely<Database>,
  cursor: number,
  maxRowid: number,
  sessionId?: string,
): Promise<CredentialPolicyScanRow[]> {
  const sessionFilter = sessionId ? sql`AND policy.session_id = ${sessionId}` : sql``;
  const result = await sql<CredentialPolicyScanRow>`
    SELECT
      policy.rowid AS scan_rowid,
      policy.session_id,
      policy.sandbox_id,
      policy.lookup_id,
      policy.state AS policy_state,
      policy.registration_generation,
      policy.registration_claim,
      policy.registration_claim_expires_at,
      policy.updated_at AS policy_updated_at,
      session.id AS matched_session_id,
      session.adapter AS session_adapter,
      session.status AS session_status,
      session.lease_id AS session_lease_id,
      session.credential_cleanup_terminal_status,
      session.sandbox_refresh_sandbox_id AS session_sandbox_refresh_sandbox_id,
      session.sandbox_refresh_claim AS session_sandbox_refresh_claim,
      session.sandbox_refresh_claim_expires_at AS session_sandbox_refresh_claim_expires_at,
      session.agent_token_hash AS session_agent_token_hash,
      session.updated_at AS session_updated_at,
      standalone.id AS matched_standalone_id,
      standalone.state AS standalone_state,
      standalone.ownership_claim AS standalone_claim,
      standalone.ownership_claim_expires_at AS standalone_claim_expires_at,
      standalone.updated_at AS standalone_updated_at
    FROM interactive_session_credential_policies AS policy
    LEFT JOIN interactive_sessions AS session ON session.id = policy.session_id
    LEFT JOIN standalone_sandbox_provisions AS standalone
      ON standalone.id = policy.session_id
      AND standalone.sandbox_id = policy.sandbox_id
    WHERE policy.rowid > ${cursor}
      AND policy.rowid <= ${maxRowid}
      AND policy.state IN ('registering', 'active')
      ${sessionFilter}
    ORDER BY policy.rowid ASC
    LIMIT ${credentialPolicyScanLimit}
  `.execute(db);
  return result.rows;
}

async function maximumCredentialPolicyRowid(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ max_rowid: number }>`
    SELECT COALESCE(MAX(rowid), 0) AS max_rowid
    FROM interactive_session_credential_policies
  `.execute(db);
  return result.rows[0]?.max_rowid ?? 0;
}

async function repairActiveSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  row: CredentialPolicyScanRow,
  now: number,
  policyExists: SandboxCredentialPolicyExists,
): Promise<boolean> {
  if (
    row.policy_state !== "registering" ||
    (row.registration_claim !== null &&
      (row.registration_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now)
  ) {
    return false;
  }
  const ownershipFence = credentialPolicyScanOwnershipFence(row, now);
  if (!ownershipFence) return false;
  if (!(await policyExists(env, row.sandbox_id, row.registration_generation))) {
    return false;
  }
  const repaired = await recordSandboxCredentialPolicyRefs(
    env,
    row.session_id,
    row.sandbox_id,
    "active",
    row.registration_generation,
    ownershipFence,
    now,
  );
  if (!repaired) {
    throw new Error("active sandbox credential policy repair lost durable ownership");
  }
  return true;
}

export function credentialPolicyScanOwnershipFence(
  row: CredentialPolicyScanRow,
  now: number,
): SandboxCredentialPolicyOwnershipFence | null {
  if (
    row.matched_standalone_id === row.session_id &&
    row.standalone_state === "provisioning" &&
    row.standalone_claim &&
    (row.standalone_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now
  ) {
    return {
      claim: row.standalone_claim,
      provisionId: row.matched_standalone_id,
      sandboxId: row.sandbox_id,
    };
  }
  if (!row.matched_session_id || !row.session_lease_id) return null;
  try {
    const lease = sandboxLeaseInfo({
      id: row.matched_session_id,
      adapter: row.session_adapter,
      leaseId: row.session_lease_id,
    });
    if (lease.sandboxId === row.sandbox_id) {
      return { leaseId: row.session_lease_id, sandboxId: row.sandbox_id };
    }
  } catch {
    return null;
  }
  if (
    row.session_sandbox_refresh_sandbox_id === row.sandbox_id &&
    row.session_sandbox_refresh_claim &&
    (row.session_sandbox_refresh_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now
  ) {
    return {
      claim: row.session_sandbox_refresh_claim,
      expiresAt: row.session_sandbox_refresh_claim_expires_at as number,
      refreshLeaseId: row.session_lease_id,
      sandboxId: row.sandbox_id,
    };
  }
  return null;
}

export function credentialPolicyScanRequiresCleanup(
  row: CredentialPolicyScanRow,
  now: number,
): boolean {
  const registrationAbandoned =
    row.policy_state === "registering" &&
    (row.registration_claim === null ||
      (row.registration_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now);
  if (row.matched_standalone_id) {
    if (row.standalone_state === "active") return false;
    if (row.standalone_state === "provisioning") {
      return (row.standalone_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now;
    }
    return true;
  }
  if (!row.matched_session_id || row.session_adapter === runtimeAdapterName) return true;
  if (
    row.credential_cleanup_terminal_status !== null ||
    row.session_status === "stopping" ||
    row.session_status === "stopped" ||
    row.session_status === "expired" ||
    row.session_status === "failed"
  ) {
    return true;
  }
  const leaseSandboxId = row.session_lease_id?.startsWith(sandboxLeasePrefix)
    ? (row.session_lease_id.slice(sandboxLeasePrefix.length).split(":", 1)[0] ?? null)
    : null;
  const sandboxExpected = credentialPolicySandboxIsExpected(
    leaseSandboxId,
    row.sandbox_id,
    row.session_sandbox_refresh_sandbox_id,
    row.session_sandbox_refresh_claim,
    row.session_sandbox_refresh_claim_expires_at,
    now,
  );
  if (
    sandboxExpected &&
    (row.session_status === "ready" ||
      row.session_status === "attached" ||
      row.session_status === "detached")
  ) {
    // Migrated live sessions can predate agent tokens; the durable lease/refresh fence owns policy.
    return false;
  }
  if (registrationAbandoned) return true;
  if (
    row.policy_state === "active" &&
    (row.session_status === "provisioning" || row.session_status === "pending_adapter") &&
    row.policy_updated_at <= now - credentialPolicyProvisioningStaleMs &&
    (row.session_updated_at ?? Number.NEGATIVE_INFINITY) <=
      now - credentialPolicyProvisioningStaleMs
  ) {
    return true;
  }
  if (
    row.policy_state === "active" &&
    (row.session_status === "ready" ||
      row.session_status === "attached" ||
      row.session_status === "detached")
  ) {
    return true;
  }
  return false;
}
