import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  activeSandboxCredentialPolicyGeneration,
  abandonSandboxCredentialPolicyRegistration,
  beginSandboxCredentialPolicyRegistration,
  claimSandboxCredentialPolicyRegistrationRecovery,
  currentSandboxCredentialPolicyGeneration,
  finishSandboxCredentialPolicyRegistration,
  recordSandboxCredentialPolicyRefs,
  recordSandboxCredentialPolicyRollback,
  renewSandboxCredentialPolicyRegistration,
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

type SqliteStatement = {
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

type BoundStatement = PreparedStatement & {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
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

function credentialPolicyDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE interactive_sessions (
      id TEXT PRIMARY KEY,
      adapter TEXT,
      status TEXT NOT NULL,
      credential_cleanup_terminal_status TEXT,
      agent_token_hash TEXT,
      lease_id TEXT,
      sandbox_refresh_sandbox_id TEXT,
      sandbox_refresh_claim TEXT,
      sandbox_refresh_claim_expires_at INTEGER
    );
    CREATE TABLE interactive_session_credential_policies (
      session_id TEXT NOT NULL,
      sandbox_id TEXT NOT NULL,
      lookup_id TEXT NOT NULL,
      state TEXT NOT NULL,
      registration_generation TEXT NOT NULL,
      registration_claim TEXT,
      registration_claim_expires_at INTEGER,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_attempt_at INTEGER,
      last_error TEXT,
      cleanup_claim TEXT,
      cleanup_claim_expires_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, sandbox_id, lookup_id)
    );
    INSERT INTO interactive_sessions (
      id,
      adapter,
      status,
      credential_cleanup_terminal_status,
      agent_token_hash,
      lease_id
    ) VALUES (
      'IS-42',
      NULL,
      'ready',
      NULL,
      'agent-token',
      'sandbox:sandbox-1:terminal-1:autostart-v4'
    );
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
    ) VALUES
      ('IS-42', 'sandbox-1', 'sandbox-1', 'active', 'generation:existing', NULL, NULL, 1, 1),
      ('IS-42', 'sandbox-1', 'do-1', 'active', 'generation:existing', NULL, NULL, 1, 1);
  `);
  db.exec(
    readFileSync(
      new URL("../migrations/0034_credential_policy_registration_staging.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(
    readFileSync(
      new URL("../migrations/0035_credential_policy_registration_rollback.sql", import.meta.url),
      "utf8",
    ),
  );
  return db;
}

function sqliteRuntimeEnv(
  sqlite: DatabaseSync,
  options: { interruptAfterStatement?: number } = {},
): RuntimeEnv {
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
            const bound = {
              sql,
              parameters,
              execute: () => execute(sql, parameters),
              async all() {
                return bound.execute();
              },
              async run() {
                return bound.execute();
              },
            };
            return bound;
          },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const [index, statement] of statements.entries()) {
            results.push((statement as unknown as BoundStatement).execute());
            if (options.interruptAfterStatement === index + 1) {
              throw new Error("simulated batch interruption");
            }
          }
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
    SANDBOX: {
      idFromName() {
        return { toString: () => "do-1" };
      },
    } as unknown as DurableObjectNamespace,
  } as RuntimeEnv;
}

const ownershipFence: SandboxCredentialPolicyOwnershipFence = {
  leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
  sandboxId: "sandbox-1",
};

function activeCredentialPolicyRows(db: DatabaseSync): Record<string, unknown>[] {
  return db
    .prepare(`
      SELECT lookup_id, state, registration_generation, registration_claim
      FROM interactive_session_credential_policies
      ORDER BY lookup_id
    `)
    .all()
    .map((row) => ({ ...row }));
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
  assert.match(current.sql, /interactive_session_credential_policy_registrations/i);
  assert.match(current.sql, /adapter is null|adapter !=/i);
  assert.match(current.sql, /agent_token_hash is not null/i);
  assert.match(current.sql, /lease_id =/i);
  assert.match(current.sql, /sandbox_refresh_claim is null/i);
  assert.match(current.sql, /state = 'registering'/i);
  assert.match(current.sql, /registration_claim_expires_at >/i);
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

test("credential-policy rotation always claims a fresh generation", async () => {
  let generation = "";
  let claim = "";
  let registrationExpiresAt = 0;
  let statements: PreparedStatement[] = [];
  const env = runtimeEnv(
    (sql, _parameters, kind) => {
      if (
        kind === "all" &&
        /select .*state/i.test(sql) &&
        /interactive_session_credential_policy_registrations/i.test(sql)
      ) {
        return {
          results: [
            {
              state: "registering",
              registration_generation: generation,
              registration_claim: claim,
              registration_claim_expires_at: registrationExpiresAt,
            },
          ],
        };
      }
      return {};
    },
    (prepared) => {
      statements = prepared;
      const parameters = prepared.flatMap((statement) => statement.parameters);
      generation = String(
        parameters.find(
          (parameter) =>
            typeof parameter === "string" &&
            parameter.startsWith("generation:") &&
            parameter !== "generation:existing",
        ),
      );
      claim = String(
        parameters.find(
          (parameter) => typeof parameter === "string" && parameter.startsWith("registration:"),
        ),
      );
      registrationExpiresAt = Math.max(
        ...parameters.filter((parameter): parameter is number => typeof parameter === "number"),
      );
      return prepared.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  );

  const rotated = await beginSandboxCredentialPolicyRegistration(env, "IS-42", "sandbox-1", {
    leaseId: "sandbox:sandbox-1:terminal-1:autostart-v4",
    sandboxId: "sandbox-1",
  });

  assert.equal(statements.length, 1);
  assert.match(rotated.generation, /^generation:/);
  assert.notEqual(rotated.generation, "generation:existing");
  assert.equal(rotated.generation, generation);
});

test("post-migration legacy registration claims block new staged generations", async () => {
  const sqlite = credentialPolicyDatabase();
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-worker',
        registration_claim = 'legacy-registration',
        registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);

  await assert.rejects(
    beginSandboxCredentialPolicyRegistration(
      sqliteRuntimeEnv(sqlite),
      "IS-42",
      "sandbox-1",
      ownershipFence,
    ),
    { message: "sandbox credential policy registration is unavailable" },
  );

  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS count FROM interactive_session_credential_policy_registrations")
      .get()?.count,
    0,
  );
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => ({
      generation: row.registration_generation,
      state: row.state,
      claim: row.registration_claim,
    })),
    [
      {
        generation: "generation:legacy-worker",
        state: "registering",
        claim: "legacy-registration",
      },
      {
        generation: "generation:legacy-worker",
        state: "registering",
        claim: "legacy-registration",
      },
    ],
  );
});

test("legacy claims created after staging block promotion without interleaving generations", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-race',
        registration_claim = 'legacy-race-claim',
        registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);

  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    false,
  );
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => ({
      generation: row.registration_generation,
      state: row.state,
    })),
    [
      { generation: "generation:legacy-race", state: "registering" },
      { generation: "generation:legacy-race", state: "registering" },
    ],
  );
  assert.equal(
    sqlite
      .prepare(`
        SELECT registration_generation
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.registration_generation,
    staged.generation,
  );
});

