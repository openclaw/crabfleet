import assert from "node:assert/strict";
import test from "node:test";

import { DesktopHostRepository } from "../src/worker/desktop-host-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

test("desktop host repository scopes reads, upserts, and deletes by owner subject", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const stored = {
    owner_subject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    ownership_token: "ownership-token",
    created_at: 1,
    updated_at: 2,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            executions.push({ sql, parameters });
            return {
              async all() {
                return { results: [stored], meta: { changes: 0 } };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
  const repository = new DesktopHostRepository(env);

  assert.deepEqual(await repository.list("github:1"), [
    {
      ownerSubject: "github:1",
      id: "studio",
      owner: "alice",
      name: "Studio",
      address: "100.64.1.2",
      port: 5901,
      ownershipToken: "ownership-token",
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  assert.match(executions[0]?.sql ?? "", /where "owner_subject" = \?/i);
  assert.deepEqual(executions[0]?.parameters, ["github:1"]);

  const upserted = await repository.upsert({
    ownerSubject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Studio",
    address: "100.64.1.2",
    port: 5901,
    ownershipToken: "ownership-token",
    createdAt: 1,
    updatedAt: 2,
  });
  assert.equal(upserted.id, "studio");
  assert.match(executions[1]?.sql ?? "", /^insert into "desktop_hosts"/i);
  assert.match(executions[1]?.sql ?? "", /\breturning \*/i);

  await repository.remove("github:1", "studio", "ownership-token");
  assert.match(executions[2]?.sql ?? "", /^delete from "desktop_hosts"/i);
  assert.match(executions[2]?.sql ?? "", /"ownership_token" = \?/i);
  assert.deepEqual(executions[2]?.parameters, ["github:1", "studio", "ownership-token"]);

  await repository.remove("github:1", "legacy-studio", null);
  assert.match(executions[3]?.sql ?? "", /^delete from "desktop_hosts"/i);
  assert.match(executions[3]?.sql ?? "", /"ownership_token" = \?/i);
  assert.deepEqual(executions[3]?.parameters, ["github:1", "legacy-studio", ""]);
});

test("desktop host upsert returns the row written by the same atomic statement", async () => {
  const executions: string[] = [];
  const written = {
    owner_subject: "github:1",
    id: "studio",
    owner: "alice",
    name: "Host A",
    address: "100.64.1.2",
    port: 5901,
    ownership_token: "token-a",
    created_at: 1,
    updated_at: 2,
  };
  const competing = {
    ...written,
    owner: "bob",
    name: "Host B",
    address: "100.64.1.3",
    ownership_token: "token-b",
    updated_at: 3,
  };
  const env = {
    DB: {
      prepare(sql: string) {
        executions.push(sql);
        return {
          bind() {
            return {
              async all() {
                return {
                  results: [/^insert into "desktop_hosts"/i.test(sql) ? written : competing],
                  meta: { changes: 1 },
                };
              },
              async run() {
                return { meta: { changes: 1 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  const row = await new DesktopHostRepository(env).upsert({
    ownerSubject: written.owner_subject,
    id: written.id,
    owner: written.owner,
    name: written.name,
    address: written.address,
    port: written.port,
    ownershipToken: written.ownership_token,
    createdAt: written.created_at,
    updatedAt: written.updated_at,
  });

  assert.equal(executions.length, 1);
  assert.match(executions[0] ?? "", /^insert into "desktop_hosts".*\breturning \*/is);
  assert.equal(row.name, "Host A");
  assert.equal(row.ownershipToken, "token-a");
});
