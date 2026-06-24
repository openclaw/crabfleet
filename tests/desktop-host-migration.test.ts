import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("desktop host migration creates an owner-scoped registry with bounded ports", () => {
  const database = new DatabaseSync(":memory:");
  const migration = readFileSync(
    new URL("../migrations/0030_desktop_hosts.sql", import.meta.url),
    "utf8",
  );
  database.exec(migration);
  database.exec(migration);

  const insert = database.prepare(`
    INSERT INTO desktop_hosts
      (owner_subject, id, owner, name, address, port, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run("github:1", "studio", "alice", "Alice's Studio", "100.64.1.2", 5901, 1, 1);
  insert.run("github:2", "studio", "bob", "Bob's Studio", "100.64.1.3", 5901, 1, 1);

  assert.equal(
    database.prepare("SELECT count(*) AS count FROM desktop_hosts WHERE id = 'studio'").get()
      ?.count,
    2,
  );
  assert.throws(
    () => insert.run("github:3", "bad", "bad", "Bad", "100.64.1.4", 0, 1, 1),
    /constraint/i,
  );
  assert.equal(
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get("idx_desktop_hosts_owner_updated")?.name,
    "idx_desktop_hosts_owner_updated",
  );
});
