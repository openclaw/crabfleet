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
  assert.match(executions[2]?.sql ?? "", /where "owner_subject" = \? and "id" = \?/i);
  assert.deepEqual(executions[2]?.parameters, ["github:1", "studio"]);

  await repository.remove("github:1", "studio", "ownership-token");
  assert.match(executions[3]?.sql ?? "", /^delete from "desktop_hosts"/i);
  assert.match(executions[3]?.sql ?? "", /"ownership_token" = \?/i);
  assert.deepEqual(executions[3]?.parameters, ["github:1", "studio", "ownership-token"]);
});
