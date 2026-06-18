import assert from "node:assert/strict";
import test from "node:test";

import {
  activeSandboxCredentialPolicyGeneration,
  currentSandboxCredentialPolicyGeneration,
  recordSandboxCredentialPolicyRefs,
  sandboxCredentialPolicyRegistrationQueries,
  sandboxLookupIds,
  type SandboxCredentialPolicyOwnershipFence,
} from "../src/worker/sandbox-credential-policy-repository.ts";
import { database } from "../src/worker/database.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { SandboxCredentialPolicyRegistration } from "../src/worker/session-control-policy.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (
    sql: string,
    parameters: unknown[],
    kind: "all" | "run",
  ) => {
    results?: unknown[];
    changes?: number;
  } = () => ({}),
  batchHandler: (statements: PreparedStatement[]) => unknown[] = () => [],
  durableObjectId?: string,
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
                const result = handler(sql, parameters, "all");
                return { results: result.results ?? [], meta: { changes: result.changes ?? 0 } };
              },
              async run() {
                const result = handler(sql, parameters, "run");
                return { meta: { changes: result.changes ?? 0 } };
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        return batchHandler(statements as PreparedStatement[]);
      },
    } as unknown as D1Database,
    ...(durableObjectId
      ? {
          SANDBOX: {
            idFromName() {
              return { toString: () => durableObjectId };
            },
          } as unknown as DurableObjectNamespace,
        }
      : {}),
  } as RuntimeEnv;
}

const registration: SandboxCredentialPolicyRegistration = {
  generation: "generation:test-1",
  claim: "registration-1",
  lookupIds: ["sandbox-1"],
};

function registrationSql(fence: SandboxCredentialPolicyOwnershipFence): {
  sql: string;
  parameters: readonly unknown[];
} {
  const env = runtimeEnv();
  return sandboxCredentialPolicyRegistrationQueries(
    "IS-42",
    "sandbox-1",
    registration,
    2_000,
    1_000,
    fence,
  )[0]!.compile(database(env));
}

test("credential-policy lookup identity includes the Sandbox durable object id exactly once", () => {
  assert.deepEqual(sandboxLookupIds(runtimeEnv(), "sandbox-1"), ["sandbox-1"]);
  assert.deepEqual(sandboxLookupIds(runtimeEnv(undefined, undefined, "do-1"), "sandbox-1"), [
    "sandbox-1",
    "do-1",
  ]);
  assert.deepEqual(sandboxLookupIds(runtimeEnv(undefined, undefined, "sandbox-1"), "sandbox-1"), [
    "sandbox-1",
  ]);
});

test("credential-policy generations reuse exactly one current identity", () => {
  assert.equal(currentSandboxCredentialPolicyGeneration([]), null);
  assert.equal(
    currentSandboxCredentialPolicyGeneration(["generation:test-1"]),
    "generation:test-1",
  );
  assert.equal(currentSandboxCredentialPolicyGeneration(["legacy:test-1"]), null);
  assert.equal(
    currentSandboxCredentialPolicyGeneration(["generation:test-1", "legacy:test-1"]),
    null,
  );
  assert.equal(
    currentSandboxCredentialPolicyGeneration(["generation:test-1", "generation:test-2"]),
    null,
  );
});

test("credential-policy registration SQL proves every supported ownership fence", () => {
  const current = registrationSql({
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  });
  assert.match(current.sql, /from interactive_sessions/i);
  assert.match(current.sql, /adapter is null|adapter !=/i);
  assert.match(current.sql, /agent_token_hash is not null/i);
  assert.match(current.sql, /lease_id =/i);
  assert.match(current.sql, /sandbox_refresh_claim is null/i);
  assert.ok(current.parameters.includes("sandbox:sandbox-1:terminal-1:autostart-v4"));
  assert.doesNotMatch(current.sql, /1 = 1/);

  const refresh = registrationSql({
    claim: "refresh-1",
    expiresAt: 3_000,
    refreshLeaseId: "sandbox:sandbox-old:terminal-old:autostart-v4:refreshing",
    sandboxId: "sandbox-1",
  });
  assert.match(refresh.sql, /sandbox_refresh_sandbox_id =/i);
  assert.match(refresh.sql, /sandbox_refresh_claim =/i);
  assert.match(refresh.sql, /sandbox_refresh_claim_expires_at >/i);
  assert.ok(refresh.parameters.includes("refresh-1"));
  assert.ok(refresh.parameters.includes("sandbox-1"));

  const standalone = registrationSql({
    claim: "standalone-1",
    provisionId: "external-42",
    sandboxId: "sandbox-1",
  });
  assert.match(standalone.sql, /from standalone_sandbox_provisions as owner/i);
  assert.match(standalone.sql, /owner\.state = 'provisioning'/i);
  assert.match(standalone.sql, /owner\.ownership_claim =/i);
  assert.match(standalone.sql, /owner\.ownership_claim_expires_at >/i);
  assert.ok(standalone.parameters.includes("external-42"));
  assert.ok(standalone.parameters.includes("standalone-1"));
});

test("active credential-policy generation requires every exact lookup row", async () => {
  const rows = [
    {
      lookup_id: "sandbox-1",
      state: "active",
      registration_generation: "generation:test-1",
      registration_claim: null,
    },
    {
      lookup_id: "do-1",
      state: "active",
      registration_generation: "generation:test-1",
      registration_claim: null,
    },
  ];
  const env = runtimeEnv(() => ({ results: rows }), undefined, "do-1");
  assert.equal(
    await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"),
    "generation:test-1",
  );

  rows[0] = { ...rows[0]!, registration_generation: "legacy:test-1" };
  rows[1] = { ...rows[1]!, registration_generation: "legacy:test-1" };
  assert.equal(await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"), null);

  rows[0] = { ...rows[0]!, registration_generation: "generation:test-1" };
  rows[1] = { ...rows[1]!, registration_generation: "generation:test-1" };
  rows[1] = { ...rows[1]!, registration_claim: "stale" };
  assert.equal(await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"), null);
});

test("recording active policy refs promotes then upserts every lookup under one fence", async () => {
  const rows = [
    {
      lookup_id: "sandbox-1",
      state: "active",
      registration_generation: "generation:test-1",
      registration_claim: null,
    },
    {
      lookup_id: "do-1",
      state: "active",
      registration_generation: "generation:test-1",
      registration_claim: null,
    },
  ];
  let batch: PreparedStatement[] = [];
  const env = runtimeEnv(
    (sql, _parameters, kind) =>
      kind === "all" && /select .*lookup_id/i.test(sql) ? { results: rows } : { changes: 2 },
    (statements) => {
      batch = statements;
      return statements.map(() => ({ results: [], meta: { changes: 1 } }));
    },
    "do-1",
  );

  assert.equal(
    await recordSandboxCredentialPolicyRefs(
      env,
      "IS-42",
      "sandbox-1",
      "active",
      "generation:test-1",
      {
        leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
        sandboxId: "sandbox-1",
      },
      1_000,
    ),
    true,
  );
  assert.equal(batch.length, 2);
  const sql = batch.map((statement) => statement.sql).join("\n");
  assert.match(sql, /on conflict\(session_id, sandbox_id, lookup_id\) do update/i);
  assert.match(sql, /state = 'cleanup_pending'/i);
  assert.match(sql, /registration_claim is not null/i);
  const parameters = batch.flatMap((statement) => statement.parameters);
  assert.ok(parameters.includes("sandbox-1"));
  assert.ok(parameters.includes("do-1"));
  assert.ok(parameters.includes("generation:test-1"));
});
