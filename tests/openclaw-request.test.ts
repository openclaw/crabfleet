import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  openClawCrabboxRequestHash,
  openClawRequestId,
  readOpenClawRequestSession,
} from "../src/worker/openclaw-request.ts";
import { normalizeRepo } from "../src/worker/repositories.ts";

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
    replay_request_hash: "hash-1",
    id: "IS-42",
    created_by: "service:openclaw",
    openclaw_request_id: "request-1",
    openclaw_request_hash: "hash-1",
    preparation_pending: 0,
    parent_session_id: null,
    root_session_id: null,
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "container",
    adapter: null,
    profile: "default",
    adapter_workspace_id: null,
    adapter_control_plane: null,
    provider_resource_id: null,
    capabilities_json: "{}",
    expires_at: null,
    last_reconciled_at: null,
    reconcile_error: null,
    command: "codex",
    prompt: "Fix issue",
    purpose: "Fix issue",
    summary: "Working",
    owner: "owner",
    status: "ready",
    lease_id: null,
    attach_url: null,
    vnc_url: null,
    last_event: "ready",
    created_at: 1,
    updated_at: 2,
    last_seen_at: 3,
    stopped_at: null,
    share_mode: "private",
    share_token_preview: null,
    control_requested_by: null,
    control_requested_at: null,
    controller: null,
    control_granted_at: null,
    control_expires_at: null,
    multiplayer_mode: 0,
    work_key: null,
    work_kind: null,
    work_state: "",
    work_phase: "",
    source_url: null,
    github_run_url: null,
    codex_thread_id: null,
    codex_turn_id: null,
    last_heartbeat_at: null,
    completion_reason: null,
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
