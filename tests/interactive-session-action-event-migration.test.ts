import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  structuredEventLedgerMaxBytes,
  structuredEventLedgerMaxCount,
} from "../src/worker/session-events.ts";

test("action event migration preserves messages and keys structured events per session", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE interactive_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    VALUES ('IS-1', 'operator', 'legacy message', 1);
  `);
  database.exec(
    readFileSync(
      new URL("../migrations/0032_interactive_session_action_events.sql", import.meta.url),
      "utf8",
    ),
  );

  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT event_key, event_type, payload_json FROM interactive_session_events WHERE id = 1",
        )
        .get(),
    },
    { event_key: null, event_type: "message", payload_json: null },
  );

  const insert = database.prepare(`
    INSERT INTO interactive_session_events
      (session_id, actor, event_key, event_type, message, payload_json, created_at)
    VALUES (?, 'agent', ?, 'clawsweeper.action', 'updated pull request', '{"version":1}', 2)
  `);
  insert.run("IS-1", "run:1");
  insert.run("IS-2", "run:1");
  assert.throws(() => insert.run("IS-1", "run:1"), /unique constraint/i);

  insert.run("IS-1", "");
  insert.run("IS-1", "");
  database.exec(`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    VALUES
      ('IS-1', 'agent', 'unkeyed one', 3),
      ('IS-1', 'agent', 'unkeyed two', 4);
  `);

  const budgetInsert = database.prepare(`
    INSERT INTO interactive_session_events
      (session_id, actor, event_key, event_type, message, payload_json, created_at)
    VALUES (?, 'agent', ?, 'clawsweeper.action', 'm', '{"version":1}', 5)
  `);
  database.exec("BEGIN");
  for (let index = 0; index < structuredEventLedgerMaxCount; index += 1) {
    budgetInsert.run("IS-count-budget", `event:${index}`);
  }
  database.exec("COMMIT");
  assert.throws(
    () => budgetInsert.run("IS-count-budget", "event:overflow"),
    /structured session event budget exceeded/i,
  );
  database
    .prepare(`
      INSERT OR IGNORE INTO interactive_session_events
        (session_id, actor, event_key, event_type, message, payload_json, created_at)
      VALUES ('IS-count-budget', 'agent', 'event:0', 'clawsweeper.action', 'replay', '{"version":2}', 6)
    `)
    .run();

  const byteFiller = "x".repeat(structuredEventLedgerMaxBytes - 1024);
  database
    .prepare(`
      INSERT INTO interactive_session_events
        (session_id, actor, event_key, event_type, message, payload_json, created_at)
      VALUES ('IS-byte-budget', 'agent', 'filler', 'clawsweeper.action', 'm', ?, 7)
    `)
    .run(byteFiller);
  assert.throws(
    () =>
      database
        .prepare(`
          INSERT INTO interactive_session_events
            (session_id, actor, event_key, event_type, message, payload_json, created_at)
          VALUES ('IS-byte-budget', 'agent', 'overflow', 'clawsweeper.action', 'm', ?, 8)
        `)
        .run("x".repeat(2048)),
    /structured session event budget exceeded/i,
  );
});
