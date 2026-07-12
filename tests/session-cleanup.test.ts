import assert from "node:assert/strict";
import test from "node:test";

import type { InteractiveSessionLogArchiveTable } from "../src/worker/database.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  deleteFinalizedInteractiveSession,
  InteractiveSessionCleanupService,
  readInteractiveSessionCleanupCandidates,
  type InteractiveSessionCleanupCandidate,
} from "../src/worker/session-cleanup.ts";
import { sessionRow } from "./helpers/session-row.ts";

type D1Result = { results?: unknown[]; changes?: number };
type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result,
  batchHandler: (statements: PreparedStatement[]) => void = () => undefined,
  sessionLogs = false,
): RuntimeEnv {
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
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
          },
        };
      },
      async batch(statements: unknown[]) {
        batchHandler(statements as PreparedStatement[]);
        return [];
      },
    } as unknown as D1Database,
    ...(sessionLogs ? { SESSION_LOGS: {} as R2Bucket } : {}),
  } as RuntimeEnv;
}

function archive(
  values: Partial<InteractiveSessionLogArchiveTable> = {},
): InteractiveSessionLogArchiveTable {
  return {
    session_id: "IS-1",
    event_count: 3,
    session_updated_at: 100,
    events_key: "events.ndjson",
    transcript_key: "transcript.md",
    summary_key: "summary.json",
    archived_at: 110,
    updated_at: 110,
    ...values,
  };
}

test("cleanup service authorizes before deletion and removes archive objects afterward", async () => {
  const candidates: InteractiveSessionCleanupCandidate[] = [
    { row: sessionRow({ id: "IS-1", status: "stopped" }), archive: archive() },
    { row: sessionRow({ id: "IS-2", status: "failed" }), archive: archive({ session_id: "IS-2" }) },
    {
      row: sessionRow({ id: "IS-3", status: "expired" }),
      archive: archive({ session_id: "IS-3" }),
    },
  ];
  const deleted: string[] = [];
  const cleaned: string[] = [];
  const failures: string[] = [];
  const service = new InteractiveSessionCleanupService({
    async readCandidates(ids) {
      assert.deepEqual(ids, ["IS-1", "IS-2", "IS-3"]);
      return candidates;
    },
    async deleteCandidate(candidate) {
      deleted.push(candidate.row.id);
      return candidate.row.id !== "IS-3";
    },
    async cleanupArchive(candidateArchive) {
      cleaned.push(candidateArchive?.session_id ?? "none");
      throw new Error("R2 unavailable");
    },
    reportArchiveCleanupFailure(sessionId) {
      failures.push(sessionId);
    },
  });

  assert.deepEqual(await service.cleanup(["IS-1", "IS-2", "IS-3"], (row) => row.id !== "IS-2"), [
    "IS-1",
  ]);
  assert.deepEqual(deleted, ["IS-1", "IS-3"]);
  assert.deepEqual(cleaned, ["IS-1"]);
  assert.deepEqual(failures, ["IS-1"]);
});

test("cleanup candidates require finalized archives, no credentials, and no active descendants", async () => {
  const row = sessionRow({ id: "IS-1", status: "stopped", updated_at: 100 });
  const logArchive = archive();
  let sessionReads = 0;
  const env = runtimeEnv(
    (sql, parameters, kind) => {
      assert.equal(kind, "all");
      if (/from "interactive_sessions"/i.test(sql)) {
        sessionReads += 1;
        assert.match(sql, /"terminal_finalize_pending" =/i);
        assert.match(sql, /interactive_session_credential_policies/i);
        assert.match(sql, /interactive_session_credential_policy_registrations/i);
        assert.match(sql, /WITH RECURSIVE active_ancestor\(id\)/i);
        assert.match(sql, /archive\.session_updated_at = interactive_sessions\.updated_at/i);
        assert.match(sql, /events_key IS NOT NULL/i);
        assert.match(sql, /count\(\*\)/i);
        assert.match(sql, /"id" in/i);
        assert.ok(parameters.includes("IS-1"));
        return { results: [row] };
      }
      if (/from "interactive_session_log_archives"/i.test(sql)) {
        assert.deepEqual(parameters, ["IS-1"]);
        return { results: [logArchive] };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
    undefined,
    true,
  );

  assert.deepEqual(await readInteractiveSessionCleanupCandidates(env, ["IS-1"]), [
    { row, archive: logArchive },
  ]);
  assert.equal(sessionReads, 1);
});

test("finalized deletion claims and removes events, archive metadata, and session atomically", async () => {
  const row = sessionRow({ id: "IS-1", status: "stopped", updated_at: 100 });
  const logArchive = archive();
  let batch: PreparedStatement[] = [];
  const env = runtimeEnv(
    (sql, parameters, kind) => {
      assert.equal(kind, "all");
      assert.match(sql, /from "interactive_sessions"/i);
      assert.deepEqual(parameters, ["IS-1"]);
      return { results: [] };
    },
    (statements) => {
      batch = statements;
    },
    true,
  );

  assert.equal(await deleteFinalizedInteractiveSession(env, row, logArchive), true);
  assert.equal(batch.length, 5);
  assert.match(batch[0]?.sql ?? "", /update "interactive_sessions"/i);
  assert.match(batch[0]?.sql ?? "", /interactive_session_credential_policies/i);
  assert.match(batch[0]?.sql ?? "", /interactive_session_credential_policy_registrations/i);
  assert.match(batch[0]?.sql ?? "", /WITH RECURSIVE active_ancestor\(id\)/i);
  assert.match(batch[0]?.sql ?? "", /event_count =/i);
  assert.match(batch[0]?.sql ?? "", /events_key IS/i);
  assert.match(batch[0]?.sql ?? "", /count\(\*\)/i);
  assert.match(batch[1]?.sql ?? "", /delete from "interactive_session_events"/i);
  assert.match(batch[2]?.sql ?? "", /delete from "interactive_session_log_archives"/i);
  assert.match(batch[3]?.sql ?? "", /delete from "interactive_session_grants"/i);
  assert.match(batch[4]?.sql ?? "", /delete from "interactive_sessions"/i);
  const claimToken = batch[0]?.parameters.find(
    (parameter): parameter is string =>
      typeof parameter === "string" && parameter.startsWith("cleanup:"),
  );
  assert.ok(claimToken);
  assert.ok(batch[1]?.parameters.includes(claimToken));
  assert.ok(batch[2]?.parameters.includes(claimToken));
  assert.ok(batch[3]?.parameters.includes(claimToken));
  assert.ok(batch[4]?.parameters.includes(claimToken));
  assert.ok(batch[4]?.parameters.includes(2));
});
