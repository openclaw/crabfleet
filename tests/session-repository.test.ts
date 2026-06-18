import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  buildInteractiveSessionReservationValues,
  countInteractiveSessionEvents,
  insertInteractiveSessionReservation,
  markInteractiveSessionPendingAdapter,
  persistGitHubActionsSessionStop,
  persistInteractiveSessionEventMutation,
  persistInteractiveSessionProvisionResult,
  readAgentSessionCredential,
  readInteractiveSessionEventRows,
  readInteractiveSessionLogArchives,
  readInteractiveSessionLogs,
  readInteractiveSessionRecord,
  readInteractiveSessionRecords,
  readInteractiveSessionShareCredential,
  readInteractiveSessionTerminalCleanupIntent,
  readRuntimeAdapterCreatePending,
  readVisibleInteractiveSessionRow,
  readVisibleInteractiveSessionRows,
} from "../src/worker/session-repository.ts";
import { containerCapabilities } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };
type D1Handler = (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result;
type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: D1Handler,
  batchHandler: (statements: PreparedStatement[]) => unknown[] | void = () => undefined,
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            const statement: PreparedStatement = {
              sql,
              parameters,
              async all() {
                const result = handler(sql, parameters, "all");
                return { results: result.results ?? [], meta: { changes: result.changes ?? 0 } };
              },
              async run() {
                const result = handler(sql, parameters, "run");
                return { meta: { changes: result.changes ?? 0 } };
              },
            };
            return statement;
          },
        };
      },
      async batch(statements: unknown[]) {
        return batchHandler(statements as PreparedStatement[]) ?? [];
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

function reservationInput() {
  return {
    id: "IS-2",
    parentSessionId: "IS-1",
    rootSessionId: "IS-1",
    repo: "openclaw/crabfleet",
    branch: "main",
    runtime: "crabbox" as const,
    adapterName: "runtime-adapter",
    profile: "default",
    adapterWorkspaceId: "workspace-2",
    adapterControlPlane: "https://adapter.example.test/",
    requestedCapabilities: containerCapabilities,
    adapterSettings: {
      ttlSeconds: 14_400,
      idleTimeoutSeconds: 1_800,
      capabilities: containerCapabilities,
    },
    adapterCreatePayloadJson: '{"id":"workspace-2"}',
    preparationReservation: true,
    openClawRequestId: "request-1",
    openClawRequestHash: "hash-1",
    command: "codex --yolo",
    prompt: "fix the issue",
    purpose: "fix the issue",
    summary: "starting",
    owner: "maintainer",
    createdBy: "service:openclaw",
    initialLeaseId: "sandbox:lease",
    initialAgentTokenHash: "agent-hash",
    now: 100,
  };
}

test("session reservation rows centralize preparation, replay, and lease ownership", () => {
  const prepared = buildInteractiveSessionReservationValues(reservationInput());
  assert.equal(prepared.adapter, null);
  assert.equal(prepared.adapter_create_pending, 0);
  assert.equal(prepared.preparation_pending, 1);
  assert.equal(prepared.last_reconciled_at, null);
  assert.equal(prepared.reconcile_error, null);
  assert.equal(prepared.adapter_control_plane, "https://adapter.example.test/");
  assert.equal(prepared.openclaw_request_id, "request-1");
  assert.equal(prepared.openclaw_request_hash, "hash-1");
  assert.equal(prepared.lease_id, "sandbox:lease");
  assert.equal(prepared.agent_token_hash, "agent-hash");

  const immediate = buildInteractiveSessionReservationValues({
    ...reservationInput(),
    preparationReservation: false,
  });
  assert.equal(immediate.adapter, "runtime-adapter");
  assert.equal(immediate.adapter_create_pending, 1);
  assert.equal(immediate.preparation_pending, 0);
  assert.equal(immediate.last_reconciled_at, 100);
  assert.equal(immediate.reconcile_error, "runtime adapter create pending");
});

test("visible session reads exclude preparation reservations and stay bounded", async () => {
  const row = sessionRow({ id: "IS-2", preparation_pending: 0 });
  let calls = 0;
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    calls += 1;
    assert.match(sql, /from "interactive_sessions"/i);
    assert.match(sql, /"preparation_pending" =/i);
    if (/"id" =/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-2", 0]);
    } else {
      assert.match(sql, /order by "updated_at" desc/i);
      assert.match(sql, /limit/i);
      assert.deepEqual(parameters, [0, 12]);
    }
    return { results: [row] };
  });

  assert.equal((await readVisibleInteractiveSessionRow(env, "IS-2"))?.id, "IS-2");
  assert.deepEqual(
    (await readVisibleInteractiveSessionRows(env, 12)).map((session) => session.id),
    ["IS-2"],
  );
  assert.equal(calls, 2);
});

