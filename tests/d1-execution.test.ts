import assert from "node:assert/strict";
import test from "node:test";

import { D1Connection, executeD1Statement } from "../src/d1-execution.ts";
import { database, executeBatch } from "../src/worker/database.ts";

test("D1 connection executes INSERT RETURNING through all and preserves rows", async () => {
  let allCalls = 0;
  let runCalls = 0;
  let boundParameters: readonly unknown[] = [];
  const sql = "INSERT INTO audit_events(actor, message, created_at) VALUES (?, ?, ?) RETURNING id";
  const connection = new D1Connection({
    prepare(preparedSql: string) {
      assert.equal(preparedSql, sql);
      return {
        bind(...parameters: unknown[]) {
          boundParameters = parameters;
          return {
            async all() {
              allCalls += 1;
              return {
                results: [{ id: 117 }],
                meta: { changes: 1, last_row_id: 117 },
              };
            },
            async run() {
              runCalls += 1;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database);
  const result = await connection.executeQuery<{ id: number }>({
    sql,
    parameters: ["github:1", "allowlist updated @alice role=viewer", 123],
    query: {} as never,
    queryId: {} as never,
  });

  assert.deepEqual(boundParameters, ["github:1", "allowlist updated @alice role=viewer", 123]);
  assert.equal(allCalls, 1);
  assert.equal(runCalls, 0);
  assert.deepEqual(result.rows, [{ id: 117 }]);
  assert.equal(result.numAffectedRows, 1n);
  assert.equal(result.insertId, 117n);
});

test("D1 executes non-returning mutations through run", async () => {
  let allCalls = 0;
  let runCalls = 0;
  const result = await executeD1Statement(
    {
      async all() {
        allCalls += 1;
        return { results: [], meta: {} };
      },
      async run() {
        runCalls += 1;
        return { meta: { changes: 2 } };
      },
    },
    "UPDATE sessions SET expires_at = 0",
  );

  assert.equal(allCalls, 0);
  assert.equal(runCalls, 1);
  assert.deepEqual(result.rows, []);
  assert.equal(result.changes, 2);
});

test("database batches compile Kysely queries into bound D1 statements", async () => {
  const prepared: Array<{ sql: string; parameters: unknown[] }> = [];
  let batchSize = 0;
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const statement = { sql, parameters };
            prepared.push(statement);
            return statement;
          },
        };
      },
      async batch(statements: unknown[]) {
        batchSize = statements.length;
        return [];
      },
    } as unknown as D1Database,
  };
  const db = database(env);

  await executeBatch(env, [
    db
      .insertInto("allow_entries")
      .values({ value: "@alice", role: "viewer", created_at: 41, updated_at: 41 }),
    db
      .updateTable("allow_entries")
      .set({ role: "maintainer", updated_at: 42 })
      .where("value", "=", "@alice"),
  ]);

  assert.equal(batchSize, 2);
  assert.match(prepared[0]?.sql ?? "", /^insert into "allow_entries"/i);
  assert.deepEqual(prepared[0]?.parameters, ["@alice", "viewer", 41, 41]);
  assert.match(prepared[1]?.sql ?? "", /^update "allow_entries"/i);
  assert.deepEqual(prepared[1]?.parameters, ["maintainer", 42, "@alice"]);
});
