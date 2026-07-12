import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { appendStructuredInteractiveSessionEventRecord } from "../src/worker/session-events.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

type SqliteStatement = {
  all(...parameters: unknown[]): Record<string, unknown>[];
  run(...parameters: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
};

type BoundStatement = {
  execute(): {
    results: Record<string, unknown>[];
    success: true;
    meta: { changes: number; last_row_id?: number };
  };
};

function eventDatabase(): DatabaseSync {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE interactive_sessions (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      terminal_finalize_pending INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE interactive_session_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      actor TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      event_key TEXT,
      event_type TEXT NOT NULL DEFAULT 'message',
      payload_json TEXT
    );
    CREATE UNIQUE INDEX idx_interactive_session_events_session_event_key
      ON interactive_session_events(session_id, event_key)
      WHERE event_key IS NOT NULL AND event_key <> '';
    INSERT INTO interactive_sessions (id, status) VALUES ('IS-1', 'ready');
  `);
  return database;
}

function runtimeEnv(
  database: DatabaseSync,
  options: { interruptAfterStatement?: number } = {},
): RuntimeEnv {
  function execute(sql: string, parameters: unknown[]) {
    const statement = database.prepare(sql) as unknown as SqliteStatement;
    if (/^\s*(?:select|pragma|with)\b|\breturning\b/i.test(sql)) {
      const results = statement.all(...parameters).map((row) => ({ ...row }));
      const changes = Number(database.prepare("SELECT changes() AS changes").get()?.changes ?? 0);
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
            const bound: BoundStatement = {
              execute: () => execute(sql, parameters),
            };
            return {
              ...bound,
              async all() {
                return bound.execute();
              },
              async run() {
                return bound.execute();
              },
            };
          },
        };
      },
      async batch(statements: D1PreparedStatement[]) {
        database.exec("BEGIN IMMEDIATE");
        try {
          const results = [];
          for (const [index, statement] of statements.entries()) {
            results.push((statement as unknown as BoundStatement).execute());
            if (options.interruptAfterStatement === index + 1) {
              throw new Error("simulated batch interruption");
            }
          }
          database.exec("COMMIT");
          return results;
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

function eventInput(message = "updated pull request", now = 123) {
  return {
    sessionId: "IS-1",
    actor: "operator",
    eventKey: "run:1",
    type: "clawsweeper.action",
    message,
    payload: { version: 1, number: 42 },
    now,
  };
}

test("structured event batch interruption rolls back insert and terminal invalidation", async () => {
  const database = eventDatabase();
  let archived = false;
  await assert.rejects(
    appendStructuredInteractiveSessionEventRecord(
      runtimeEnv(database, { interruptAfterStatement: 1 }),
      eventInput(),
      async () => {
        archived = true;
      },
    ),
    /simulated batch interruption/,
  );

  assert.equal(
    database.prepare("SELECT count(*) AS count FROM interactive_session_events").get()?.count,
    0,
  );
  assert.equal(
    database
      .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-1'")
      .get()?.terminal_finalize_pending,
    0,
  );
  assert.equal(archived, false);
});

test("structured event races deduplicate and keep terminal replays side-effect free", async () => {
  const database = eventDatabase();
  const env = runtimeEnv(database);
  let archiveCalls = 0;
  const append = (input: ReturnType<typeof eventInput>) =>
    appendStructuredInteractiveSessionEventRecord(env, input, async () => {
      archiveCalls += 1;
    });
  const results = await Promise.all([
    append(eventInput("updated pull request", 100)),
    append(eventInput("updated pull request", 200)),
  ]);

  assert.deepEqual(results.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal(archiveCalls, 2);
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM interactive_session_events").get()?.count,
    1,
  );
  const sequenceBeforeReplay = database
    .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'interactive_session_events'")
    .get()?.seq;
  assert.equal(sequenceBeforeReplay, 1);
  assert.equal(
    database
      .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-1'")
      .get()?.terminal_finalize_pending,
    0,
  );

  database.exec("UPDATE interactive_sessions SET status = 'stopped' WHERE id = 'IS-1'");
  const replay = await append(eventInput("updated pull request", 300));
  assert.equal(replay.duplicate, true);
  assert.equal(archiveCalls, 2);
  assert.equal(
    database
      .prepare("SELECT seq FROM sqlite_sequence WHERE name = 'interactive_session_events'")
      .get()?.seq,
    sequenceBeforeReplay,
  );
  assert.equal(
    database
      .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-1'")
      .get()?.terminal_finalize_pending,
    0,
  );

  await assert.rejects(append(eventInput("changed content", 400)), (error) => {
    assert.equal(
      typeof error === "object" && error && "status" in error ? error.status : undefined,
      409,
    );
    return true;
  });
  assert.equal(
    database
      .prepare("SELECT terminal_finalize_pending FROM interactive_sessions WHERE id = 'IS-1'")
      .get()?.terminal_finalize_pending,
    0,
  );

  await assert.rejects(
    append({ ...eventInput("new content", 500), eventKey: "run:2" }),
    (error) => {
      assert.equal(
        typeof error === "object" && error && "status" in error ? error.status : undefined,
        403,
      );
      return true;
    },
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM interactive_session_events").get()?.count,
    1,
  );
});

test("legacy credential-bearing replays repair D1 and refresh terminal archives", async () => {
  const database = eventDatabase();
  const rawMessage = "authorization: Bearer legacy-secret-value";
  const rawPayload = JSON.stringify({ version: 1, output: rawMessage });
  database
    .prepare(`
      INSERT INTO interactive_session_events
        (session_id, actor, event_key, event_type, message, payload_json, created_at)
      VALUES ('IS-1', 'operator', 'run:legacy', 'clawsweeper.action', ?, ?, 100)
    `)
    .run(rawMessage, rawPayload);
  database.exec("UPDATE interactive_sessions SET status = 'stopped' WHERE id = 'IS-1'");
  let archiveCalls = 0;

  const replay = await appendStructuredInteractiveSessionEventRecord(
    runtimeEnv(database),
    {
      sessionId: "IS-1",
      actor: "operator",
      eventKey: "run:legacy",
      type: "clawsweeper.action",
      message: rawMessage,
      payload: { version: 1, output: rawMessage },
      now: 200,
    },
    async () => {
      archiveCalls += 1;
    },
  );

  assert.equal(replay.duplicate, true);
  assert.equal(replay.event.message, "[credential]");
  assert.deepEqual(replay.event.payload, { output: "[credential]", version: 1 });
  assert.equal(archiveCalls, 1);
  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT message, payload_json
          FROM interactive_session_events
          WHERE session_id = 'IS-1' AND event_key = 'run:legacy'
        `)
        .get(),
    },
    {
      message: "[credential]",
      payload_json: '{"output":"[credential]","version":1}',
    },
  );
});
