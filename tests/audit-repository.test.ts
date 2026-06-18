import assert from "node:assert/strict";
import test from "node:test";

import { AuditRepository } from "../src/worker/audit-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

test("audit repository records actor, message, and timestamp", async () => {
  let statement = { sql: "", parameters: [] as unknown[] };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            statement = { sql, parameters };
            return {
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  await new AuditRepository(env).record("user:alice", "session stopped", 100);

  assert.match(statement.sql, /^insert into "audit_events"/i);
  assert.deepEqual(statement.parameters, ["user:alice", "session stopped", 100]);
});
