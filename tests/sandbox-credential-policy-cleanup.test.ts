import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  sandboxManagedOwnershipFencesMatch,
  sandboxTerminalCleanupOwnership,
  stageTerminalCredentialPolicyCleanup,
  terminalCleanupIntentRank,
} from "../src/worker/sandbox-credential-policy-cleanup.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { sessionRow } from "./helpers/session-row.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (sql: string, parameters: unknown[]) => unknown[],
  batchHandler: (statements: PreparedStatement[]) => unknown[],
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              sql,
              parameters,
              async all() {
                return { results: handler(sql, parameters), meta: { changes: 0 } };
              },
              async run() {
                return { meta: { changes: 0 } };
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        return batchHandler(statements as PreparedStatement[]);
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("terminal cleanup derives current Sandbox ownership", () => {
  const leaseId = "sandbox:sandbox-1:terminal-1:autostart-v4";
  assert.deepEqual(
    sandboxTerminalCleanupOwnership(
      sessionRow({
        lease_id: leaseId,
      }),
    ),
    {
      fence: { leaseId, sandboxId: "sandbox-1" },
      sandboxIds: ["sandbox-1"],
      terminalLeaseId: leaseId,
    },
  );
  assert.equal(
    sandboxTerminalCleanupOwnership(sessionRow({ lease_id: "runtime:workspace-1" })),
    null,
  );
});

test("terminal cleanup preserves exact refresh ownership and strips the refresh marker", () => {
  const terminalLeaseId = "sandbox:sandbox-old:terminal-old:autostart-v4";
  const refreshLeaseId = `${terminalLeaseId}:refreshing-900-deadbeef`;
  assert.deepEqual(
    sandboxTerminalCleanupOwnership(
      sessionRow({
        lease_id: refreshLeaseId,
        sandbox_refresh_sandbox_id: "sandbox-new",
        sandbox_refresh_claim: "refresh-claim",
        sandbox_refresh_claim_expires_at: 2_000,
      }),
    ),
    {
      fence: {
        claim: "refresh-claim",
        expiresAt: 2_000,
        refreshLeaseId,
        sandboxId: "sandbox-new",
      },
      sandboxIds: ["sandbox-old", "sandbox-new"],
      terminalLeaseId,
    },
  );

  assert.equal(
    sandboxTerminalCleanupOwnership(
      sessionRow({
        lease_id: refreshLeaseId,
        sandbox_refresh_sandbox_id: "sandbox-new",
        sandbox_refresh_claim: null,
        sandbox_refresh_claim_expires_at: 2_000,
      }),
    ),
    null,
  );
});

test("terminal cleanup fences compare exact ownership variants", () => {
  const current = {
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  };
  const refresh = {
    claim: "refresh-1",
    expiresAt: 2_000,
    refreshLeaseId: `${current.leaseId}:refreshing-900-deadbeef`,
    sandboxId: "sandbox-2",
  };

  assert.equal(sandboxManagedOwnershipFencesMatch(current, { ...current }), true);
  assert.equal(
    sandboxManagedOwnershipFencesMatch(current, { ...current, sandboxId: "sandbox-2" }),
    false,
  );
  assert.equal(sandboxManagedOwnershipFencesMatch(refresh, { ...refresh }), true);
  assert.equal(
    sandboxManagedOwnershipFencesMatch(refresh, { ...refresh, claim: "refresh-2" }),
    false,
  );
  assert.equal(sandboxManagedOwnershipFencesMatch(current, refresh), false);
});

test("terminal cleanup intent only escalates", () => {
  assert.deepEqual(
    ["stopped", "expired", "failed"].map((status) =>
      terminalCleanupIntentRank(status as "stopped" | "expired" | "failed"),
    ),
    [1, 2, 3],
  );
});

test("terminal cleanup rejects stale ownership before touching storage", async () => {
  const leaseId = "sandbox:sandbox-1:terminal-1:autostart-v4";
  assert.equal(
    await stageTerminalCredentialPolicyCleanup(
      {} as RuntimeEnv,
      sessionRow({ lease_id: leaseId }),
      "stopped",
      "stopped",
      1_000,
      undefined,
      { leaseId, sandboxId: "sandbox-2" },
    ),
    false,
  );
});

test("terminal cleanup atomically stages the session and credential-policy refs", async () => {
  const leaseId = "sandbox:sandbox-1:terminal-1:autostart-v4";
  let batch: PreparedStatement[] = [];
  const env = runtimeEnv(
    (sql) => {
      if (/select .*registration_generation/i.test(sql)) {
        return [{ registration_generation: "generation:test-1" }];
      }
      if (/select .*credential_cleanup_terminal_status/i.test(sql)) {
        return [
          {
            status: "stopping",
            credential_cleanup_terminal_status: "failed",
            terminal_failure_reason: "workspace failed",
            updated_at: 1_000,
          },
        ];
      }
      return [];
    },
    (statements) => {
      batch = statements;
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  );

  assert.equal(
    await stageTerminalCredentialPolicyCleanup(
      env,
      sessionRow({
        lease_id: leaseId,
        updated_at: 900,
        agent_token_hash: "agent-token",
        controller: "operator",
      }),
      "failed",
      "workspace failed",
      1_000,
    ),
    true,
  );

  assert.equal(batch.length, 4);
  const sql = batch.map((statement) => statement.sql).join("\n");
  const parameters = batch.flatMap((statement) => statement.parameters);
  assert.match(sql, /update "interactive_sessions"/i);
  assert.match(sql, /"credential_cleanup_terminal_status"/i);
  assert.match(sql, /"agent_token_hash" = \?/i);
  assert.match(sql, /"sandbox_refresh_claim" = \?/i);
  assert.match(sql, /"lease_id" = \?/i);
  assert.match(sql, /on conflict\s*\(session_id, sandbox_id, lookup_id\)/i);
  assert.match(sql, /update "interactive_session_credential_policies"/i);
  assert.match(sql, /update "interactive_session_credential_policy_registrations"/i);
  assert.match(sql, /not exists/i);
  assert.ok(parameters.includes("failed"));
  assert.ok(parameters.includes("generation:test-1"));
  assert.ok(parameters.includes("sandbox-1"));
  assert.ok(parameters.includes(leaseId));
});

test("staged cleanup uses the persisted lookup set with an exact current fallback", async () => {
  const source = await readFile(
    new URL("../src/worker/sandbox-credential-policy-cleanup-service.ts", import.meta.url),
    "utf8",
  );
  const start = source.indexOf("async function reconcileStagedCredentialPolicyRegistration");
  const end = source.indexOf("async function normalizeCredentialPolicyCleanupGroups", start);
  const stagedCleanup = source.slice(start, end);

  assert.match(stagedCleanup, /sandboxCredentialPolicyRegistrationLookupIds/);
  assert.match(stagedCleanup, /registration\.lookup_ids_json/);
  assert.match(stagedCleanup, /sandboxLookupIds\(env, registration\.sandbox_id\)/);
});
