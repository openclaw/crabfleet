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
  const ownershipMigration = readFileSync(
    new URL("../migrations/0033_desktop_host_ownership.sql", import.meta.url),
    "utf8",
  );
  database.exec(migration);
  database.exec(migration);
  database.exec(ownershipMigration);
  database.exec(
    readFileSync(
      new URL("../migrations/0038_desktop_host_publication_identity.sql", import.meta.url),
      "utf8",
    ),
  );
  database.exec(
    readFileSync(
      new URL("../migrations/0041_desktop_host_ownership_errors.sql", import.meta.url),
      "utf8",
    ),
  );
  database.exec(
    readFileSync(new URL("../migrations/0042_desktop_host_quic.sql", import.meta.url), "utf8"),
  );

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
  assert.equal(
    database
      .prepare("SELECT ownership_token FROM desktop_hosts WHERE owner_subject = 'github:1'")
      .get()?.ownership_token,
    "",
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          "SELECT quic_port, quic_cert_hash, webtransport FROM desktop_hosts WHERE owner_subject = 'github:1'",
        )
        .get(),
    },
    { quic_port: null, quic_cert_hash: null, webtransport: 0 },
  );
  assert.equal(
    database
      .prepare("SELECT publication_id FROM desktop_hosts WHERE owner_subject = 'github:1'")
      .get()?.publication_id,
    "",
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

test("desktop host QUIC migration persists pins and rejects malformed capability values", () => {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0030_desktop_hosts.sql",
    "0033_desktop_host_ownership.sql",
    "0038_desktop_host_publication_identity.sql",
    "0041_desktop_host_ownership_errors.sql",
    "0042_desktop_host_quic.sql",
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO desktop_hosts (
      owner_subject, id, owner, name, address, port, quic_port, quic_cert_hash,
      webtransport, ownership_token, publication_id, created_at, updated_at
    ) VALUES (
      'github:1', 'studio', 'alice', 'Studio', '100.64.1.2', 5901, 5911,
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 0,
      'test-ownership-token-1', 'test-publication-1', 1, 2
    )
  `);

  assert.deepEqual(
    {
      ...database
        .prepare("SELECT quic_port, quic_cert_hash, webtransport FROM desktop_hosts")
        .get(),
    },
    {
      quic_port: 5911,
      quic_cert_hash: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      webtransport: 0,
    },
  );
  assert.throws(
    () =>
      database.exec(`
        INSERT INTO desktop_hosts (
          owner_subject, id, owner, name, address, port, webtransport, created_at, updated_at
        ) VALUES ('github:1', 'bad', 'alice', 'Bad', '100.64.1.3', 5901, 2, 1, 1)
      `),
    /constraint/i,
  );
});

test("desktop host publication migration clears identities rotated by old workers", () => {
  const database = new DatabaseSync(":memory:");
  for (const migration of [
    "0030_desktop_hosts.sql",
    "0033_desktop_host_ownership.sql",
    "0038_desktop_host_publication_identity.sql",
    "0041_desktop_host_ownership_errors.sql",
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), "utf8"));
  }
  database.exec(`
    INSERT INTO desktop_hosts (
      owner_subject, id, owner, name, address, port, ownership_token, publication_id,
      publication_write_token, created_at, updated_at
    ) VALUES (
      'github:1', 'studio', 'alice', 'Studio', '100.64.1.2', 5901,
      'token-a', 'publication-a', 'token-a', 1, 2
    );
    UPDATE desktop_hosts
    SET ownership_token = 'token-b'
    WHERE owner_subject = 'github:1' AND id = 'studio';
  `);

  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT ownership_token, publication_id, publication_write_token
          FROM desktop_hosts
          WHERE id = 'studio'
        `)
        .get(),
    },
    { ownership_token: "token-b", publication_id: "", publication_write_token: "" },
  );
});

test("desktop host ownership migration blocks old-worker mutations of token-owned rows", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(
    readFileSync(new URL("../migrations/0030_desktop_hosts.sql", import.meta.url), "utf8"),
  );
  database.exec(
    readFileSync(new URL("../migrations/0033_desktop_host_ownership.sql", import.meta.url), "utf8"),
  );
  database.exec(
    readFileSync(
      new URL("../migrations/0041_desktop_host_ownership_errors.sql", import.meta.url),
      "utf8",
    ),
  );
  database.exec(`
    INSERT INTO desktop_hosts (
      owner_subject, id, owner, name, address, port, ownership_token, created_at, updated_at
    ) VALUES
      ('github:1', 'owned', 'alice', 'Owned Studio', '100.64.1.2', 5901, 'token-1', 1, 2),
      ('github:1', 'legacy', 'alice', 'Legacy Studio', '100.64.1.3', 5901, '', 1, 2);
  `);

  const oldWorkerUpsert = database.prepare(`
    INSERT INTO desktop_hosts (
      owner_subject, id, owner, name, address, port, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_subject, id) DO UPDATE SET
      owner = excluded.owner,
      name = excluded.name,
      address = excluded.address,
      port = excluded.port,
      updated_at = excluded.updated_at
  `);
  assert.throws(
    () =>
      oldWorkerUpsert.run(
        "github:1",
        "owned",
        "old-worker",
        "Overwritten",
        "100.64.1.99",
        5902,
        10,
        20,
      ),
    /token-owned desktop host update requires ownership token/,
  );
  oldWorkerUpsert.run(
    "github:1",
    "legacy",
    "old-worker",
    "Updated Legacy",
    "100.64.1.4",
    5902,
    10,
    20,
  );

  assert.deepEqual(
    {
      ...database
        .prepare(`
          SELECT owner, name, address, port, ownership_token, created_at, updated_at
          FROM desktop_hosts
          WHERE id = 'owned'
        `)
        .get(),
    },
    {
      owner: "alice",
      name: "Owned Studio",
      address: "100.64.1.2",
      port: 5901,
      ownership_token: "token-1",
      created_at: 1,
      updated_at: 2,
    },
  );
  assert.equal(
    database.prepare("SELECT name FROM desktop_hosts WHERE id = 'legacy'").get()?.name,
    "Updated Legacy",
  );

  assert.throws(
    () =>
      database.exec("DELETE FROM desktop_hosts WHERE owner_subject = 'github:1' AND id = 'owned'"),
    /token-owned desktop host delete requires ownership token/,
  );
  database.exec("DELETE FROM desktop_hosts WHERE owner_subject = 'github:1' AND id = 'legacy'");
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM desktop_hosts WHERE id = 'owned'").get()?.count,
    1,
  );
  assert.equal(
    database.prepare("SELECT count(*) AS count FROM desktop_hosts WHERE id = 'legacy'").get()
      ?.count,
    0,
  );

  database.exec(`
    UPDATE desktop_hosts
    SET ownership_token = 'delete-authorized:test'
    WHERE owner_subject = 'github:1' AND id = 'owned' AND ownership_token = 'token-1';
    DELETE FROM desktop_hosts
    WHERE owner_subject = 'github:1'
      AND id = 'owned'
      AND ownership_token = 'delete-authorized:test';
  `);
  assert.equal(database.prepare("SELECT count(*) AS count FROM desktop_hosts").get()?.count, 0);
});
