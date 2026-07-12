import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  credentialPolicyProvisioningStaleMs,
  credentialPolicyScanOwnershipFence,
  credentialPolicyScanRequiresCleanup,
  scanCredentialPolicyCleanupPage,
  type CredentialPolicyScanRow,
} from "../src/worker/sandbox-credential-policy-scanner.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { activeSandboxCredentialPolicyGeneration } from "../src/worker/sandbox-credential-policy-repository.ts";

const now = 2_000_000;

type SqliteStatement = {
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

function scannerDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE interactive_sessions (
      id TEXT PRIMARY KEY,
      adapter TEXT,
      status TEXT NOT NULL,
      lease_id TEXT,
      credential_cleanup_terminal_status TEXT,
      sandbox_refresh_sandbox_id TEXT,
      sandbox_refresh_claim TEXT,
      sandbox_refresh_claim_expires_at INTEGER,
      agent_token_hash TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE standalone_sandbox_provisions (
      id TEXT PRIMARY KEY,
      sandbox_id TEXT NOT NULL,
      state TEXT NOT NULL,
      ownership_claim TEXT,
      ownership_claim_expires_at INTEGER,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE interactive_session_credential_policies (
      session_id TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      lookup_id TEXT NOT NULL,
      state TEXT NOT NULL,
      registration_generation TEXT NOT NULL,
      registration_claim TEXT,
      registration_claim_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sandbox_id, lookup_id)
    );
    CREATE TABLE interactive_session_credential_policy_registrations (
      session_id TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      state TEXT NOT NULL,
      registration_generation TEXT NOT NULL,
      registration_claim TEXT,
      registration_claim_expires_at INTEGER,
      registration_write_started INTEGER NOT NULL DEFAULT 0,
      lookup_ids_json TEXT,
      rollback_policies_json TEXT,
      last_error TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sandbox_id)
    );
  `);
  return db;
}

function scannerRuntimeEnv(sqlite: DatabaseSync): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = sqlite.prepare(sql) as unknown as SqliteStatement;
    if (/^\s*(?:select|pragma|with)\b|\breturning\b/i.test(sql)) {
      const results = statement.all(...parameters).map((row) => ({ ...row }));
      const changes = Number(sqlite.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
      return { results, success: true as const, meta: { changes } };
    }
    const result = statement.run(...parameters);
    return {
      results: [],
      success: true as const,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                return execute(sql, parameters);
              },
              async run() {
                return execute(sql, parameters);
              },
            };
          },
        };
      },
    } as unknown as D1Database,
    SANDBOX: {
      idFromName() {
        return { toString: () => "do-current" };
      },
    } as unknown as DurableObjectNamespace,
  } as RuntimeEnv;
}

function scanRow(values: Partial<CredentialPolicyScanRow> = {}): CredentialPolicyScanRow {
  return {
    scan_rowid: 1,
    session_id: "IS-42",
    sandbox_id: "sandbox-1",
    lookup_id: "sandbox-1",
    policy_state: "active",
    registration_generation: "generation:test-1",
    registration_claim: null,
    registration_claim_expires_at: null,
    policy_updated_at: now,
    matched_session_id: "IS-42",
    session_adapter: null,
    session_status: "ready",
    session_lease_id: "sandbox:sandbox-1:terminal-1:autostart-v4",
    credential_cleanup_terminal_status: null,
    session_sandbox_refresh_sandbox_id: null,
    session_sandbox_refresh_claim: null,
    session_sandbox_refresh_claim_expires_at: null,
    session_agent_token_hash: "agent-token",
    session_updated_at: now,
    matched_standalone_id: null,
    standalone_state: null,
    standalone_claim: null,
    standalone_claim_expires_at: null,
    standalone_updated_at: null,
    ...values,
  };
}

test("credential-policy scan derives exact standalone and managed ownership fences", () => {
  assert.deepEqual(
    credentialPolicyScanOwnershipFence(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim: "standalone-claim",
        standalone_claim_expires_at: now + 1,
      }),
      now,
    ),
    {
      claim: "standalone-claim",
      provisionId: "IS-42",
      sandboxId: "sandbox-1",
    },
  );

  assert.deepEqual(credentialPolicyScanOwnershipFence(scanRow(), now), {
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  });

  const refreshLeaseId =
    "sandbox:sandbox-old:terminal-old:autostart-v4:refreshing-1900000-deadbeef";
  assert.deepEqual(
    credentialPolicyScanOwnershipFence(
      scanRow({
        session_lease_id: refreshLeaseId,
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now + 1,
      }),
      now,
    ),
    {
      claim: "refresh-claim",
      expiresAt: now + 1,
      refreshLeaseId,
      sandboxId: "sandbox-1",
    },
  );
});

test("credential-policy scan rejects incomplete, expired, and mismatched ownership", () => {
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim: "standalone-claim",
        standalone_claim_expires_at: now,
      }),
      now,
    ),
    null,
  );
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({
        session_lease_id: "sandbox:sandbox-old:terminal-old:autostart-v4",
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now,
      }),
      now,
    ),
    null,
  );
  assert.equal(
    credentialPolicyScanOwnershipFence(
      scanRow({ matched_session_id: null, session_lease_id: null }),
      now,
    ),
    null,
  );
});

test("staged recovery takes a fresh exclusive claim before promotion or rollback", async () => {
  const source = await readFile(
    new URL("../src/worker/sandbox-credential-policy-scanner.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function scanStagedCredentialPolicyRegistrations");
  const end = source.indexOf("async function readCredentialPolicyScanPage", start);
  const stagedRecovery = source.slice(start, end);

  assert.ok(
    stagedRecovery.indexOf("if (!ownershipFence)") < stagedRecovery.indexOf("restoreRollback({"),
  );
  assert.ok(
    stagedRecovery.indexOf("claimSandboxCredentialPolicyRegistrationRecovery(") <
      stagedRecovery.indexOf("policyExists("),
  );
  assert.ok(
    stagedRecovery.indexOf("claimSandboxCredentialPolicyRegistrationRecovery(") <
      stagedRecovery.indexOf("restoreRollback({"),
  );
  assert.ok(
    stagedRecovery.indexOf("claimSandboxCredentialPolicyRegistrationRecovery(") <
      stagedRecovery.indexOf("sandboxCredentialPolicyRollbackIsSuperseded("),
  );
  assert.ok(
    stagedRecovery.indexOf("sandboxCredentialPolicyRollbackIsSuperseded(") <
      stagedRecovery.indexOf("restoreRollback({"),
  );
  assert.match(stagedRecovery, /sandboxCredentialPolicyRegistrationLookupIds/);
  assert.match(stagedRecovery, /sandboxCredentialPolicyPersistedLookupIds/);
  assert.match(stagedRecovery, /sandboxCredentialPolicyRollbackLookupIds/);
  assert.match(stagedRecovery, /registration\.lookupIds/);
  assert.doesNotMatch(stagedRecovery, /renewSandboxCredentialPolicyRegistration/);
});

test("staged recovery refuses rollback when one historical legacy lookup advances", async () => {
  const sqlite = scannerDatabase();
  const env = scannerRuntimeEnv(sqlite);
  const rollback = ["sandbox-1", "do-rollback"].map((lookupId) => ({
    generation: "generation:rollback",
    policy: {
      allowedHosts: [],
      githubCredentialSource: "none",
      githubRepo: "openclaw/crabfleet",
      owner: "operator",
      sandboxId: lookupId,
      sessionId: "IS-42",
    },
  }));
  sqlite
    .prepare(`
      INSERT INTO interactive_sessions (
        id,
        adapter,
        status,
        lease_id,
        credential_cleanup_terminal_status,
        sandbox_refresh_sandbox_id,
        sandbox_refresh_claim,
        sandbox_refresh_claim_expires_at,
        agent_token_hash,
        updated_at
      ) VALUES (?, NULL, 'ready', ?, NULL, NULL, NULL, NULL, 'agent-token', ?)
    `)
    .run("IS-42", "sandbox:sandbox-1:terminal-1:autostart-v4", now);
  sqlite
    .prepare(`
      INSERT INTO interactive_session_credential_policy_registrations (
        session_id,
        sandbox_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        lookup_ids_json,
        rollback_policies_json,
        last_error,
        updated_at
      ) VALUES (?, ?, 'registering', ?, ?, ?, ?, ?, NULL, ?)
    `)
    .run(
      "IS-42",
      "sandbox-1",
      "generation:stale",
      "registration:stale",
      now - 1,
      JSON.stringify(["sandbox-1", "do-current"]),
      JSON.stringify(rollback),
      now - 1,
    );
  const activeInsert = sqlite.prepare(`
    INSERT INTO interactive_session_credential_policies (
      session_id,
      sandbox_id,
      lookup_id,
      state,
      registration_generation,
      registration_claim,
      registration_claim_expires_at,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, 'active', ?, NULL, NULL, ?, ?)
  `);
  activeInsert.run("IS-42", "sandbox-1", "sandbox-1", "generation:rollback", now, now);
  activeInsert.run("IS-42", "sandbox-1", "do-legacy", "generation:advanced", now, now);
  let rollbackCalls = 0;

  assert.equal(await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"), null);
  await scanCredentialPolicyCleanupPage(
    env,
    now,
    async () => false,
    "IS-42",
    async () => {
      rollbackCalls += 1;
    },
  );

  assert.equal(rollbackCalls, 0);
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT state, registration_claim, registration_claim_expires_at, last_error
          FROM interactive_session_credential_policy_registrations
          WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
        `)
        .get(),
    },
    {
      state: "cleanup_pending",
      registration_claim: null,
      registration_claim_expires_at: null,
      last_error: "sandbox credential policy generation advanced before rollback",
    },
  );
});