test("agent credential reads require visible sessions and preserve token hashes", async () => {
  const row = sessionRow({
    id: "IS-2",
    preparation_pending: 0,
    agent_token_hash: "agent-hash",
  });
  let query = 0;
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    assert.match(sql, /from "interactive_sessions"/i);
    assert.match(sql, /"preparation_pending" =/i);
    assert.deepEqual(parameters, [query === 0 ? "IS-2" : "IS-3", 0]);
    query += 1;
    return query === 1 ? { results: [row] } : { results: [] };
  });

  const credential = await readAgentSessionCredential(env, "IS-2");
  assert.equal(credential?.session.id, "IS-2");
  assert.deepEqual(credential?.session.logs, []);
  assert.equal(credential?.tokenHash, "agent-hash");
  assert.equal(await readAgentSessionCredential(env, "IS-3"), null);
});

test("shared session credentials preserve private rows for signed embeds", async () => {
  const row = sessionRow({
    id: "IS-2",
    preparation_pending: 0,
    share_token_hash: "hash",
  });
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    if (/from "interactive_sessions"/i.test(sql)) {
      assert.match(sql, /"preparation_pending" =/i);
      assert.deepEqual(parameters, ["IS-2", 0]);
      return { results: [row] };
    }
    if (/from interactive_session_events/i.test(sql)) return { results: [] };
    if (/from "interactive_session_log_archives"/i.test(sql)) return { results: [] };
    throw new Error(`unexpected query: ${sql}`);
  });

  const credential = await readInteractiveSessionShareCredential(env, "IS-2");
  assert.equal(credential?.session.id, "IS-2");
  assert.equal(credential?.session.shareMode, "private");
  assert.equal(credential?.tokenHash, "hash");
});

test("session aggregates combine rows, recent logs, and archive metadata", async () => {
  const row = sessionRow({ id: "IS-2", preparation_pending: 0 });
  const archive = {
    session_id: "IS-2",
    event_count: 1,
    events_key: "events.json",
    transcript_key: "transcript.md",
    summary_key: "summary.json",
    archived_at: 100,
    updated_at: 110,
    session_updated_at: 105,
  };
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    if (/from "interactive_sessions"/i.test(sql)) {
      return { results: [row] };
    }
    if (/from interactive_session_events/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-2"]);
      return {
        results: [{ session_id: "IS-2", message: "ready", created_at: 1000 }],
      };
    }
    if (/from "interactive_session_log_archives"/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-2"]);
      return { results: [archive] };
    }
    throw new Error(`unexpected query: ${sql}`);
  });

  const record = await readInteractiveSessionRecord(env, "IS-2");
  assert.equal(record?.id, "IS-2");
  assert.match(record?.logs[0] ?? "", /ready$/);
  assert.equal(record?.logArchive?.transcriptKey, "transcript.md");

  const records = await readInteractiveSessionRecords(env, 1);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.id, "IS-2");
  assert.match(records[0]?.logs[0] ?? "", /ready$/);
  assert.equal(records[0]?.logArchive?.eventCount, 1);
});

