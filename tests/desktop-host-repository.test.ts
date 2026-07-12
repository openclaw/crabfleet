import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { DesktopHostRepository } from "../src/worker/desktop-host-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

type BoundStatement = {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
};

function sqliteRuntimeEnv(sqlite: DatabaseSync): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = sqlite.prepare(sql);
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

test("desktop host repository scopes reads, upserts, and deletes by owner subject", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const stored = {
    owner_subject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    ownership_token: "ownership-token",
    publication_id: "publication-id",
    created_at: 1,
    updated_at: 2,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            executions.push({ sql, parameters });
            return {
              async all() {
                return { results: [stored], meta: { changes: 0 } };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
      async batch() {
        return [];
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
  const repository = new DesktopHostRepository(env);

  assert.deepEqual(await repository.list("github:1"), [
    {
      ownerSubject: "github:1",
      id: "studio",
      owner: "alice",
      name: "Studio",
      address: "100.64.1.2",
      port: 5901,
      ownershipToken: "ownership-token",
      publicationID: "publication-id",
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  assert.match(executions[0]?.sql ?? "", /where "owner_subject" = \?/i);
  assert.deepEqual(executions[0]?.parameters, ["github:1"]);

  const upserted = await repository.upsert({
    ownerSubject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    ownershipToken: "ownership-token",
    publicationID: "publication-id",
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(upserted.id, "studio");
  assert.match(executions[1]?.sql ?? "", /^insert into "desktop_hosts"/i);
  assert.match(executions[1]?.sql ?? "", /\breturning \*/i);

  await repository.remove("github:1", "studio", "ownership-token");
  assert.match(executions[2]?.sql ?? "", /^update "desktop_hosts"/i);
  assert.match(executions[2]?.sql ?? "", /"ownership_token" = \?/i);
  assert.deepEqual(executions[2]?.parameters.slice(1), ["github:1", "studio", "ownership-token"]);
  const deleteMarker = executions[2]?.parameters[0];
  assert.match(String(deleteMarker), /^delete-authorized:/);
  assert.match(executions[3]?.sql ?? "", /^delete from "desktop_hosts"/i);
  assert.deepEqual(executions[3]?.parameters, ["github:1", "studio", deleteMarker]);

  await repository.remove("github:1", "legacy-studio", null);
  assert.match(executions[4]?.sql ?? "", /^delete from "desktop_hosts"/i);
  assert.match(executions[4]?.sql ?? "", /"ownership_token" = \?/i);
  assert.deepEqual(executions[4]?.parameters, ["github:1", "legacy-studio", ""]);
});

test("desktop host upsert returns the row written by the same atomic statement", async () => {
  const executions: string[] = [];
  const written = {
    owner_subject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Host A",
    address: "100.64.1.2",
    port: 5901,
    ownership_token: "token-a",
    publication_id: "publication-a",
    created_at: 1,
    updated_at: 2,
  };
  const competing = {
    ...written,
    owner: "bob",
    name: "Host B",
    address: "100.64.1.3",
    ownership_token: "token-b",
    updated_at: 3,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        executions.push(sql);
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [/^insert into "desktop_hosts"/i.test(sql) ? written : competing],
                  meta: { changes: 1 },
                };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  const row = await new DesktopHostRepository(env).upsert({
    ownerSubject: written.owner_subject,
    id: written.id,
    owner: written.owner,
    name: written.name,
    address: written.address,
    port: written.port,
    ownershipToken: written.ownership_token,
    publicationID: written.publication_id,
    createdAt: written.created_at,
    updatedAt: written.updated_at,
  });

  assert.equal(executions.length, 1);
  assert.match(executions[0] ?? "", /^insert into "desktop_hosts".*\breturning \*/is);
  assert.equal(row.name, "Host A");
  assert.equal(row.ownershipToken, "token-a");
});

test("legacy desktop host upserts preserve token ownership", async () => {
  let statement = "";
  const stored = {
    owner_subject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Legacy Studio",
    address: "100.64.1.2",
    port: 5901,
    ownership_token: "current-token",
    publication_id: "current-publication",
    created_at: 1,
    updated_at: 2,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        statement = sql;
        return {
          bind() {
            return {
              async all() {
                return { results: [stored], meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  const row = await new DesktopHostRepository(env).upsert({
    ownerSubject: stored.owner_subject,
    id: stored.id,
    owner: stored.owner,
    name: stored.name,
    address: stored.address,
    port: stored.port,
    ownershipToken: "",
    publicationID: "",
    createdAt: stored.created_at,
    updatedAt: stored.updated_at,
  });

  const updateClause = statement.split(/do update set/i)[1] ?? "";
  for (const column of ["owner", "name", "address", "port", "updated_at"]) {
    assert.match(
      updateClause,
      new RegExp(
        `"${column}" = CASE\\s+WHEN desktop_hosts\\.ownership_token = '' THEN excluded\\.${column}\\s+ELSE desktop_hosts\\.${column}\\s+END`,
        "i",
      ),
    );
  }
  assert.equal(row.ownershipToken, "current-token");
});

test("legacy desktop host writes and cleanup cannot mutate token-owned rows", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(
    readFileSync(new URL("../migrations/0030_desktop_hosts.sql", import.meta.url), "utf8"),
  );
  sqlite.exec(
    readFileSync(new URL("../migrations/0033_desktop_host_ownership.sql", import.meta.url), "utf8"),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0038_desktop_host_publication_identity.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(
    readFileSync(
      new URL("../migrations/0041_desktop_host_ownership_errors.sql", import.meta.url),
      "utf8",
    ),
  );
  sqlite.exec(`
    INSERT INTO desktop_hosts (
      owner_subject, id, owner, name, address, port, ownership_token, publication_id,
      created_at, updated_at
    ) VALUES (
      'github:1', 'studio', 'alice', 'Token Studio', '100.64.1.2', 5901,
      'current-token', 'current-publication', 1, 2
    )
  `);
  const repository = new DesktopHostRepository(sqliteRuntimeEnv(sqlite));

  const preserved = await repository.upsert({
    ownerSubject: "github:1",
    id: "studio",
    owner: "legacy-worker",
    name: "Overwritten Studio",
    address: "100.64.1.99",
    port: 5902,
    ownershipToken: "",
    publicationID: "",
    createdAt: 10,
    updatedAt: 20,
  });
  assert.deepEqual(preserved, {
    ownerSubject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Token Studio",
    address: "100.64.1.2",
    port: 5901,
    ownershipToken: "current-token",
    publicationID: "current-publication",
    createdAt: 1,
    updatedAt: 2,
  });

  await repository.remove("github:1", "studio", null);
  await repository.remove("github:1", "studio", "stale-token");
  assert.equal(
    sqlite.prepare("SELECT ownership_token FROM desktop_hosts WHERE id = 'studio'").get()
      ?.ownership_token,
    "current-token",
  );

  await repository.remove("github:1", "studio", "current-token");
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM desktop_hosts").get()?.count, 0);
});

test("desktop host publication recovery matches only the current publication", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0030_desktop_hosts.sql",
    "0033_desktop_host_ownership.sql",
    "0038_desktop_host_publication_identity.sql",
    "0041_desktop_host_ownership_errors.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const repository = new DesktopHostRepository(sqliteRuntimeEnv(sqlite));

  await repository.upsert({
    ownerSubject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    ownershipToken: "token-b",
    publicationID: "publication-b",
    createdAt: 1,
    updatedAt: 2,
  });

  assert.equal(
    await repository.ownershipTokenForPublication("github:1", "studio", "publication-a"),
    null,
  );
  assert.equal(
    await repository.ownershipTokenForPublication("github:1", "studio", "publication-b"),
    "token-b",
  );
});

test("same-publication retries remain recoverable after the publication migration", async () => {
  const sqlite = new DatabaseSync(":memory:");
  for (const migration of [
    "0030_desktop_hosts.sql",
    "0033_desktop_host_ownership.sql",
    "0038_desktop_host_publication_identity.sql",
    "0041_desktop_host_ownership_errors.sql",
  ]) {
    sqlite.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  const repository = new DesktopHostRepository(sqliteRuntimeEnv(sqlite));
  const host = {
    ownerSubject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    publicationID: "publication-a",
    createdAt: 1,
  };

  await repository.upsert({
    ...host,
    ownershipToken: "token-a",
    updatedAt: 2,
  });
  await repository.upsert({
    ...host,
    ownershipToken: "token-b",
    updatedAt: 3,
  });

  assert.deepEqual(
    {
      ...sqlite
        .prepare(`
          SELECT ownership_token, publication_id, publication_write_token
          FROM desktop_hosts
          WHERE owner_subject = 'github:1' AND id = 'studio'
        `)
        .get(),
    },
    {
      ownership_token: "token-b",
      publication_id: "publication-a",
      publication_write_token: "token-b",
    },
  );
  assert.equal(
    await repository.ownershipTokenForPublication("github:1", "studio", "publication-a"),
    "token-b",
  );

  sqlite.exec(`
    UPDATE desktop_hosts
    SET ownership_token = 'token-c'
    WHERE owner_subject = 'github:1' AND id = 'studio'
  `);
  assert.equal(
    await repository.ownershipTokenForPublication("github:1", "studio", "publication-a"),
    null,
  );
});
