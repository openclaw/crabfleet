import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  boundedUtf8Tail,
  openClawBranchPreparationCanDefer,
  openClawGitBranchAllowed,
  openClawGitHubRepoParts,
  openClawRoomMaxSessions,
  openClawRoomRootAllowed,
  openClawRoomSessionChainAllowed,
  openClawRoomSessionAllowed,
  openClawServiceAuthorized,
  openClawTranscriptMaxBytes,
  sessionBelongsToRoot,
} from "../src/openclaw-service.ts";
import { openClawRequestId } from "../src/worker/openclaw-request.ts";

test("OpenClaw service authorization accepts dedicated scoped consumers", () => {
  assert.equal(openClawServiceAuthorized("Bearer openclaw", ["openclaw", "multicodex"]), true);
  assert.equal(openClawServiceAuthorized("Bearer multicodex", ["openclaw", "multicodex"]), true);
  assert.equal(openClawServiceAuthorized("Bearer public", ["openclaw", "multicodex"]), false);
  assert.equal(openClawServiceAuthorized(null, [undefined, null]), false);
});

test("OpenClaw branch preparation defers masked control-plane permission failures", () => {
  assert.equal(openClawBranchPreparationCanDefer(403), true);
  assert.equal(openClawBranchPreparationCanDefer(404), true);
  assert.equal(openClawBranchPreparationCanDefer(401), false);
  assert.equal(openClawBranchPreparationCanDefer(500), false);
});

test("OpenClaw GitHub branch writes reject lossy or invalid refs", () => {
  assert.equal(openClawGitBranchAllowed("main"), true);
  assert.equal(openClawGitBranchAllowed("feature/team-room"), true);
  assert.equal(openClawGitBranchAllowed("x".repeat(120)), true);
  assert.equal(openClawGitBranchAllowed("x".repeat(121)), false);
  assert.equal(openClawGitBranchAllowed("feature/team-room "), false);
  assert.equal(openClawGitBranchAllowed("feature//team-room"), false);
  assert.equal(openClawGitBranchAllowed("feature/../team-room"), false);
  assert.equal(openClawGitBranchAllowed("feature/team-room.lock"), false);
});

test("OpenClaw GitHub writes require one exact owner/name pair", () => {
  assert.deepEqual(openClawGitHubRepoParts("openclaw/crabfleet"), {
    owner: "openclaw",
    name: "crabfleet",
  });
  assert.equal(openClawGitHubRepoParts("openclaw/crabfleet/extra"), null);
  assert.equal(openClawGitHubRepoParts("openclaw/crabfleet?ref=main"), null);
  assert.equal(openClawGitHubRepoParts("open_claw/crabfleet"), null);
  assert.equal(openClawGitHubRepoParts("openclaw/"), null);
});

test("session root fences accept the root and every child only for the exact root", () => {
  assert.equal(sessionBelongsToRoot("IS-10", "IS-10", "IS-10"), true);
  assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-10"), true);
  assert.equal(sessionBelongsToRoot("IS-11", "IS-10", "IS-99"), false);
  assert.equal(sessionBelongsToRoot("IS-10", null, "IS-10"), true);
  assert.equal(sessionBelongsToRoot("IS-10", null, ""), false);
});

test("room supervision accepts service roots and their agent-created non-action descendants", () => {
  const root = {
    id: "IS-10",
    parentSessionId: null,
    rootSessionId: "IS-10",
    runtime: "container",
    createdBy: "service:openclaw",
    workKey: null,
  };
  assert.equal(openClawRoomSessionAllowed(root), true);
  assert.equal(openClawRoomRootAllowed(root), true);
  assert.equal(openClawRoomRootAllowed({ ...root, id: "IS-11" }), false);
  assert.equal(
    openClawRoomSessionAllowed({
      ...root,
      id: "IS-11",
      parentSessionId: "IS-10",
      createdBy: "session:IS-10",
    }),
    true,
  );
  assert.equal(openClawRoomRootAllowed({ ...root, createdBy: "session:IS-10" }), false);
  assert.equal(openClawRoomSessionAllowed({ ...root, runtime: "github_actions" }), false);
  assert.equal(openClawRoomSessionAllowed({ ...root, createdBy: "github:123" }), false);
  assert.equal(openClawRoomSessionAllowed({ ...root, workKey: "repo:pr:1" }), false);

  const child = { ...root, id: "IS-11", parentSessionId: "IS-10" };
  const agent = {
    ...root,
    id: "IS-12",
    parentSessionId: "IS-11",
    createdBy: "session:IS-11",
  };
  assert.equal(openClawRoomSessionChainAllowed([root, child, agent], agent.id, root.id), true);
  assert.equal(openClawRoomSessionChainAllowed([root, agent], agent.id, root.id), false);
  assert.equal(
    openClawRoomSessionChainAllowed(
      [root, { ...child, createdBy: "github:123" }, agent],
      agent.id,
      root.id,
    ),
    false,
  );
});

