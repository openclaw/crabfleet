import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  closeOpenClawRootAdmission,
  openClawRootAdmissionOpen,
  readOpenClawLineageSession,
  readOpenClawRoomRoot,
  readOpenClawRoomSessions,
  readOpenClawRootCompletion,
  readOpenClawRootRows,
} from "../src/worker/openclaw-repository.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };
type D1Handler = (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result;

function runtimeEnv(handler: D1Handler): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                const result = handler(sql, parameters, "all");
                return { results: result.results ?? [], meta: { changes: result.changes ?? 0 } };
              },
              async run() {
                const result = handler(sql, parameters, "run");
                return { meta: { changes: result.changes ?? 0 } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("OpenClaw room reads are bounded, filtered, and do not load logs", async () => {
  const queries: string[] = [];
  const root = sessionRow({
    id: "IS-1",
    root_session_id: "IS-1",
    created_by: "service:openclaw",
  });
  const child = sessionRow({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
    created_at: 2,
  });
  const overflow = sessionRow({
    id: "IS-3",
    parent_session_id: "IS-2",
    root_session_id: "IS-1",
    created_by: "session:IS-2",
    created_at: 3,
  });
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    queries.push(sql);
    if (/root_session_id/i.test(sql)) {
      assert.match(sql, /created_by/i);
      assert.match(sql, /runtime.*!=/is);
      assert.match(sql, /work_key.*is null/is);
      assert.match(sql, /preparation_pending.*=/is);
      assert.match(sql, /order by.*created_at.*asc/is);
      assert.equal(parameters.at(-1), 3);
      return { results: [root, child, overflow] };
    }
    assert.match(sql, /where "id" = .+ "preparation_pending" =/i);
    return { results: [root] };
  });
  const roomRoot = await readOpenClawRoomRoot(env, "IS-1");
  const room = await readOpenClawRoomSessions(env, "IS-1", 2);

  assert.equal(queries.length, 2);
  assert.equal(roomRoot?.id, "IS-1");
  assert.deepEqual(
    room.sessions.map((session) => session.id),
    ["IS-1", "IS-2"],
  );
  assert.deepEqual(
    room.sessions.map((session) => session.logs),
    [[], []],
  );
  assert.equal(room.overflow, true);
});

test("OpenClaw room descendants are not read until callers validate the root", async () => {
  let queries = 0;
  const root = await readOpenClawRoomRoot(
    runtimeEnv((sql, _parameters, kind) => {
      assert.equal(kind, "all");
      queries += 1;
      assert.doesNotMatch(sql, /root_session_id/i);
      assert.match(sql, /where "id" = .+ "preparation_pending" =/i);
      return { results: [] };
    }),
    "IS-1",
  );
  assert.equal(root, null);
  assert.equal(queries, 1);
});

test("OpenClaw cleanup reads prioritize reservations and report terminal completion", async () => {
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    assert.equal(parameters[0], "IS-1");
    if (/count\(\*\) AS total/i.test(sql)) {
      assert.match(sql, /status NOT IN \('stopped', 'expired', 'failed'\)/);
      return { results: [{ total: "3", remaining: "1" }] };
    }
    assert.match(sql, /CASE\s+WHEN preparation_pending != 0 THEN 0/is);
    assert.match(sql, /created_by/i);
    assert.equal(parameters.at(-1), 4);
    return {
      results: [
        sessionRow({
          id: "IS-2",
          root_session_id: "IS-1",
          created_by: "session:IS-1",
          preparation_pending: 1,
        }),
      ],
    };
  });

  const rows = await readOpenClawRootRows(env, "IS-1", 4);
  assert.equal(rows[0]?.preparation_pending, 1);
  assert.deepEqual(await readOpenClawRootCompletion(env, "IS-1"), {
    total: 3,
    remaining: 1,
  });
});

test("OpenClaw admission and lineage persistence preserve explicit preparation states", async () => {
  let admissionClosed = 0;
  const env = runtimeEnv((sql, parameters, kind) => {
    if (/^update "interactive_sessions"/i.test(sql)) {
      assert.equal(kind, "run");
      assert.deepEqual(parameters, [1, "IS-1"]);
      admissionClosed = 1;
      return { changes: 1 };
    }
    assert.equal(kind, "all");
    if (/select "openclaw_admission_closed"/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-1"]);
      return { results: [{ openclaw_admission_closed: admissionClosed }] };
    }
    assert.match(sql, /select .* from "interactive_sessions"/i);
    assert.deepEqual(parameters, ["IS-2", 1]);
    return {
      results: [
        sessionRow({
          id: "IS-2",
          root_session_id: "IS-1",
          preparation_pending: 1,
          created_by: "session:IS-1",
        }),
      ],
    };
  });

  assert.equal(await openClawRootAdmissionOpen(env, "IS-1"), true);
  await closeOpenClawRootAdmission(env, "IS-1");
  assert.equal(await openClawRootAdmissionOpen(env, "IS-1"), false);
  const lineage = await readOpenClawLineageSession(env, "IS-2", 1);
  assert.equal(lineage?.id, "IS-2");
  assert.deepEqual(lineage?.logs, []);
});
