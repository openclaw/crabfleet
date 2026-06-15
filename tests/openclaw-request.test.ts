import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  openClawCrabboxRequestHash,
  openClawRequestId,
  readOpenClawRequestSession,
} from "../src/worker/openclaw-request.ts";
import { normalizeRepo } from "../src/worker/repositories.ts";
import { sessionRow } from "./helpers/session-row.ts";

function d1(row: Record<string, unknown> | null): D1Database {
  return {
    prepare(sql: string) {
      assert.match(sql, /from "openclaw_request_replays" as "replay"/i);
      assert.match(sql, /left join "interactive_sessions" as "session"/i);
      return {
        bind(...parameters: unknown[]) {
          assert.equal(parameters[0], "request-1");
          return {
            async all() {
              return { results: row ? [row] : [], meta: {} };
            },
            async run() {
              return { meta: {} };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function env(row: Record<string, unknown> | null): RuntimeEnv {
  return { DB: d1(row) } as RuntimeEnv;
}

function replayRow(values: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...sessionRow({
      created_by: "service:openclaw",
      openclaw_request_id: "request-1",
      openclaw_request_hash: "hash-1",
      lease_id: null,
      attach_url: null,
      multiplayer_mode: 0,
    }),
    replay_request_hash: "hash-1",
    ...values,
  };
}

test("OpenClaw request IDs preserve exact caller identity within the size limit", () => {
  assert.equal(openClawRequestId(undefined), null);
  assert.equal(openClawRequestId(""), null);
  assert.equal(openClawRequestId(" request-1 "), " request-1 ");
  assert.throws(() => openClawRequestId(null), { message: "requestId must be a string" });
  assert.throws(() => openClawRequestId(42), { message: "requestId must be a string" });
  assert.throws(() => openClawRequestId("x".repeat(201)), {
    message: "requestId must be at most 200 characters",
  });
});

test("OpenClaw request hashes normalize repositories and include profile and secret identity", async () => {
  assert.equal(normalizeRepo(" HTTPS://github.com/OpenClaw/Crabfleet.git/ "), "openclaw/crabfleet");
  const base = {
    repo: "https://github.com/OpenClaw/Crabfleet.git",
    branch: "main",
    runtime: "invalid",
    profile: "large",
    githubToken: "token-a",
  };
  const first = await openClawCrabboxRequestHash(base, "owner", "container");
  assert.equal(
    first,
    await openClawCrabboxRequestHash(
      { ...base, repo: "openclaw/crabfleet", runtime: "container" },
      "owner",
      "container",
    ),
  );
  assert.notEqual(
    first,
    await openClawCrabboxRequestHash({ ...base, profile: "small" }, "owner", "container"),
  );
  assert.notEqual(
    first,
    await openClawCrabboxRequestHash({ ...base, githubToken: "token-b" }, "owner", "container"),
  );
});

test("OpenClaw replay lookup distinguishes conflicts, completion, preparation, and success", async () => {
  assert.equal(await readOpenClawRequestSession(env(null), "request-1", "hash-1"), null);

  await assert.rejects(
    readOpenClawRequestSession(
      env(replayRow({ replay_request_hash: "other" })),
      "request-1",
      "hash-1",
    ),
    { message: "OpenClaw crabbox request id already belongs to a different request" },
  );
  await assert.rejects(
    readOpenClawRequestSession(env(replayRow({ id: null })), "request-1", "hash-1"),
    { message: "OpenClaw crabbox request already completed and is no longer available" },
  );
  await assert.rejects(
    readOpenClawRequestSession(env(replayRow({ created_by: "github:42" })), "request-1", "hash-1"),
    { message: "OpenClaw crabbox replay record is inconsistent" },
  );
  await assert.rejects(
    readOpenClawRequestSession(env(replayRow({ preparation_pending: 1 })), "request-1", "hash-1"),
    { message: "OpenClaw crabbox request is still preparing" },
  );

  const session = await readOpenClawRequestSession(env(replayRow()), "request-1", "hash-1");
  assert.equal(session?.id, "IS-42");
  assert.equal(session?.rootSessionId, "IS-42");
  assert.deepEqual(session?.logs, []);
});
