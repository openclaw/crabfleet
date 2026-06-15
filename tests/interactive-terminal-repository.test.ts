import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { InteractiveTerminalRepository } from "../src/worker/interactive-terminal-repository.ts";
import { sessionRow } from "./helpers/session-row.ts";

type Execution = {
  sql: string;
  parameters: unknown[];
  kind: "all" | "run";
};

function runtimeEnv(executions: Execution[]): RuntimeEnv {
  const row = sessionRow({
    id: "IS-9",
    status: "attached",
    last_event: "PTY terminal connected",
    last_seen_at: 100,
    share_mode: "link_read",
    share_token_hash: "share-hash",
    multiplayer_mode: 1,
  });
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                executions.push({ sql, parameters, kind: "all" });
                return { results: [row], meta: { changes: 0 } };
              },
              async run() {
                executions.push({ sql, parameters, kind: "run" });
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("terminal repository owns access, connection, and lifecycle persistence", async () => {
  const executions: Execution[] = [];
  const repository = new InteractiveTerminalRepository(runtimeEnv(executions));

  const session = await repository.readSession("IS-9");
  assert.equal(session?.id, "IS-9");
  assert.deepEqual(await repository.readShareCredential("IS-9"), {
    tokenHash: "share-hash",
    shareMode: "link_read",
    status: "attached",
    terminalAvailable: true,
  });
  assert.equal(await repository.readMultiplayerMode("IS-9"), true);
  assert.deepEqual(await repository.readConnectionState("IS-9"), {
    status: "attached",
    lastEvent: "PTY terminal connected",
    lastSeenAt: 100,
  });

  await repository.markConnected("IS-9", "connected", 200);
  assert.equal(await repository.markDetached("IS-9", "detached"), true);
  assert.equal(await repository.markExpired(session!, "expired", 300), true);

  assert.equal(executions.length, 7);
  for (const execution of executions.slice(0, 4)) {
    assert.equal(execution.kind, "all");
    assert.match(execution.sql, /select .* from "interactive_sessions"/i);
    assert.ok(execution.parameters.includes("IS-9"));
  }
  for (const execution of executions.slice(4)) {
    assert.equal(execution.kind, "run");
    assert.match(execution.sql, /update "interactive_sessions"/i);
    assert.ok(execution.parameters.includes("IS-9"));
  }
  assert.match(executions[4]!.sql, /"last_seen_at"/i);
  assert.match(executions[5]!.sql, /"status" in/i);
  assert.match(executions[6]!.sql, /MAX\(updated_at \+ 1/i);
});