test("bounded transcript tails remain valid UTF-8 and report truncation", () => {
  assert.deepEqual(boundedUtf8Tail("hello", 5), { text: "hello", truncated: false });
  assert.deepEqual(boundedUtf8Tail("hello", 4), { text: "ello", truncated: true });
  assert.deepEqual(boundedUtf8Tail("a\u00E9b", 2), { text: "b", truncated: true });
  assert.deepEqual(boundedUtf8Tail("\u{1F600}\u{1F600}", 5), {
    text: "\u{1F600}",
    truncated: true,
  });
  assert.ok(
    new TextEncoder().encode(boundedUtf8Tail("\u{1F600}\u{1F600}", 5).text).byteLength <= 5,
  );
  assert.equal(openClawTranscriptMaxBytes, 64 * 1024);
  assert.equal(openClawRoomMaxSessions, 64);
});

test("OpenClaw room reservation precedes branch mutation, event recording, and provisioning", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0025_interactive_session_preparation.sql", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  const readStart = source.indexOf("async function readInteractiveSessions");
  const readEnd = source.indexOf("async function readSharedInteractiveSession", readStart);
  const readSource = source.slice(readStart, readEnd);

  assert.match(migration, /ADD COLUMN preparation_pending INTEGER NOT NULL DEFAULT 0/);
  assert.match(readSource, /\.where\("preparation_pending", "=", 0\)/);
  assert.match(
    createSource,
    /adapter: adapterWorkspaceId && !preparationReservation \? runtimeAdapterName : null/,
  );
  assert.match(
    createSource,
    /adapter_create_pending: adapterWorkspaceId && !preparationReservation \? 1 : 0/,
  );
  assert.match(
    createSource,
    /const preparationReservation = Boolean\(options\.afterReserve \|\| supervisedRootSessionId\)/,
  );
  assert.match(createSource, /preparation_pending: preparationReservation \? 1 : 0/);
  assert.ok(
    createSource.indexOf("supervision.enforceRoomSessionLimitAfterInsert") <
      createSource.indexOf("await options.afterReserve"),
  );
  assert.ok(
    createSource.indexOf("await options.afterReserve") <
      createSource.indexOf("supervision.requireReservationActivation"),
  );
  assert.ok(
    createSource.indexOf("supervision.requireReservationActivation") <
      createSource.indexOf("appendInteractiveSessionEvent"),
  );
  assert.ok(
    createSource.indexOf("await options.afterReserve") <
      createSource.indexOf("provisionInteractiveSession"),
  );
  assert.match(
    createSource,
    /catch \(error\) \{\s+await supervision\.rollbackReservation\(id, now\);\s+throw error;/,
  );
});

test("OpenClaw crabbox persistence reserves durable idempotency before provisioning", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const migration = await readFile(
    new URL("../migrations/0026_openclaw_lifecycle_guarantees.sql", import.meta.url),
    "utf8",
  );
  const createStart = source.indexOf("async function createInteractiveSessionFromInput");
  const createEnd = source.indexOf("function initialRuntimeAdapterWorkspaceId", createStart);
  const createSource = source.slice(createStart, createEnd);
  assert.match(migration, /ADD COLUMN openclaw_request_id TEXT/);
  assert.match(migration, /UNIQUE INDEX IF NOT EXISTS idx_interactive_sessions_openclaw_request/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS openclaw_request_replays/);
  assert.equal(openClawRequestId("request-1"), "request-1");
  assert.match(createSource, /openclaw_request_id: options\.openClawRequestId \?\? null/);
  assert.match(createSource, /openclaw_request_hash: options\.openClawRequestHash \?\? null/);
  assert.match(createSource, /\.insertInto\("openclaw_request_replays"\)/);
  assert.match(createSource, /!reservationInserted &&\s+isConstraintError\(error\)/);
  assert.match(createSource, /if \(reservationInserted \|\| !isConstraintError\(error\)/);
});

test("OpenClaw lifecycle guarantees are documented", async () => {
  const docs = await readFile(new URL("../docs/api.md", import.meta.url), "utf8");
  assert.match(docs, /requestId/);
  assert.match(docs, /session-roots\/:rootSessionId\/actions/);
  assert.match(docs, /freeze room-tree\s+admission/);
});
