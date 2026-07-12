import assert from "node:assert/strict";
import test from "node:test";

import type { DesktopHostRow, DesktopHostStore } from "../src/worker/desktop-host-repository.ts";
import { DesktopHostService } from "../src/worker/desktop-host-service.ts";
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

  async remove(ownerSubject: string, id: string, ownershipToken: string): Promise<void> {
    const key = `${ownerSubject}:${id}`;
    if (this.rows.get(key)?.ownershipToken === ownershipToken) {
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
  const registration = await service.register(alice, " Studio.ONE ", {
    name: " Peter's Mac Studio ",
    address: "100.68.201.40",
    port: 5901,
  });
  const host = registration.host;

  assert.deepEqual(host, {
    id: "studio.one",
    owner: "alice",
    name: "Peter's Mac Studio",
    address: "100.68.201.40",
    port: 5901,
    createdAt: 42,
    updatedAt: 42,
  });
  assert.equal(registration.ownershipToken, "ownership-1");
  assert.deepEqual(await service.list(alice), [host]);
  assert.deepEqual(await service.list(bob), []);

  now = 84;
  const updatedRegistration = await service.register(alice, host.id, {
    name: "Renamed Studio",
    address: host.address,
    port: host.port,
  });
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

  const oldRegistration = await service.register(alice, "studio", input);
  const newRegistration = await service.register(alice, "studio", {
    ...input,
    name: "New Studio Process",
  });

  await service.remove(alice, "studio", oldRegistration.ownershipToken);
  assert.deepEqual(await service.list(alice), [newRegistration.host]);

  await service.remove(alice, "studio", newRegistration.ownershipToken);
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
  await assert.rejects(service.remove(alice, "studio", null), /ownership token/);
  await assert.rejects(service.remove(alice, "studio", "bad token"), /ownership token/);
});
