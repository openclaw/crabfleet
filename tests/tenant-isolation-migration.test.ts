import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("tenant migration backfills only uniquely resolved stable subjects", () => {
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
      ('proxy:shared', 'shared', 'second@example.test', 1),
      ('bootstrap:first', 'bootstrap', NULL, 1),
      ('bootstrap:second', 'bootstrap', NULL, 1),
      ('github:email-only', NULL, 'email-only@example.test', 1),
      ('github:disabled', 'disabled', NULL, 0);
    INSERT INTO interactive_sessions
      (id, owner, control_requested_by, controller, updated_at)
    VALUES
      ('unique', '@operator', 'operator@example.test', 'operator', 1),
      ('ambiguous', 'shared', 'shared', 'shared', 1),
      ('bare-at', '@', '@', '@', 1),
      ('bootstrap', 'bootstrap', NULL, 'bootstrap', 1),
      ('missing', 'missing', NULL, NULL, 1),
      ('disabled', 'disabled', NULL, NULL, 1);
    INSERT INTO cards (id, owner, updated_at) VALUES
      ('unique', 'operator', 1),
      ('ambiguous', 'shared', 1),
      ('bare-at', '@', 1),
      ('bootstrap', 'bootstrap', 1),
      ('missing', 'missing', 1);
  `);

  db.exec(
    readFileSync(new URL("../migrations/0028_tenant_isolation.sql", import.meta.url), "utf8"),
  );

  assert.deepEqual(
    db
      .prepare(
        `SELECT id, owner_subject, control_requested_by_subject, controller_subject
         FROM interactive_sessions ORDER BY id`,
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: "ambiguous",
        owner_subject: "",
        control_requested_by_subject: null,
        controller_subject: null,
      },
      {
        id: "bare-at",
        owner_subject: "",
        control_requested_by_subject: null,
        controller_subject: null,
      },
      {
        id: "bootstrap",
        owner_subject: "bootstrap:owner",
        control_requested_by_subject: null,
        controller_subject: "bootstrap:owner",
      },
      {
        id: "disabled",
        owner_subject: "",
        control_requested_by_subject: null,
        controller_subject: null,
      },
      {
        id: "missing",
        owner_subject: "",
        control_requested_by_subject: null,
        controller_subject: null,
      },
      {
        id: "unique",
        owner_subject: "github:42",
        control_requested_by_subject: "github:42",
        controller_subject: "github:42",
      },
    ],
  );
  assert.deepEqual(
    db
      .prepare("SELECT id, owner_subject FROM cards ORDER BY id")
      .all()
      .map((row) => ({ ...row })),
    [
      { id: "ambiguous", owner_subject: "" },
      { id: "bare-at", owner_subject: "" },
      { id: "bootstrap", owner_subject: "bootstrap:owner" },
      { id: "missing", owner_subject: "" },
      { id: "unique", owner_subject: "github:42" },
    ],
  );

  db.exec(`
    INSERT INTO interactive_sessions
      (id, owner, control_requested_by, controller, updated_at)
    VALUES ('cutover', 'operator', NULL, NULL, 2);
    INSERT INTO cards (id, owner, updated_at) VALUES ('cutover', 'operator', 2);
    UPDATE interactive_sessions
    SET control_requested_by = 'operator', controller = 'operator'
    WHERE id = 'cutover';
  `);
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT owner_subject, control_requested_by_subject, controller_subject
       FROM interactive_sessions WHERE id = 'cutover'`,
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
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'cutover'").get()?.owner_subject,
    "github:42",
  );

  db.exec(`
    UPDATE interactive_sessions
    SET owner_subject = '', control_requested_by_subject = NULL, controller_subject = NULL
    WHERE id = 'cutover';
    UPDATE cards SET owner_subject = '' WHERE id = 'cutover';
  `);
  const backfill = readFileSync(
    new URL("../scripts/backfill-tenant-isolation.sql", import.meta.url),
    "utf8",
  );
  db.exec(backfill);
  db.exec(backfill);
  assert.equal(
    db.prepare("SELECT owner_subject FROM interactive_sessions WHERE id = 'bare-at'").get()
      ?.owner_subject,
    "",
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'bare-at'").get()?.owner_subject,
    "",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()?.count,
    6,
  );
  db.exec(`
    INSERT INTO interactive_sessions
      (id, owner, control_requested_by, controller, updated_at)
    VALUES ('late-cutover', 'operator', NULL, NULL, 3);
    INSERT INTO cards (id, owner, updated_at) VALUES ('late-cutover', 'operator', 3);
  `);
  assert.equal(
    db.prepare("SELECT owner_subject FROM interactive_sessions WHERE id = 'late-cutover'").get()
      ?.owner_subject,
    "github:42",
  );
  assert.equal(
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'late-cutover'").get()?.owner_subject,
    "github:42",
  );

  const finalize = readFileSync(
    new URL("../scripts/finalize-tenant-isolation.sql", import.meta.url),
    "utf8",
  );
  assert.equal(finalize.startsWith(backfill), true);
  db.exec(finalize);
  db.exec(finalize);
  assert.deepEqual(
    {
      ...db
        .prepare(
          `SELECT owner_subject, control_requested_by_subject, controller_subject
       FROM interactive_sessions WHERE id = 'cutover'`,
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
    db.prepare("SELECT owner_subject FROM cards WHERE id = 'cutover'").get()?.owner_subject,
    "github:42",
  );
  assert.equal(
    db.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'trigger'").get()?.count,
    0,
  );

  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.match(packageJson.scripts.deploy, /deploy:tenant-backfill/);
  assert.doesNotMatch(packageJson.scripts.deploy, /deploy:tenant-finalize/);
  const workflow = readFileSync(
    new URL("../.github/workflows/deploy-worker.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /pnpm deploy:tenant-backfill/);
  assert.doesNotMatch(workflow, /pnpm deploy:tenant-finalize/);
});
