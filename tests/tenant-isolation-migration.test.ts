import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("tenant migration finalizes stable subjects and removes cutover writers", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE users (
      subject TEXT PRIMARY KEY,
      login TEXT,
      email TEXT,
      allowed INTEGER NOT NULL
    );
    CREATE TABLE interactive_sessions (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      control_requested_by TEXT,
      controller TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE cards (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    INSERT INTO users (subject, login, email, allowed) VALUES
      ('github:42', 'operator', 'operator@example.test', 1),
      ('github:77', 'shared', 'first@example.test', 1),
      ('proxy:shared', 'shared', 'second@example.test', 1);
    INSERT INTO interactive_sessions
      (id, owner, control_requested_by, controller, updated_at)
    VALUES
      ('unique', '@operator', 'operator@example.test', 'operator', 1),
      ('ambiguous', 'shared', 'shared', 'shared', 1);
    INSERT INTO cards (id, owner, updated_at) VALUES
      ('unique', 'operator', 1),
      ('ambiguous', 'shared', 1);
  `);

  db.exec(
    readFileSync(new URL("../migrations/0028_tenant_isolation.sql", import.meta.url), "utf8"),
  );
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT owner_subject, control_requested_by_subject, controller_subject
           FROM interactive_sessions WHERE id = 'unique'`,
        )
        .get(),
    },
    {
      owner_subject: "github:42",
      control_requested_by_subject: "github:42",
      controller_subject: "github:42",
    },
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'unique'").get()?.owner_subject,
    "github:42",
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM interactive_sessions WHERE id = 'ambiguous'").get()
      ?.owner_subject,
    "",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()?.count,
    6,
  );

  const finalize = readFileSync(
    new URL("../migrations/0029_remove_tenant_cutover_compatibility.sql", import.meta.url),
    "utf8",
  );
  db.exec("UPDATE users SET allowed = 0 WHERE subject = 'proxy:shared'");
  db.exec(finalize);
  db.exec(finalize);
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT owner_subject, control_requested_by_subject, controller_subject
           FROM interactive_sessions WHERE id = 'ambiguous'`,
        )
        .get(),
    },
    {
      owner_subject: "github:77",
      control_requested_by_subject: "github:77",
      controller_subject: "github:77",
    },
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'ambiguous'").get()?.owner_subject,
    "github:77",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()?.count,
    0,
  );

  db.exec(`
    INSERT INTO interactive_sessions
      (id, owner, owner_subject, control_requested_by, controller, updated_at)
    VALUES ('subject-required', 'operator', '', NULL, NULL, 2);
    INSERT INTO cards (id, owner, owner_subject, updated_at)
    VALUES ('subject-required', 'operator', '', 2);
  `);
  assert.equal(
    db.prepare("SELECT owner_subject FROM interactive_sessions WHERE id = 'subject-required'").get()
      ?.owner_subject,
    "",
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'subject-required'").get()
      ?.owner_subject,
    "",
  );

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.doesNotMatch(JSON.stringify(packageJson.scripts), /tenant-(?:backfill|finalize)/);
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-worker.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(workflow, /tenant isolation backfill|deploy:tenant-/i);
});
