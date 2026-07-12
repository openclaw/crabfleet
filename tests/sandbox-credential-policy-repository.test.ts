import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  activeSandboxCredentialPolicyGeneration,
  abandonSandboxCredentialPolicyRegistration,
  beginSandboxCredentialPolicyRegistration,
  claimObsoleteSandboxCredentialPolicyReferences,
  claimSandboxCredentialPolicyRegistrationRecovery,
  currentSandboxCredentialPolicyGeneration,
  finishSandboxCredentialPolicyRegistration,
  incompleteSandboxCredentialPolicyGeneration,
  markSandboxCredentialPolicyRegistrationWriteStarted,
  recordSandboxCredentialPolicyRefs,
  recordSandboxCredentialPolicyRollback,
  repairSandboxCredentialPolicyReferences,
  retireObsoleteSandboxCredentialPolicyReference,
  renewSandboxCredentialPolicyRegistration,
  sandboxCredentialPolicyLookupIdsForGeneration,
  sandboxCredentialPolicyPersistedLookupIds,
  sandboxCredentialPolicyRegistrationQueries,
  sandboxLookupIds,
  stageSandboxCredentialPolicyReferenceRepair,
  type SandboxCredentialPolicyOwnershipFence,
} from "../src/worker/sandbox-credential-policy-repository.ts";
import { captureSandboxCredentialPolicyRollback } from "../src/worker/sandbox-credential-policy-rollback.ts";
import { credentialPolicyRegistrationAccepted } from "../src/credential-policy-fence.ts";
import { database } from "../src/worker/database.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { SandboxCredentialPolicyRegistration } from "../src/worker/session-control-policy.ts";
import {
  sandboxCredentialPolicyRegistrationLookupIds,
  sandboxCredentialPolicyRollbackLookupIds,
} from "../src/worker/session-control-policy.ts";
import type { StoredSandboxCredentialPolicy } from "../src/worker/session-control-policy.ts";

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