test("partial credential-policy rotation failure preserves the prior active generation", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const rollback = ["sandbox-1", "do-1"].map((lookupId) => ({
    generation: "generation:existing",
    policy: {
      allowedHosts: [],
      githubCredentialSource: "none" as const,
      githubRepo: "openclaw/crabfleet",
      owner: "operator",
      sandboxId: lookupId,
      sessionId: "IS-42",
    },
  }));
  assert.equal(
    await recordSandboxCredentialPolicyRollback(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      rollback,
      ownershipFence,
    ),
    true,
  );

  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => row.registration_generation),
    ["generation:existing", "generation:existing"],
  );

  await abandonSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    staged,
    "simulated Durable Object registration failure",
  );

  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => row.registration_generation),
    ["generation:existing", "generation:existing"],
  );
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT
            state,
            registration_generation,
            registration_claim,
            rollback_policies_json,
            last_error
          FROM interactive_session_credential_policy_registrations
          WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
        `)
        .get(),
    },
    {
      state: "cleanup_pending",
      registration_generation: staged.generation,
      registration_claim: null,
      rollback_policies_json: JSON.stringify(rollback),
      last_error: "simulated Durable Object registration failure",
    },
  );
});

test("stale foreground rollback cannot renew after recovery takes its claim", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const expiredAt = 1;
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(expiredAt);
  const recovery = await claimSandboxCredentialPolicyRegistrationRecovery(
    env,
    "IS-42",
    "sandbox-1",
    staged,
    expiredAt,
    ownershipFence,
  );
  assert.ok(recovery);

  const renewed = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    staged,
    ownershipFence,
  );

  assert.equal(renewed, null);
});

test("expired registration recovery grants one fresh exclusive claim", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const expiredAt = 1;
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(expiredAt);

  const claims = await Promise.all([
    claimSandboxCredentialPolicyRegistrationRecovery(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      expiredAt,
      ownershipFence,
    ),
    claimSandboxCredentialPolicyRegistrationRecovery(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      expiredAt,
      ownershipFence,
    ),
  ]);
  const winner = claims.find((claim) => claim !== null);

  assert.equal(claims.filter((claim) => claim !== null).length, 1);
  assert.ok(winner);
  assert.notEqual(winner.registration.claim, staged.claim);
  assert.ok(winner.registrationExpiresAt > expiredAt);
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT registration_generation, registration_claim, registration_claim_expires_at
          FROM interactive_session_credential_policy_registrations
          WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
        `)
        .get(),
    },
    {
      registration_generation: staged.generation,
      registration_claim: winner.registration.claim,
      registration_claim_expires_at: winner.registrationExpiresAt,
    },
  );
});

test("completed credential-policy rotation atomically promotes every active lookup", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );

  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    true,
  );
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => ({
      generation: row.registration_generation,
      state: row.state,
    })),
    [
      { generation: staged.generation, state: "active" },
      { generation: staged.generation, state: "active" },
    ],
  );
  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS count FROM interactive_session_credential_policy_registrations")
      .get()?.count,
    0,
  );
});

test("interrupted credential-policy promotion rolls back every active lookup", async () => {
  const sqlite = credentialPolicyDatabase();
  const staged = await beginSandboxCredentialPolicyRegistration(
    sqliteRuntimeEnv(sqlite),
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );

  await assert.rejects(
    finishSandboxCredentialPolicyRegistration(
      sqliteRuntimeEnv(sqlite, { interruptAfterStatement: 1 }),
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    /simulated batch interruption/,
  );
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => row.registration_generation),
    ["generation:existing", "generation:existing"],
  );
  assert.equal(
    sqlite
      .prepare(`
        SELECT registration_generation
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.registration_generation,
    staged.generation,
  );
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
