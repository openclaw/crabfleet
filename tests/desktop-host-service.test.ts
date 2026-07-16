import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopHostRow, DesktopHostStore } from "../src/worker/desktop-host-repository.ts";
import {
  DesktopHostService,
  desktopHostTokenOwnershipMode,
} from "../src/worker/desktop-host-service.ts";
import type { User } from "../src/worker/models.ts";

const alice: User = {
  subject: "github:1",
  login: "alice",
  email: null,
  name: "Alice",
  role: "viewer",
  allowed: true,
  teams: [],
};

const bob: User = {
  ...alice,
  subject: "github:2",
  login: "bob",
};

class MemoryDesktopHostStore implements DesktopHostStore {
  readonly rows = new Map<string, DesktopHostRow>();

  async list(ownerSubject: string): Promise<DesktopHostRow[]> {
    return [...this.rows.values()].filter((row) => row.ownerSubject === ownerSubject);
  }

  async upsert(host: DesktopHostRow): Promise<DesktopHostRow> {
    const key = `${host.ownerSubject}:${host.id}`;
    const existing = this.rows.get(key);
    const stored = { ...host, createdAt: existing?.createdAt ?? host.createdAt };
    this.rows.set(key, stored);
    return stored;
  }

  async ownershipTokenForPublication(
    ownerSubject: string,
    id: string,
    publicationID: string,
  ): Promise<string | null> {
    const row = this.rows.get(`${ownerSubject}:${id}`);
    return row?.publicationID === publicationID ? row.ownershipToken : null;
  }

  async remove(ownerSubject: string, id: string, ownershipToken: string | null): Promise<void> {
    const key = `${ownerSubject}:${id}`;
    if (this.rows.get(key)?.ownershipToken === (ownershipToken ?? "")) {
      this.rows.delete(key);
    }
  }
}

test("desktop hosts are canonicalized and isolated to their stable owner", async () => {
  const store = new MemoryDesktopHostStore();
  let now = 42;
  const tokens = ["ownership-1", "ownership-2"];
  const service = new DesktopHostService(
    store,
    () => now,
    () => tokens.shift() ?? "unexpected-token",
  );
  const registration = await service.register(
    alice,
    " Studio.ONE ",
    {
      name: " Peter's Mac Studio ",
      address: "100.68.201.40",
      port: 5901,
    },
    desktopHostTokenOwnershipMode,
    "publication-1",
  );
  const host = registration.host;

  assert.deepEqual(host, {
    id: "studio.one",
    owner: "alice",
    name: "Peter's Mac Studio",
    address: "100.68.201.40",
    port: 5901,
    relayCapable: true,
    createdAt: 42,
    updatedAt: 42,
  });
  assert.equal(registration.ownershipToken, "ownership-1");
  assert.deepEqual(await service.list(alice), [host]);
  assert.deepEqual(await service.list(bob), []);

  now = 84;
  const updatedRegistration = await service.register(
    alice,
    host.id,
    {
      name: "Renamed Studio",
      address: host.address,
      port: host.port,
    },
    desktopHostTokenOwnershipMode,
    "publication-2",
  );
  const updated = updatedRegistration.host;
  assert.equal(updated.createdAt, 42);
  assert.equal(updated.updatedAt, 84);
  assert.equal(updated.name, "Renamed Studio");
  assert.equal(updatedRegistration.ownershipToken, "ownership-2");

  await service.remove(bob, host.id, updatedRegistration.ownershipToken);
  assert.deepEqual(await service.list(alice), [updated]);
  await service.remove(alice, host.id, updatedRegistration.ownershipToken);
  assert.deepEqual(await service.list(alice), []);
});

test("stale desktop host cleanup cannot remove a newer registration", async () => {
  const store = new MemoryDesktopHostStore();
  const tokens = ["old-process-token", "new-process-token"];
  const service = new DesktopHostService(
    store,
    () => 42,
    () => tokens.shift() ?? "unexpected-token",
  );
  const input = { name: "Studio", address: "100.64.1.2", port: 5901 };

  const oldRegistration = await service.register(
    alice,
    "studio",
    input,
    desktopHostTokenOwnershipMode,
    "old-publication",
  );
  const newRegistration = await service.register(
    alice,
    "studio",
    {
      ...input,
      name: "New Studio Process",
    },
    desktopHostTokenOwnershipMode,
    "new-publication",
  );

  await service.remove(alice, "studio", oldRegistration.ownershipToken);
  assert.deepEqual(await service.list(alice), [newRegistration.host]);

  await service.remove(alice, "studio", newRegistration.ownershipToken);
  assert.deepEqual(await service.list(alice), []);
});

