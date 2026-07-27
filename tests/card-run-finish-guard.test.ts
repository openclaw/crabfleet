import assert from "node:assert/strict";
import test from "node:test";

import { Miniflare } from "miniflare";

import { CardRepository } from "../src/worker/card-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

// finishRunForLane is a persistence race fix, so it is proven against a REAL D1 (Miniflare's
// SQLite), not a mock: the guarded UPDATE + conditional event insert run as the actual compiled SQL
// in one atomic batch. Each case seeds run_attempts + events, invokes the real CardRepository, then
// reads the committed rows back.

async function openD1(): Promise<{ mf: Miniflare; env: RuntimeEnv }> {
  const mf = new Miniflare({
    modules: true,
    script: "export default { async fetch() { return new Response('ok'); } };",
    d1Databases: ["DB"],
  });
  const db = await mf.getD1Database("DB");
  await db.exec(
    "CREATE TABLE run_attempts (id TEXT PRIMARY KEY, card_id TEXT NOT NULL, attempt INTEGER NOT NULL, runtime TEXT NOT NULL, status TEXT NOT NULL, control_intent TEXT, lease_id TEXT, attach_url TEXT, vnc_url TEXT, operator TEXT, last_heartbeat_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT)",
  );
  await db.exec(
    "CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, actor TEXT NOT NULL, message TEXT NOT NULL, created_at INTEGER NOT NULL)",
  );
  return { mf, env: { DB: db } as unknown as RuntimeEnv };
}

async function seedRun(env: RuntimeEnv, status: string, updatedAt = 0): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO run_attempts (id, card_id, attempt, runtime, status, last_heartbeat_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  )
    .bind("R1", "CY-1", 1, "crabbox", status, 0, 0, updatedAt)
    .run();
}

async function readRun(
  env: RuntimeEnv,
): Promise<{ status: string; control_intent: string | null }> {
  return env.DB.prepare("SELECT status, control_intent FROM run_attempts WHERE id = ?")
    .bind("R1")
    .first() as Promise<{ status: string; control_intent: string | null }>;
}

async function eventMessages(env: RuntimeEnv): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT card_id, message FROM events ORDER BY id").all<{
    card_id: string;
    message: string;
  }>();
  for (const row of results) assert.equal(row.card_id, "CY-1", "events carry the run's card id");
  return results.map((row) => row.message);
}

test("finishRunForLane transitions a live run to completed and records exactly one event", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "running");
    await new CardRepository(env).finishRunForLane("R1", "Done", "actor", 100);
    assert.equal((await readRun(env)).status, "completed");
    assert.deepEqual(await eventMessages(env), ["run completed"]);
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane leaves a stalled run untouched and emits no event (the race fix)", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "stalled"); // a reconciler marked it during the caller's read->write window
    await new CardRepository(env).finishRunForLane("R1", "Done", "actor", 100);
    assert.equal((await readRun(env)).status, "stalled", "stalled provenance is preserved");
    assert.deepEqual(await eventMessages(env), [], "no false 'run completed' event");
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane does not re-announce an already-terminal run (atomic conditional event)", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "completed", 50); // already finished by an earlier call (different updated_at)
    await new CardRepository(env).finishRunForLane("R1", "Done", "actor", 100);
    assert.equal((await readRun(env)).status, "completed");
    assert.deepEqual(
      await eventMessages(env),
      [],
      "the event only fires for the row THIS call transitioned (matched on updated_at)",
    );
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane promotes a review run to Done and records its event", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "review");
    await new CardRepository(env).finishRunForLane("R1", "Done", "actor", 100);
    assert.equal((await readRun(env)).status, "completed");
    assert.deepEqual(await eventMessages(env), ["run completed"]);
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane cancels for a non-terminal lane and sets control_intent", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "running");
    await new CardRepository(env).finishRunForLane("R1", "Backlog", "actor", 100);
    const run = await readRun(env);
    assert.equal(run.status, "canceled");
    assert.equal(run.control_intent, "cancel");
    assert.deepEqual(await eventMessages(env), ["run canceled"]);
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane emits exactly one event when two finish calls share the same now", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "running");
    const repo = new CardRepository(env);
    await repo.finishRunForLane("R1", "Done", "actor", 100); // running -> completed, one event
    await repo.finishRunForLane("R1", "Done", "actor", 100); // same now; run already completed -> UPDATE no-ops
    assert.equal((await readRun(env)).status, "completed");
    assert.deepEqual(
      await eventMessages(env),
      ["run completed"],
      "a competing same-now finish call must not duplicate the audit event (changes()=1 gates it)",
    );
  } finally {
    await mf.dispose();
  }
});

test("finishRunForLane does not re-fire the event or rewrite timing on repeated Human Review completion", async () => {
  const { mf, env } = await openD1();
  try {
    await seedRun(env, "running");
    const repo = new CardRepository(env);
    await repo.finishRunForLane("R1", "Human Review", "actor", 100); // running -> review, one event
    await repo.finishRunForLane("R1", "Human Review", "actor", 200); // already review; must NOT re-transition
    assert.equal((await readRun(env)).status, "review");
    assert.deepEqual(
      await eventMessages(env),
      ["run review"],
      "a repeated Human Review completion must not re-fire the audit event",
    );
    const row = (await env.DB.prepare("SELECT ended_at, updated_at FROM run_attempts WHERE id = ?")
      .bind("R1")
      .first()) as { ended_at: number; updated_at: number };
    assert.equal(row.updated_at, 100, "the second call must not rewrite the run's terminal timing");
    assert.equal(row.ended_at, 100, "the second call must not rewrite ended_at");
  } finally {
    await mf.dispose();
  }
});