function credentialPolicyDatabase(options: { applyMigrations?: boolean } = {}): DatabaseSync {
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
  if (options.applyMigrations !== false) {
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
    db.exec(
      readFileSync(
        new URL("../migrations/0036_credential_policy_lookup_repair.sql", import.meta.url),
        "utf8",
      ),
    );
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0037_credential_policy_registration_lookup_ids.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    db.exec(
      readFileSync(
        new URL(
          "../migrations/0040_credential_policy_registration_write_fence.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }
  return db;
}

function sqliteRuntimeEnv(
  sqlite: DatabaseSync,
  options: {
    durableObjectId?: string;
    interruptAfterStatement?: number;
    throwAfterCommit?: boolean;
    failNextReadAfterBatch?: boolean;
  } = {},
): RuntimeEnv {
  let failNextRead = false;
  function execute(sql: string, parameters: unknown[]) {
    if (failNextRead && /^\s*select\b/i.test(sql)) {
      failNextRead = false;
      throw new Error("simulated committed read failure");
    }
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
          failNextRead = options.failNextReadAfterBatch ?? false;
          if (options.throwAfterCommit) {
            throw new Error("simulated ambiguous committed batch");
          }
          return results;
        } catch (error) {
          if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
    SANDBOX: {
      idFromName() {
        return { toString: () => options.durableObjectId ?? "do-1" };
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

test("staged lookup identity decoder requires the stable sandbox lookup", () => {
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds('["sandbox-1","do-old"]', "sandbox-1", [
      "sandbox-1",
      "do-current",
    ]),
    ["sandbox-1", "do-old"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds('["do-old"]', "sandbox-1", [
      "sandbox-1",
      "do-current",
    ]),
    ["sandbox-1"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds('["sandbox-1","sandbox-1"]', "sandbox-1", [
      "sandbox-1",
      "do-current",
    ]),
    ["sandbox-1"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds(null, "sandbox-1", ["sandbox-1", "do-current"]),
    ["sandbox-1", "do-current"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds(
      null,
      "sandbox-1",
      ["sandbox-1", "do-current"],
      ["do-persisted", "do-rollback", "do-persisted"],
    ),
    ["sandbox-1", "do-current", "do-persisted", "do-rollback"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds(null, "sandbox-1", ["do-current"]),
    ["sandbox-1"],
  );
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds("{", "sandbox-1", ["sandbox-1", "do-current"]),
    ["sandbox-1"],
  );
});

test("rollback lookup decoder preserves exact valid historical identities", () => {
  const rollbackJson = JSON.stringify([
    {
      generation: "generation:existing",
      policy: {
        allowedHosts: [],
        githubRepo: "openclaw/crabfleet",
        owner: "operator",
        sandboxId: "sandbox-1",
        sessionId: "IS-42",
      },
    },
    {
      generation: "generation:existing",
      policy: {
        allowedHosts: [],
        githubRepo: "openclaw/crabfleet",
        owner: "operator",
        sandboxId: "do-old",
        sessionId: "IS-42",
      },
    },
  ]);
  assert.deepEqual(sandboxCredentialPolicyRollbackLookupIds(rollbackJson, "IS-42"), [
    "sandbox-1",
    "do-old",
  ]);
  assert.throws(
    () => sandboxCredentialPolicyRollbackLookupIds(rollbackJson, "IS-other"),
    /rollback snapshot is invalid/,
  );
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
              lookup_ids_json: '["sandbox-1"]',
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

test("migration leaves live legacy registrations unstaged while old workers renew them", () => {
  const sqlite = credentialPolicyDatabase({ applyMigrations: false });
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-worker',
        registration_claim = 'legacy-registration',
        registration_claim_expires_at = 1000,
        updated_at = 500
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0034_credential_policy_registration_staging.sql", import.meta.url),
      "utf8",
    ),
  );

  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET registration_claim_expires_at = 3000, updated_at = 2000
      WHERE session_id = 'IS-42'
        AND sandbox_id = 'sandbox-1'
        AND registration_claim = 'legacy-registration'
    `)
    .run();

  assert.equal(
    sqlite
      .prepare(`
        SELECT count(*) AS count
        FROM interactive_session_credential_policy_registrations
        WHERE state = 'registering' AND registration_claim_expires_at <= 2000
      `)
      .get()?.count,
    0,
  );
  assert.deepEqual(
    sqlite
      .prepare(`
        SELECT DISTINCT state, registration_generation, registration_claim,
          registration_claim_expires_at
        FROM interactive_session_credential_policies
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .all()
      .map((row) => ({ ...row })),
    [
      {
        state: "registering",
        registration_generation: "generation:legacy-worker",
        registration_claim: "legacy-registration",
        registration_claim_expires_at: 3000,
      },
    ],
  );
});

test("pre-0037 recovery preserves current, persisted, and rollback lookup identities", async () => {
  const sqlite = credentialPolicyDatabase({ applyMigrations: false });
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0034_credential_policy_registration_staging.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0035_credential_policy_registration_rollback.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0036_credential_policy_lookup_repair.sql", import.meta.url),
      "utf8",
    ),
  );
  const rollback = [
    {
      generation: "generation:existing",
      policy: {
        allowedHosts: [],
        githubCredentialSource: "none",
        githubRepo: "openclaw/crabfleet",
        owner: "operator",
        sandboxId: "sandbox-1",
        sessionId: "IS-42",
      },
    },
    {
      generation: "generation:existing",
      policy: {
        allowedHosts: [],
        githubCredentialSource: "none",
        githubRepo: "openclaw/crabfleet",
        owner: "operator",
        sandboxId: "do-rollback-old",
        sessionId: "IS-42",
      },
    },
  ];
  sqlite
    .prepare(`
      INSERT INTO interactive_session_credential_policy_registrations (
        session_id,
        sandbox_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        rollback_policies_json,
        created_at,
        updated_at
      ) VALUES (?, ?, 'registering', ?, ?, ?, ?, 1, 1)
    `)
    .run(
      "IS-42",
      "sandbox-1",
      "generation:staged",
      "registration:staged",
      Number.MAX_SAFE_INTEGER,
      JSON.stringify(rollback),
    );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0037_credential_policy_registration_lookup_ids.sql", import.meta.url),
      "utf8",
    ),
  );

  const row = sqlite
    .prepare(`
      SELECT lookup_ids_json, repair_generation, rollback_policies_json
      FROM interactive_session_credential_policy_registrations
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .get();
  const env = sqliteRuntimeEnv(sqlite, { durableObjectId: "do-current" });
  const persistedLookupIds = await sandboxCredentialPolicyPersistedLookupIds(
    env,
    "IS-42",
    "sandbox-1",
  );
  const rollbackLookupIds = sandboxCredentialPolicyRollbackLookupIds(
    String(row?.rollback_policies_json),
    "IS-42",
  );
  assert.equal(row?.lookup_ids_json, null);
  assert.deepEqual(persistedLookupIds, ["do-1", "sandbox-1"]);
  assert.deepEqual(rollbackLookupIds, ["sandbox-1", "do-rollback-old"]);
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds(
      row?.lookup_ids_json as string | null,
      "sandbox-1",
      sandboxLookupIds(env, "sandbox-1"),
      [...persistedLookupIds, ...rollbackLookupIds],
    ),
    ["sandbox-1", "do-current", "do-1", "do-rollback-old"],
  );
  assert.equal(row?.repair_generation, null);
});

test("post-migration legacy staging recovers the current sandbox lookup set", () => {
  const sqlite = credentialPolicyDatabase();
  sqlite
    .prepare(`
      INSERT INTO interactive_session_credential_policy_registrations (
        session_id,
        sandbox_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        created_at,
        updated_at
      ) VALUES (?, ?, 'registering', ?, ?, ?, 1, 1)
    `)
    .run(
      "IS-42",
      "sandbox-1",
      "generation:legacy-staged",
      "registration:legacy-staged",
      Number.MAX_SAFE_INTEGER,
    );

  const row = sqlite
    .prepare(`
      SELECT lookup_ids_json
      FROM interactive_session_credential_policy_registrations
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .get();
  const env = sqliteRuntimeEnv(sqlite);
  assert.equal(row?.lookup_ids_json, null);
  assert.deepEqual(
    sandboxCredentialPolicyRegistrationLookupIds(
      row?.lookup_ids_json as string | null,
      "sandbox-1",
      sandboxLookupIds(env, "sandbox-1"),
    ),
    ["sandbox-1", "do-1"],
  );
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

test("staged rotations fence old-worker writes until the staged row is removed", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const legacyClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-race',
        registration_claim = 'legacy-race-claim',
        registration_claim_expires_at = ?,
        updated_at = 2000
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyClaim.changes, 0);

  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => ({
      generation: row.registration_generation,
      state: row.state,
    })),
    [
      { generation: "generation:existing", state: "active" },
      { generation: "generation:existing", state: "active" },
    ],
  );

  await abandonSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    staged,
    "simulated registration failure after rollback",
  );

  const legacyCompletion = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'active',
        registration_claim = NULL,
        registration_claim_expires_at = NULL,
        updated_at = 3000
      WHERE session_id = 'IS-42'
        AND sandbox_id = 'sandbox-1'
        AND registration_generation = 'generation:legacy-race'
        AND registration_claim = 'legacy-race-claim'
    `)
    .run();
  assert.equal(legacyCompletion.changes, 0);

  const legacyDelete = sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policies
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  assert.equal(legacyDelete.changes, 0);

  const legacyInsert = sqlite
    .prepare(`
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
      ) VALUES (
        'IS-42',
        'sandbox-1',
        'legacy-extra',
        'registering',
        'generation:legacy-race',
        'legacy-race-claim',
        ?,
        2000,
        2000
      )
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyInsert.changes, 0);

  assert.equal(
    sqlite
      .prepare(`
        SELECT state
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.state,
    "cleanup_pending",
  );

  sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policy_registrations
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  const postFenceClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-after-fence',
        registration_claim = 'legacy-after-fence-claim',
        registration_claim_expires_at = ?,
        updated_at = 4000
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(postFenceClaim.changes, 2);
});

test("expired pre-write staged rotations release the legacy worker compatibility fence", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  await beginSandboxCredentialPolicyRegistration(env, "IS-42", "sandbox-1", ownershipFence);
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = 0, updated_at = 0
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();

  const legacyClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-rollback',
        registration_claim = 'legacy-rollback-claim',
        registration_claim_expires_at = ?,
        updated_at = 1
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);

  assert.equal(legacyClaim.changes, 2);
  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS count FROM interactive_session_credential_policy_registrations")
      .get()?.count,
    1,
  );
});

test("started staged rotations retain the legacy fence after claim expiry", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  const staged = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  assert.ok(
    await markSandboxCredentialPolicyRegistrationWriteStarted(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
  );
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = 0, updated_at = 0
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();

  const legacyClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-rollback',
        registration_claim = 'legacy-rollback-claim',
        registration_claim_expires_at = ?,
        updated_at = 1
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  const legacyCleanupInsert = sqlite
    .prepare(`
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
      ) VALUES (
        'IS-42',
        'sandbox-1',
        'legacy-cleanup',
        'cleanup_pending',
        'generation:existing',
        NULL,
        NULL,
        1,
        1
      )
    `)
    .run();
  const legacyDelete = sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policies
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();

  assert.equal(legacyClaim.changes, 0);
  assert.equal(legacyCleanupInsert.changes, 0);
  assert.equal(legacyDelete.changes, 0);
  assert.equal(
    sqlite
      .prepare(`
        SELECT registration_write_started
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.registration_write_started,
    1,
  );
  assert.ok(
    await claimSandboxCredentialPolicyRegistrationRecovery(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      0,
      ownershipFence,
    ),
  );
});

test("write-fence migration conservatively protects existing staged rotations", () => {
  const sqlite = credentialPolicyDatabase({ applyMigrations: false });
  for (const migration of [
    "0034_credential_policy_registration_staging.sql",
    "0035_credential_policy_registration_rollback.sql",
    "0036_credential_policy_lookup_repair.sql",
    "0037_credential_policy_registration_lookup_ids.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
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
        created_at,
        updated_at
      ) VALUES (?, ?, 'registering', ?, ?, 0, ?, 1, 0)
    `)
    .run(
      "IS-42",
      "sandbox-1",
      "generation:pre-write-fence",
      "registration:pre-write-fence",
      JSON.stringify(["sandbox-1", "do-1"]),
    );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0040_credential_policy_registration_write_fence.sql", import.meta.url),
      "utf8",
    ),
  );

  assert.equal(
    sqlite
      .prepare(`
        SELECT registration_write_started
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.registration_write_started,
    1,
  );
  assert.equal(
    sqlite
      .prepare(`
        UPDATE interactive_session_credential_policies
        SET registration_generation = 'generation:legacy-after-rollback'
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .run().changes,
    0,
  );
});

test("stale staged cleanup releases legacy deletion but an active cleanup claim stays fenced", async () => {
  const sqlite = credentialPolicyDatabase();
  const env = sqliteRuntimeEnv(sqlite);
  await beginSandboxCredentialPolicyRegistration(env, "IS-42", "sandbox-1", ownershipFence);
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET
        state = 'cleanup_pending',
        registration_claim = NULL,
        registration_claim_expires_at = NULL,
        cleanup_claim = 'cleanup:new-worker',
        cleanup_claim_expires_at = ?,
        updated_at = 0
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);

  const fencedDelete = sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policies
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  assert.equal(fencedDelete.changes, 0);

  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET cleanup_claim = NULL, cleanup_claim_expires_at = NULL, updated_at = 0
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  const legacyDelete = sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policies
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  assert.equal(legacyDelete.changes, 2);
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

test("expired staged registration claims cannot be revived by renewal", async () => {
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

  assert.equal(
    await renewSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    null,
  );
  assert.equal(
    sqlite
      .prepare(`
        SELECT registration_claim_expires_at
        FROM interactive_session_credential_policy_registrations
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .get()?.registration_claim_expires_at,
    expiredAt,
  );
});

test("staged renewal cannot extend across a live legacy registration claim", async () => {
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
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = 1
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();
  const legacyClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-renewal',
        registration_claim = 'registration:legacy-renewal',
        registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyClaim.changes, 2);
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);

  assert.equal(
    await renewSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    null,
  );
  assert.deepEqual(
    sqlite
      .prepare(`
        SELECT DISTINCT registration_generation, registration_claim, registration_claim_expires_at
        FROM interactive_session_credential_policies
        WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
      `)
      .all()
      .map((row) => ({ ...row })),
    [
      {
        registration_generation: "generation:legacy-renewal",
        registration_claim: "registration:legacy-renewal",
        registration_claim_expires_at: Number.MAX_SAFE_INTEGER,
      },
    ],
  );
});

test("expired staged recovery cannot race a live legacy registration owner", async () => {
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
  const legacyClaim = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_generation = 'generation:legacy-recovery',
        registration_claim = 'registration:legacy-recovery',
        registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyClaim.changes, 2);

  const recoveries = await Promise.all([
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

  assert.deepEqual(recoveries, [null, null]);
  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT registration_claim, registration_claim_expires_at
          FROM interactive_session_credential_policy_registrations
          WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
        `)
        .get(),
    },
    {
      registration_claim: staged.claim,
      registration_claim_expires_at: expiredAt,
    },
  );
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => ({
      generation: row.registration_generation,
      claim: row.registration_claim,
    })),
    [
      {
        generation: "generation:legacy-recovery",
        claim: "registration:legacy-recovery",
      },
      {
        generation: "generation:legacy-recovery",
        claim: "registration:legacy-recovery",
      },
    ],
  );
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

test("expired credential-policy claims cannot promote active authority", async () => {
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
      UPDATE interactive_session_credential_policy_registrations
      SET registration_claim_expires_at = 0
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run();

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
  assert.equal(
    activeCredentialPolicyRows(sqlite).some(
      (row) => row.registration_generation === staged.generation && row.state === "active",
    ),
    false,
  );
});

test("completed credential-policy rotation tolerates an ambiguous committed batch", async () => {
  const sqlite = credentialPolicyDatabase();
  const staged = await beginSandboxCredentialPolicyRegistration(
    sqliteRuntimeEnv(sqlite),
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );

  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      sqliteRuntimeEnv(sqlite, { throwAfterCommit: true }),
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    true,
  );
});

test("completed credential-policy rotation retries an ambiguous verification read", async () => {
  const sqlite = credentialPolicyDatabase();
  const staged = await beginSandboxCredentialPolicyRegistration(
    sqliteRuntimeEnv(sqlite),
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );

  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      sqliteRuntimeEnv(sqlite, { failNextReadAfterBatch: true }),
      "IS-42",
      "sandbox-1",
      staged,
      ownershipFence,
    ),
    true,
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

test("credential refresh repairs an incomplete legacy lookup set before rotation", async () => {
  const sqlite = credentialPolicyDatabase();
  sqlite
    .prepare(`
      DELETE FROM interactive_session_credential_policies
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1' AND lookup_id = 'do-1'
    `)
    .run();
  const now = Date.now();
  const policies = new Map<string, StoredSandboxCredentialPolicy>([
    [
      "sandbox-1",
      {
        generation: "generation:existing",
        registrationClaim: "registration:legacy",
        registrationExpiresAt: now + 30_000,
        policy: {
          allowedHosts: [],
          githubCredentialSource: "none",
          githubRepo: "openclaw/crabfleet",
          owner: "operator",
          sandboxId: "sandbox-1",
          sessionId: "IS-42",
        },
      },
    ],
  ]);
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const egress = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (egress && (!init?.method || init.method === "GET")) {
        const current = policies.get(decodeURIComponent(egress[1] ?? ""));
        return current
          ? Response.json(current.policy, {
              headers: { "x-crabfleet-policy-generation": current.generation },
            })
          : Response.json({ error: "not found" }, { status: 404 });
      }
      if (url.pathname === "/api/session-control/register" && init?.method === "POST") {
        const incoming = JSON.parse(String(init.body)) as StoredSandboxCredentialPolicy;
        const current = policies.get(incoming.policy.sandboxId);
        if (!credentialPolicyRegistrationAccepted(current, undefined, incoming, Date.now())) {
          return Response.json({ error: "conflict" }, { status: 409 });
        }
        policies.set(incoming.policy.sandboxId, incoming);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
  const env = sqliteRuntimeEnv(sqlite);

  assert.equal(await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"), null);
  assert.equal(
    await incompleteSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"),
    "generation:existing",
  );
  await assert.rejects(
    captureSandboxCredentialPolicyRollback(stub, sandboxLookupIds(env, "sandbox-1"), null, "IS-42"),
    /no durable rollback owner/,
  );

  const registration = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const repairGeneration = await incompleteSandboxCredentialPolicyGeneration(
    env,
    "IS-42",
    "sandbox-1",
  );
  assert.equal(repairGeneration, "generation:existing");
  let registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    registration,
    ownershipFence,
  );
  assert.ok(registrationExpiresAt);
  assert.equal(
    await stageSandboxCredentialPolicyReferenceRepair(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      ownershipFence,
    ),
    true,
  );
  const legacyUpdate = sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET
        state = 'registering',
        registration_claim = 'registration:legacy-race',
        registration_claim_expires_at = ?
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1'
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyUpdate.changes, 0);
  const legacyInsert = sqlite
    .prepare(`
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
      ) VALUES (
        'IS-42',
        'sandbox-1',
        'do-1',
        'registering',
        'generation:existing',
        'registration:legacy-race',
        ?,
        1,
        1
      )
    `)
    .run(Number.MAX_SAFE_INTEGER);
  assert.equal(legacyInsert.changes, 0);
  assert.equal(
    (
      await stub.fetch("https://crabfleet.internal/api/session-control/register", {
        method: "POST",
        body: JSON.stringify({
          generation: repairGeneration,
          registrationClaim: registration.claim,
          registrationExpiresAt: registrationExpiresAt - 1,
          policy: { ...policies.get("sandbox-1")!.policy, sandboxId: "do-1" },
        } satisfies StoredSandboxCredentialPolicy),
      })
    ).ok,
    true,
  );
  registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    registration,
    ownershipFence,
  );
  assert.ok(registrationExpiresAt);
  assert.equal(
    await repairSandboxCredentialPolicyReferences(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      ownershipFence,
      registrationExpiresAt,
    ),
    true,
  );
  const rollback = await captureSandboxCredentialPolicyRollback(
    stub,
    registration.lookupIds,
    repairGeneration,
    "IS-42",
  );
  assert.equal(rollback.length, 2);
  assert.equal(
    await recordSandboxCredentialPolicyRollback(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      rollback,
      ownershipFence,
    ),
    true,
  );
  for (const lookupId of registration.lookupIds) {
    registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      ownershipFence,
    );
    assert.ok(registrationExpiresAt);
    assert.equal(
      (
        await stub.fetch("https://crabfleet.internal/api/session-control/register", {
          method: "POST",
          body: JSON.stringify({
            generation: registration.generation,
            registrationClaim: registration.claim,
            registrationExpiresAt,
            policy: { ...policies.get(lookupId)!.policy, sandboxId: lookupId },
          } satisfies StoredSandboxCredentialPolicy),
        })
      ).ok,
      true,
    );
  }
  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      ownershipFence,
    ),
    true,
  );

  const generation = await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1");
  assert.match(generation ?? "", /^generation:/);
  assert.notEqual(generation, "generation:existing");
  assert.deepEqual(
    [...policies.entries()].map(([lookupId, policy]) => ({
      lookupId,
      generation: policy.generation,
      sandboxId: policy.policy.sandboxId,
    })),
    [
      { lookupId: "sandbox-1", generation, sandboxId: "sandbox-1" },
      { lookupId: "do-1", generation, sandboxId: "do-1" },
    ],
  );
});

test("credential refresh replaces an obsolete durable namespace without losing rollback coverage", async () => {
  const sqlite = credentialPolicyDatabase();
  sqlite
    .prepare(`
      UPDATE interactive_session_credential_policies
      SET lookup_id = 'do-old'
      WHERE session_id = 'IS-42' AND sandbox_id = 'sandbox-1' AND lookup_id = 'do-1'
    `)
    .run();
  const now = Date.now();
  const policy = {
    allowedHosts: [],
    githubCredentialSource: "none" as const,
    githubRepo: "openclaw/crabfleet",
    owner: "operator",
    sessionId: "IS-42",
  };
  const policies = new Map<string, StoredSandboxCredentialPolicy>(
    ["sandbox-1", "do-old"].map((lookupId) => [
      lookupId,
      {
        generation: "generation:existing",
        registrationClaim: "registration:legacy",
        registrationExpiresAt: now + 1_000,
        policy: { ...policy, sandboxId: lookupId },
      },
    ]),
  );
  const tombstones = new Map<string, string>();
  const stub = {
    async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
      const url = new URL(String(input));
      const egress = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (egress && (!init?.method || init.method === "GET")) {
        const current = policies.get(decodeURIComponent(egress[1] ?? ""));
        return current
          ? Response.json(current.policy, {
              headers: { "x-crabfleet-policy-generation": current.generation },
            })
          : Response.json({ error: "not found" }, { status: 404 });
      }
      if (url.pathname === "/api/session-control/register" && init?.method === "POST") {
        const incoming = JSON.parse(String(init.body)) as StoredSandboxCredentialPolicy;
        const lookupId = incoming.policy.sandboxId;
        if (
          tombstones.get(lookupId) === incoming.generation ||
          !credentialPolicyRegistrationAccepted(
            policies.get(lookupId),
            undefined,
            incoming,
            Date.now(),
          )
        ) {
          return Response.json({ error: "conflict" }, { status: 409 });
        }
        policies.set(lookupId, incoming);
        return Response.json({ ok: true });
      }
      const removal = url.pathname.match(/^\/api\/session-control\/sandbox\/([^/]+)$/);
      if (removal && init?.method === "DELETE") {
        const lookupId = decodeURIComponent(removal[1] ?? "");
        const tombstone = JSON.parse(String(init.body)) as {
          generation: string;
          sessionId: string;
        };
        tombstones.set(lookupId, tombstone.generation);
        const current = policies.get(lookupId);
        if (
          current?.generation === tombstone.generation &&
          current.policy.sessionId === tombstone.sessionId
        ) {
          policies.delete(lookupId);
        }
        return Response.json({ ok: true });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    },
  };
  const env = sqliteRuntimeEnv(sqlite);

  assert.equal(await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"), null);
  assert.equal(
    await incompleteSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"),
    "generation:existing",
  );
  const registration = await beginSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    ownershipFence,
  );
  const repairGeneration = await incompleteSandboxCredentialPolicyGeneration(
    env,
    "IS-42",
    "sandbox-1",
  );
  assert.equal(repairGeneration, "generation:existing");
  assert.deepEqual(
    await sandboxCredentialPolicyLookupIdsForGeneration(
      env,
      "IS-42",
      "sandbox-1",
      repairGeneration,
    ),
    ["do-old", "sandbox-1"],
  );
  let registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    registration,
    ownershipFence,
  );
  assert.ok(registrationExpiresAt);
  assert.equal(
    await stageSandboxCredentialPolicyReferenceRepair(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      ownershipFence,
    ),
    true,
  );
  assert.equal(
    (
      await stub.fetch("https://crabfleet.internal/api/session-control/register", {
        method: "POST",
        body: JSON.stringify({
          generation: repairGeneration,
          registrationClaim: registration.claim,
          registrationExpiresAt: registrationExpiresAt - 1,
          policy: { ...policy, sandboxId: "do-1" },
        } satisfies StoredSandboxCredentialPolicy),
      })
    ).ok,
    true,
  );
  registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    registration,
    ownershipFence,
  );
  assert.ok(registrationExpiresAt);
  assert.equal(
    await repairSandboxCredentialPolicyReferences(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      ownershipFence,
      registrationExpiresAt,
    ),
    true,
  );
  registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    "IS-42",
    "sandbox-1",
    registration,
    ownershipFence,
  );
  assert.ok(registrationExpiresAt);
  assert.deepEqual(
    await claimObsoleteSandboxCredentialPolicyReferences(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      ["do-old"],
      ownershipFence,
      registrationExpiresAt,
    ),
    ["do-old"],
  );
  assert.equal(
    (
      await stub.fetch("https://crabfleet.internal/api/session-control/sandbox/do-old", {
        method: "DELETE",
        body: JSON.stringify({
          generation: repairGeneration,
          sessionId: "IS-42",
          tombstonedAt: Date.now(),
        }),
      })
    ).ok,
    true,
  );
  assert.equal(
    await retireObsoleteSandboxCredentialPolicyReference(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      repairGeneration,
      "do-old",
      ownershipFence,
      registrationExpiresAt,
    ),
    true,
  );
  assert.equal(
    await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1"),
    repairGeneration,
  );
  const rollback = await captureSandboxCredentialPolicyRollback(
    stub,
    registration.lookupIds,
    repairGeneration,
    "IS-42",
  );
  assert.equal(
    await recordSandboxCredentialPolicyRollback(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      rollback,
      ownershipFence,
    ),
    true,
  );
  for (const lookupId of registration.lookupIds) {
    registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      ownershipFence,
    );
    assert.ok(registrationExpiresAt);
    assert.equal(
      (
        await stub.fetch("https://crabfleet.internal/api/session-control/register", {
          method: "POST",
          body: JSON.stringify({
            generation: registration.generation,
            registrationClaim: registration.claim,
            registrationExpiresAt,
            policy: { ...policy, sandboxId: lookupId },
          } satisfies StoredSandboxCredentialPolicy),
        })
      ).ok,
      true,
    );
  }
  assert.equal(
    await finishSandboxCredentialPolicyRegistration(
      env,
      "IS-42",
      "sandbox-1",
      registration,
      ownershipFence,
    ),
    true,
  );

  const generation = await activeSandboxCredentialPolicyGeneration(env, "IS-42", "sandbox-1");
  assert.match(generation ?? "", /^generation:/);
  assert.notEqual(generation, "generation:existing");
  assert.deepEqual(
    activeCredentialPolicyRows(sqlite).map((row) => row.lookup_id),
    ["do-1", "sandbox-1"],
  );
  assert.deepEqual([...policies.keys()].sort(), ["do-1", "sandbox-1"]);
  assert.equal(tombstones.get("do-old"), "generation:existing");
  assert.equal(policies.has("do-old"), false);
  assert.equal(
    sqlite
      .prepare("SELECT count(*) AS count FROM interactive_session_credential_policy_registrations")
      .get()?.count,
    0,
  );
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
