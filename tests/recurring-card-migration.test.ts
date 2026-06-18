import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("recurring card migration preserves existing cards and adds the due index", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );
    INSERT INTO cards (id, title) VALUES ('CY-101', 'Existing card');
  `);

  database.exec(
    readFileSync(new URL("../migrations/0027_recurring_cards.sql", import.meta.url), "utf8"),
  );

  const card = database
    .prepare(
      "SELECT id, title, schedule_json, next_run_at, last_scheduled_run_at, schedule_claimed_at FROM cards",
    )
    .get() as Record<string, unknown>;
  assert.deepEqual(
    { ...card },
    {
      id: "CY-101",
      title: "Existing card",
      schedule_json: "",
      next_run_at: null,
      last_scheduled_run_at: null,
      schedule_claimed_at: null,
    },
  );
  assert.equal(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_cards_recurring_due")?.name,
    "idx_cards_recurring_due",
  );
});