test("tokenless cleanup removes only migrated legacy desktop hosts", async () => {
  const store = new MemoryDesktopHostStore();
  const service = new DesktopHostService(
    store,
    () => 42,
    () => "new-process-token",
  );
  const legacy: DesktopHostRow = {
    ownerSubject: alice.subject,
    id: "legacy-studio",
    owner: "alice",
    name: "Legacy Studio",
    address: "100.64.1.2",
    port: 5901,
    ownershipToken: "",
    publicationID: "",
    createdAt: 1,
    updatedAt: 1,
  };
  store.rows.set(`${alice.subject}:${legacy.id}`, legacy);
  const registration = await service.register(
    alice,
    "new-studio",
    {
      name: "New Studio",
      address: "100.64.1.3",
      port: 5901,
    },
    desktopHostTokenOwnershipMode,
    "new-studio-publication",
  );

  await service.remove(alice, legacy.id, null);
  await service.remove(alice, registration.host.id, null);

  assert.deepEqual(await service.list(alice), [registration.host]);
});

test("ambiguous desktop recovery cannot acquire a newer publication", async () => {
  const store = new MemoryDesktopHostStore();
  const tokens = ["old-process-token", "new-process-token"];
  const service = new DesktopHostService(
    store,
    () => 42,
    () => tokens.shift() ?? "unexpected-token",
  );
  const input = { name: "Studio", address: "100.64.1.2", port: 5901 };

  await service.register(alice, "studio", input, desktopHostTokenOwnershipMode, "publication-a");
  const newer = await service.register(
    alice,
    "studio",
    { ...input, name: "Newer Studio" },
    desktopHostTokenOwnershipMode,
    "publication-b",
  );

  assert.deepEqual(await service.recover(alice, "studio", "publication-a"), {
    ownershipToken: null,
  });
  assert.deepEqual(await service.list(alice), [newer.host]);
  assert.deepEqual(await service.recover(alice, "studio", "publication-b"), {
    ownershipToken: newer.ownershipToken,
  });
  assert.deepEqual(await service.recover(bob, "studio", "publication-b"), {
    ownershipToken: null,
  });
  for (const publicationID of [null, undefined, "", "bad publication", "a".repeat(201)]) {
    await assert.rejects(
      service.recover(alice, "studio", publicationID),
      /desktop host publication id/,
    );
  }
});

test("token ownership requires a valid publication before minting or persistence", async () => {
  const store = new MemoryDesktopHostStore();
  let tokenCreations = 0;
  const service = new DesktopHostService(
    store,
    () => 42,
    () => {
      tokenCreations += 1;
      return "ownership-token";
    },
  );
  const input = { name: "Studio", address: "100.64.1.2", port: 5901 };

  for (const publicationID of [
    null,
    undefined,
    "",
    "bad publication",
    "bad\npublication",
    "a".repeat(201),
  ]) {
    await assert.rejects(
      service.register(alice, "studio", input, desktopHostTokenOwnershipMode, publicationID),
      /desktop host publication id/,
    );
  }
  assert.equal(tokenCreations, 0);
  assert.equal(store.rows.size, 0);

  const legacy = await service.register(alice, "studio", input, "legacy", "ignored publication");
  assert.equal(legacy.ownershipToken, undefined);
  assert.equal(legacy.host.relayCapable, false);
  assert.equal(store.rows.get(`${alice.subject}:studio`)?.publicationID, "");
});

test("legacy clients register tokenless rows they can remove after a server upgrade", async () => {
  const store = new MemoryDesktopHostStore();
  const service = new DesktopHostService(
    store,
    () => 42,
    () => "must-not-be-created",
  );

  const registration = await service.register(alice, "rolling-upgrade", {
    name: "Rolling Upgrade",
    address: "100.64.1.4",
    port: 5901,
  });

  assert.equal(registration.ownershipToken, undefined);
  assert.equal(store.rows.get(`${alice.subject}:rolling-upgrade`)?.ownershipToken, "");
  await service.remove(alice, registration.host.id, null);
  assert.deepEqual(await service.list(alice), []);
});

test("desktop hosts accept only bounded metadata and Tailscale IPv4 endpoints", async () => {
  const service = new DesktopHostService(new MemoryDesktopHostStore());
  const valid = { name: "Studio", address: "100.127.255.254", port: 65_535 };
  await service.register(alice, "a", valid);

  for (const id of ["", "-host", "host-", "host/path", "a".repeat(81)]) {
    await assert.rejects(service.register(alice, id, valid), /desktop host id/);
  }
  for (const address of [
    "100.63.255.255",
    "100.128.0.1",
    "192.168.1.2",
    "100.064.1.2",
    "100.64.1.2.extra",
  ]) {
    await assert.rejects(service.register(alice, "studio", { ...valid, address }), /address/);
  }
  await assert.rejects(service.register(alice, "studio", { ...valid, name: "bad\nname" }), /name/);
  await assert.rejects(service.register(alice, "studio", { ...valid, port: 0 }), /port/);
  await assert.rejects(service.remove(alice, "studio", ""), /ownership token/);
  await assert.rejects(service.remove(alice, "studio", "bad token"), /ownership token/);
});
