import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { appendInteractiveSessionEventRecord } from "../src/worker/session-events.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
};

function runtimeEnv(onBatch: (statements: PreparedStatement[]) => void): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return { sql, parameters };
          },
        };
      },
      async batch(statements: unknown[]) {
        onBatch(statements as PreparedStatement[]);
        return [];
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("session events persist before archive refresh and invalidate terminal finalization", async () => {
  const order: string[] = [];
  let statements: PreparedStatement[] = [];
  const env = runtimeEnv((batch) => {
    order.push("persist");
    statements = batch;
  });

  await appendInteractiveSessionEventRecord(
    env,
    {
      sessionId: "IS-1",
      actor: "operator",
      message: `  ${"x".repeat(1100)}  `,
      now: 123,
    },
    async (sessionId, now) => {
      order.push("archive");
      assert.equal(sessionId, "IS-1");
      assert.equal(now, 123);
    },
  );

  assert.deepEqual(order, ["persist", "archive"]);
  assert.equal(statements.length, 2);
  assert.match(statements[0]?.sql ?? "", /insert into "interactive_session_events"/i);
  assert.deepEqual(statements[0]?.parameters, ["IS-1", "operator", "x".repeat(1000), 123]);
  assert.match(statements[1]?.sql ?? "", /update "interactive_sessions"/i);
  assert.match(statements[1]?.sql ?? "", /"terminal_finalize_pending" = \?/i);
  assert.deepEqual(statements[1]?.parameters, [1, "IS-1", "stopped", "expired", "failed"]);
});

test("session event archive refresh remains best effort after durable persistence", async () => {
  let persisted = false;
  const env = runtimeEnv(() => {
    persisted = true;
  });

  await appendInteractiveSessionEventRecord(
    env,
    {
      sessionId: "IS-1",
      actor: "system",
      message: "completed",
      now: 123,
    },
    async () => {
      throw new Error("archive unavailable");
    },
  );

  assert.equal(persisted, true);
});