test("foreground rollback rechecks its exact claim before restoring policy", async () => {
  const source = await readFile(
    new URL("../src/worker/sandbox-credential-policy-registration-service.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf(
    "export async function restoreSandboxCredentialPolicyRollbackIfOwned",
  );
  const end = source.indexOf("export async function registerSandboxCredentialPolicy", start);
  const rollbackRecovery = source.slice(start, end);

  assert.ok(
    rollbackRecovery.indexOf("renewSandboxCredentialPolicyRegistration(") <
      rollbackRecovery.indexOf("restoreRollback("),
  );
  assert.match(rollbackRecovery, /if \(!registrationExpiresAt\) return false/);
});

test("credential-policy scan preserves live standalone and managed policies", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "active",
      }),
      now,
    ),
    false,
  );
  assert.equal(credentialPolicyScanRequiresCleanup(scanRow(), now), false);
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_lease_id: "sandbox:sandbox-old:terminal-old:autostart-v4",
        session_sandbox_refresh_sandbox_id: "sandbox-1",
        session_sandbox_refresh_claim: "refresh-claim",
        session_sandbox_refresh_claim_expires_at: now + 1,
      }),
      now,
    ),
    false,
  );
});

test("credential-policy scan cleans terminal, orphaned, adapter, and expired owners", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        matched_session_id: null,
        session_lease_id: null,
        matched_standalone_id: "IS-42",
        standalone_state: "provisioning",
        standalone_claim_expires_at: now,
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({ matched_session_id: null, session_lease_id: null }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(scanRow({ session_adapter: "runtime-v1" }), now),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({ credential_cleanup_terminal_status: "stopped" }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(scanRow({ session_status: "failed" }), now),
    true,
  );
});

test("credential-policy scan cleans abandoned and stale registrations", () => {
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({ registration_generation: "legacy:IS-42:sandbox-1" }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        policy_state: "registering",
        registration_claim: null,
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_status: "provisioning",
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
        policy_updated_at: now - credentialPolicyProvisioningStaleMs,
        session_updated_at: now - credentialPolicyProvisioningStaleMs,
      }),
      now,
    ),
    true,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_status: "provisioning",
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
        policy_updated_at: now - credentialPolicyProvisioningStaleMs + 1,
        session_updated_at: now - credentialPolicyProvisioningStaleMs,
      }),
      now,
    ),
    false,
  );
  assert.equal(
    credentialPolicyScanRequiresCleanup(
      scanRow({
        session_lease_id: "sandbox:sandbox-other:terminal-other:autostart-v4",
      }),
      now,
    ),
    true,
  );
});