test("session log reads keep the newest bounded window in chronological order", async () => {
  let queries = 0;
  const logs = await readInteractiveSessionLogs(
    runtimeEnv((sql, parameters, kind) => {
      assert.equal(kind, "all");
      queries += 1;
      assert.match(sql, /row_number\(\) over/i);
      assert.match(sql, /rank <= 80/i);
      assert.match(sql, /order by session_id asc, created_at asc, id asc/i);
      assert.deepEqual(parameters, ["IS-2", "IS-3"]);
      return {
        results: [
          { session_id: "IS-2", message: "requested", created_at: 0 },
          { session_id: "IS-2", message: "ready", created_at: 1000 },
          { session_id: "IS-3", message: "requested", created_at: 2000 },
        ],
      };
    }),
    ["IS-2", "IS-2", "", "IS-3"],
  );

  assert.equal(queries, 1);
  assert.equal(logs.get("IS-2")?.length, 2);
  assert.match(logs.get("IS-2")?.[0] ?? "", /requested$/);
  assert.match(logs.get("IS-2")?.[1] ?? "", /ready$/);
  assert.match(logs.get("IS-3")?.[0] ?? "", /requested$/);
  assert.deepEqual(
    await readInteractiveSessionLogs(
      runtimeEnv(() => ({})),
      [],
    ),
    new Map(),
  );
});

test("session archive reads map persistence rows by session", async () => {
  const archives = await readInteractiveSessionLogArchives(
    runtimeEnv((sql, parameters, kind) => {
      assert.equal(kind, "all");
      assert.match(sql, /from "interactive_session_log_archives"/i);
      assert.deepEqual(parameters, ["IS-2"]);
      return {
        results: [
          {
            session_id: "IS-2",
            event_count: 3,
            events_key: "events.json",
            transcript_key: "transcript.md",
            summary_key: "summary.json",
            archived_at: 100,
            updated_at: 110,
            session_updated_at: 105,
          },
        ],
      };
    }),
    ["IS-2", "IS-2"],
  );

  assert.deepEqual(archives.get("IS-2"), {
    sessionId: "IS-2",
    eventCount: 3,
    eventsKey: "events.json",
    transcriptKey: "transcript.md",
    summaryKey: "summary.json",
    archivedAt: 100,
    updatedAt: 110,
  });
});

test("session event reads clamp newest windows and restore chronological order", async () => {
  const rows = [
    { id: 3, session_id: "IS-2", actor: "agent", message: "third", created_at: 30 },
    { id: 2, session_id: "IS-2", actor: "agent", message: "second", created_at: 20 },
  ];
  const events = await readInteractiveSessionEventRows(
    runtimeEnv((sql, parameters, kind) => {
      assert.equal(kind, "all");
      assert.match(sql, /order by "created_at" desc, "id" desc/i);
      assert.match(sql, /limit/i);
      assert.deepEqual(parameters, ["IS-2", 10000]);
      return { results: rows };
    }),
    "IS-2",
    { limit: 50_000, newest: true },
  );

  assert.deepEqual(
    events.map((event) => event.id),
    [2, 3],
  );
});

test("session event counts normalize missing and persisted values", async () => {
  assert.equal(
    await countInteractiveSessionEvents(
      runtimeEnv((sql, parameters, kind) => {
        assert.equal(kind, "all");
        assert.match(sql, /count\(\*\)/i);
        assert.deepEqual(parameters, ["IS-2"]);
        return { results: [{ count: 7 }] };
      }),
      "IS-2",
    ),
    7,
  );
  assert.equal(
    await countInteractiveSessionEvents(
      runtimeEnv(() => ({ results: [] })),
      "IS-3",
    ),
    0,
  );
});

test("session event mutations persist events before fenced snapshot-invalidating updates", async () => {
  let batch: PreparedStatement[] = [];
  const updated = await persistInteractiveSessionEventMutation(
    runtimeEnv(
      () => {
        throw new Error("metadata mutation must execute as one batch");
      },
      (statements) => {
        batch = statements;
        return [{ results: [] }, { results: [{ updated_at: 101 }] }];
      },
    ),
    { id: "IS-2", status: "ready", updatedAt: 100 },
    "operator",
    " summary updated ",
    { summary: "done" },
    90,
  );

  assert.equal(updated, true);
  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /^\s*insert into interactive_session_events/i);
  assert.deepEqual(batch[0]?.parameters, [
    "IS-2",
    "operator",
    "summary updated",
    90,
    "IS-2",
    "ready",
    100,
  ]);
  assert.match(batch[1]?.sql ?? "", /^update "interactive_sessions"/i);
  assert.match(batch[1]?.sql ?? "", /terminal_finalize_pending/i);
  assert.match(batch[1]?.sql ?? "", /when status in \('stopped', 'expired', 'failed'\) then 1/i);
  assert.match(batch[1]?.sql ?? "", /returning "updated_at"/i);
  assert.ok(batch[1]?.parameters.includes("done"));
  assert.ok(batch[1]?.parameters.includes(101));
  assert.ok(batch[1]?.parameters.includes("IS-2"));
  assert.ok(batch[1]?.parameters.includes("ready"));
  assert.ok(batch[1]?.parameters.includes(100));
});

