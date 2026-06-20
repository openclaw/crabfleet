import assert from "node:assert/strict";
import test from "node:test";

import { CardRepository } from "../src/worker/card-repository.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { User } from "../src/worker/models.ts";

test("private card reads require the stable owner subject", async () => {
  const current: User = {
    subject: "github:42",
    login: "operator",
    email: "operator@example.test",
    name: "Operator",
    role: "owner",
    allowed: true,
    teams: [],
  };
  const env = {
    CRABFLEET_TENANCY_MODE: "private",
    DB: {
      prepare(query: string) {
        return {
          bind(...parameters: unknown[]) {
            assert.match(query, /"owner_subject" = \?/i);
            assert.deepEqual(parameters, ["github:42"]);
            return {
              async all() {
                return { results: [], meta: { changes: 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  assert.deepEqual(await new CardRepository(env).readCards(current), []);
});

test("card list batches related D1 reads below the bind-parameter limit", async () => {
  const cards = Array.from({ length: 205 }, (_, index) => ({
    id: `CY-${index + 1}`,
    title: `Card ${index + 1}`,
    prompt: "work",
    repo: "openclaw/crabfleet",
    source: "Prompt",
    runtime: "auto",
    policy: "open_pr",
    lane: "Running",
    owner: "operator",
    owner_subject: "github:42",
    started_at: 1,
    created_at: index + 1,
    changed_files: "[]",
    active_run_id: `RUN-${index + 1}`,
  }));
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = {
    DB: {
      prepare(query: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                executions.push({ sql: query, parameters });
                assert.ok(parameters.length <= 80, `${parameters.length} D1 bind parameters`);
                if (/from "cards"/i.test(query)) {
                  return { results: cards, meta: { changes: 0 } };
                }
                if (/from "run_attempts"/i.test(query)) {
                  return {
                    results: parameters.map((id, index) => ({
                      id,
                      card_id: `CY-${index + 1}`,
                      attempt: 1,
                      runtime: "container",
                      status: "running",
                      control_intent: null,
                      lease_id: null,
                      attach_url: null,
                      vnc_url: null,
                      selection_reason: "test",
                      capabilities_json: "{}",
                      operator: null,
                      last_heartbeat_at: 1,
                      started_at: 1,
                      ended_at: null,
                      created_at: 1,
                      updated_at: 1,
                      error: null,
                    })),
                    meta: { changes: 0 },
                  };
                }
                return { results: [], meta: { changes: 0 } };
              },
              async run() {
                throw new Error(`unexpected mutation: ${query}`);
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;

  const result = await new CardRepository(env).readCards();

  assert.equal(result.length, 205);
  assert.equal(executions.filter(({ sql }) => /from "run_attempts"/i.test(sql)).length, 3);
  assert.equal(executions.filter(({ sql }) => /from events/i.test(sql)).length, 3);
});
