import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { AdminRepository } from "../src/worker/admin-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

const migration = readFileSync(
  new URL("../migrations/0043_disable_retired_repositories.sql", import.meta.url),
  "utf8",
);

type BoundStatement = {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
};

function repositoryDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE repos (
      repo TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO repos (repo, enabled, created_at, updated_at) VALUES
      ('openclaw/clawsweeper-home', 1, 1, 11),
      ('openclaw/crabbox-fleet', 1, 2, 22),
      ('openclaw/test-permissions-check', 1, 3, 33),
      ('openclaw/crabfleet', 1, 4, 44);
  `);
  return database;
}

function repoRows(database: DatabaseSync): Record<string, unknown>[] {
  return database
    .prepare("SELECT repo, enabled, created_at, updated_at FROM repos ORDER BY repo")
    .all()
    .map((row) => ({ ...row }));
}

function sqliteRuntimeEnv(sqlite: DatabaseSync): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = sqlite.prepare(sql);
    if (/^\s*(?:select|pragma|with)\b|\breturning\b/i.test(sql)) {
      return {
        results: statement.all(...parameters).map((row) => ({ ...row })),
        success: true as const,
        meta: {
          changes: Number(sqlite.prepare("SELECT changes() AS changes").get()?.changes ?? 0),
        },
      };
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
          const results = statements.map((statement) =>
            (statement as unknown as BoundStatement).execute(),
          );
          sqlite.exec("COMMIT");
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("repository retirement migration disables only the retired repositories idempotently", () => {
  const database = repositoryDatabase();
  database.exec(migration);

  const firstRun = repoRows(database);
  assert.deepEqual(
    firstRun.map(({ repo, enabled }) => ({ repo, enabled })),
    [
      { repo: "openclaw/clawsweeper-home", enabled: 0 },
      { repo: "openclaw/crabbox-fleet", enabled: 0 },
      { repo: "openclaw/crabfleet", enabled: 1 },
      { repo: "openclaw/test-permissions-check", enabled: 1 },
    ],
  );
  assert.equal(
    firstRun.find((row) => row.repo === "openclaw/test-permissions-check")?.updated_at,
    33,
  );

  database.exec(migration);
  assert.deepEqual(repoRows(database), firstRun);
});

test("admin repository exposes the migrated enabled set and keeps permission probes available", async () => {
  const database = repositoryDatabase();
  database.exec(migration);
  const repository = new AdminRepository(sqliteRuntimeEnv(database));

  assert.deepEqual(await repository.readEnabledRepos(), [
    "openclaw/crabfleet",
    "openclaw/test-permissions-check",
  ]);
  await repository.requireRepo("openclaw/test-permissions-check");
  await assert.rejects(repository.requireRepo("openclaw/clawsweeper-home"), (error) => {
    assert.equal(
      typeof error === "object" && error !== null && "status" in error ? error.status : undefined,
      403,
    );
    return true;
  });
});
