import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  insertInteractiveSessionReservation,
  readVisibleInteractiveSessionRow,
  readVisibleInteractiveSessionRows,
} from "../src/worker/session-repository.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };
type D1Handler = (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result;
type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: D1Handler,
  batchHandler: (statements: PreparedStatement[]) => void = () => undefined,
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const statement: PreparedStatement = {
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
            return statement;
          },
        };
      },
      async batch(statements: unknown[]) {
        batchHandler(statements as PreparedStatement[]);
        return [];
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("visible session reads exclude preparation reservations and stay bounded", async () => {
  const row = sessionRow({ id: "IS-2", preparation_pending: 0 });
  let calls = 0;
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    calls += 1;
    assert.match(sql, /from "interactive_sessions"/i);
    assert.match(sql, /"preparation_pending" =/i);
    if (/"id" =/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-2", 0]);
    } else {
      assert.match(sql, /order by "updated_at" desc/i);
      assert.match(sql, /limit/i);
      assert.deepEqual(parameters, [0, 12]);
    }
    return { results: [row] };
  });

  assert.equal((await readVisibleInteractiveSessionRow(env, "IS-2"))?.id, "IS-2");
  assert.deepEqual(
    (await readVisibleInteractiveSessionRows(env, 12)).map((session) => session.id),
    ["IS-2"],
  );
  assert.equal(calls, 2);
});

test("session reservation inserts preparation and request identity in one batch", async () => {
  let batch: PreparedStatement[] = [];
  const values = sessionRow({
    id: "IS-2",
    preparation_pending: 1,
    openclaw_request_id: "request-1",
    openclaw_request_hash: "hash-1",
  });
  await insertInteractiveSessionReservation(
    runtimeEnv(
      () => {
        throw new Error("batched inserts must not execute individually");
      },
      (statements) => {
        batch = statements;
      },
    ),
    values,
    {
      requestId: "request-1",
      requestHash: "hash-1",
      sessionId: "IS-2",
      createdAt: 100,
    },
  );

  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /^insert into "openclaw_request_replays"/i);
  assert.deepEqual(batch[0]?.parameters, ["request-1", "hash-1", "IS-2", 100, 100]);
  assert.match(batch[1]?.sql ?? "", /^insert into "interactive_sessions"/i);
  assert.match(batch[1]?.sql ?? "", /"preparation_pending"/i);
  assert.match(batch[1]?.sql ?? "", /"openclaw_request_id"/i);
  assert.match(batch[1]?.sql ?? "", /"openclaw_request_hash"/i);
  assert.ok(batch[1]?.parameters.includes(1));
  assert.ok(batch[1]?.parameters.includes("request-1"));
  assert.ok(batch[1]?.parameters.includes("hash-1"));
});

test("session reservations without request identity use one insert", async () => {
  let inserts = 0;
  await insertInteractiveSessionReservation(
    runtimeEnv((sql, _parameters, kind) => {
      assert.equal(kind, "run");
      assert.match(sql, /^insert into "interactive_sessions"/i);
      inserts += 1;
      return { changes: 1 };
    }),
    sessionRow({ id: "IS-2" }),
    null,
  );
  assert.equal(inserts, 1);
});