test("session event mutations report lost revision ownership", async () => {
  assert.equal(
    await persistInteractiveSessionEventMutation(
      runtimeEnv(
        () => {
          throw new Error("metadata mutation must execute as one batch");
        },
        () => [{ results: [] }, { results: [] }],
      ),
      { id: "IS-2", status: "ready", updatedAt: 100 },
      "operator",
      "summary updated",
      { summary: "done" },
      101,
    ),
    false,
  );
});

test("GitHub Actions stop persistence clears terminal authority and workflow state", async () => {
  let batch: PreparedStatement[] = [];
  const stopped = await persistGitHubActionsSessionStop(
    runtimeEnv(
      () => {
        throw new Error("GitHub Actions stop must execute as one batch");
      },
      (statements) => {
        batch = statements;
        return [{ results: [] }, { results: [{ updated_at: 101 }] }];
      },
    ),
    { id: "IS-2", status: "ready", updatedAt: 100 },
    "operator",
    "github_actions",
    90,
  );

  assert.equal(stopped, true);
  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /insert into interactive_session_events/i);
  assert.ok(
    batch[0]?.parameters.some(
      (parameter) =>
        typeof parameter === "string" && parameter.includes("workflow run not canceled"),
    ),
  );
  assert.match(batch[1]?.sql ?? "", /^update "interactive_sessions"/i);
  assert.match(batch[1]?.sql ?? "", /"work_state"/i);
  assert.match(batch[1]?.sql ?? "", /"work_phase"/i);
  assert.match(batch[1]?.sql ?? "", /"terminal_finalize_pending"/i);
  assert.ok(batch[1]?.parameters.includes("session_ended"));
});

test("stop persistence reports lost ownership", async () => {
  const env = runtimeEnv(
    () => {
      throw new Error("stop persistence must execute as one batch");
    },
    () => [{ results: [] }, { results: [] }],
  );
  assert.equal(
    await persistGitHubActionsSessionStop(
      env,
      { id: "IS-2", status: "ready", updatedAt: 100 },
      "operator",
      "github_actions",
      101,
    ),
    false,
  );
});

test("stop-state lookups stay fenced to stopping sessions and adapter ownership", async () => {
  const env = runtimeEnv((sql, parameters, kind) => {
    assert.equal(kind, "all");
    if (/credential_cleanup_terminal_status/i.test(sql)) {
      assert.deepEqual(parameters, ["IS-2", "stopping"]);
      return { results: [{ credential_cleanup_terminal_status: "stopped" }] };
    }
    assert.match(sql, /adapter_create_pending/i);
    assert.deepEqual(parameters, ["IS-2", "runtime-v1", "workspace-2", "stopping"]);
    return { results: [{ adapter_create_pending: 1 }] };
  });

  assert.equal(await readInteractiveSessionTerminalCleanupIntent(env, "IS-2"), true);
  assert.equal(
    await readRuntimeAdapterCreatePending(env, "IS-2", "runtime-v1", "workspace-2"),
    true,
  );
});

