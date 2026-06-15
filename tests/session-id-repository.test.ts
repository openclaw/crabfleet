import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { nextInteractiveSessionId } from "../src/worker/session-id-repository.ts";

test("interactive session id allocation skips case-insensitive standalone reservations", async () => {
  const queries: Array<{ sql: string; parameters: unknown[] }> = [];
  let allocation = 100;
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            queries.push({ sql, parameters });
            return {
              async all() {
                if (/insert into id_sequences/i.test(sql)) {
                  allocation += 1;
                  return { results: [{ next_id: allocation }], meta: { changes: 1 } };
                }
                assert.match(sql, /from "standalone_sandbox_provisions"/i);
                assert.match(sql, /collate nocase/i);
                return {
                  results: parameters[0] === "IS-101" ? [{ id: "is-101" }] : [],
                  meta: { changes: 0 },
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  assert.equal(await nextInteractiveSessionId(env), "IS-102");
  assert.equal(queries.filter(({ sql }) => /insert into id_sequences/i.test(sql)).length, 2);
  assert.deepEqual(
    queries
      .filter(({ sql }) => /standalone_sandbox_provisions/i.test(sql))
      .map(({ parameters }) => parameters),
    [["IS-101"], ["IS-102"]],
  );
});

test("interactive session id allocation rejects invalid sequence values", async () => {
  const env = {
    DB: {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { results: [{ next_id: 100 }], meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  await assert.rejects(nextInteractiveSessionId(env), /failed to allocate interactive session id/);
});