test("session reservation inserts preparation and request identity in one batch", async () => {
  let batch: PreparedStatement[] = [];
  const values = sessionRow({
    id: "IS-2",
    preparation_pending: 1,
    openclaw_request_id: "request-1",
    openclaw_request_hash: "hash-1",
  });
  await insertInteractiveSessionReservation(
    runtimeEnv(
      () => {
        throw new Error("batched inserts must not execute individually");
      },
      (statements) => {
        batch = statements;
      },
    ),
    values,
    {
      requestId: "request-1",
      requestHash: "hash-1",
      sessionId: "IS-2",
      createdAt: 100,
    },
  );

  assert.equal(batch.length, 2);
  assert.match(batch[0]?.sql ?? "", /^insert into "openclaw_request_replays"/i);
  assert.deepEqual(batch[0]?.parameters, ["request-1", "hash-1", "IS-2", 100, 100]);
  assert.match(batch[1]?.sql ?? "", /^insert into "interactive_sessions"/i);
  assert.match(batch[1]?.sql ?? "", /"preparation_pending"/i);
  assert.match(batch[1]?.sql ?? "", /"openclaw_request_id"/i);
  assert.match(batch[1]?.sql ?? "", /"openclaw_request_hash"/i);
  assert.ok(batch[1]?.parameters.includes(1));
  assert.ok(batch[1]?.parameters.includes("request-1"));
  assert.ok(batch[1]?.parameters.includes("hash-1"));
});

test("session reservations without request identity use one insert", async () => {
  let inserts = 0;
  await insertInteractiveSessionReservation(
    runtimeEnv((sql, _parameters, kind) => {
      assert.equal(kind, "run");
      assert.match(sql, /^insert into "interactive_sessions"/i);
      inserts += 1;
      return { changes: 1 };
    }),
    sessionRow({ id: "IS-2" }),
    null,
  );
  assert.equal(inserts, 1);
});

test("terminal provision results atomically enter durable finalization", async () => {
  let updateSql = "";
  const result = await persistInteractiveSessionProvisionResult(
    runtimeEnv((sql, parameters, kind) => {
      assert.equal(kind, "run");
      updateSql = sql;
      assert.ok(parameters.includes("IS-2"));
      assert.ok(parameters.includes("agent-hash"));
      return { changes: 1 };
    }),
    {
      sessionId: "IS-2",
      insertedAt: 100,
      profile: "default",
      requestedCapabilities: containerCapabilities,
      initialLeaseId: "sandbox:lease",
      initialAgentTokenHash: "agent-hash",
      adapterName: "runtime-adapter",
    },
    {
      status: "failed",
      leaseId: "provider-lease",
      attachUrl: "wss://terminal.example.test",
      vncUrl: "https://desktop.example.test",
      message: "provider failed",
      adapter: "runtime-adapter",
      adapterWorkspaceId: "workspace-2",
      reconciledAt: 150,
      createPending: true,
    },
  );

  assert.deepEqual(result, {
    updated: true,
    terminalStatus: "failed",
    terminalAt: 150,
  });
  assert.match(updateSql, /"terminal_finalize_pending"/i);
  assert.match(updateSql, /"stopped_at"/i);
  assert.match(updateSql, /"agent_token_hash"/i);
  assert.match(updateSql, /MAX\(updated_at \+ 1/i);
  assert.match(updateSql, /lease_id IS/i);
  assert.match(updateSql, /"sandbox_refresh_sandbox_id" is null/i);
  assert.match(updateSql, /"sandbox_refresh_claim" is null/i);
  assert.match(updateSql, /"sandbox_refresh_claim_expires_at" is null/i);
});

test("missing provision adapters persist the fenced pending state", async () => {
  let updateSql = "";
  await markInteractiveSessionPendingAdapter(
    runtimeEnv((sql, parameters, kind) => {
      assert.equal(kind, "run");
      updateSql = sql;
      assert.ok(parameters.includes("IS-2"));
      assert.ok(parameters.includes("agent-hash"));
      assert.ok(parameters.includes(null));
      return { changes: 1 };
    }),
    {
      sessionId: "IS-2",
      insertedAt: 100,
      initialLeaseId: null,
      initialAgentTokenHash: "agent-hash",
    },
  );
  assert.match(updateSql, /"status" =/i);
  assert.match(updateSql, /"last_event" =/i);
  assert.match(updateSql, /MAX\(updated_at \+ 1/i);
  assert.match(updateSql, /lease_id IS/i);
});
