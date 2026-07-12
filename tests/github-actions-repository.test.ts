import assert from "node:assert/strict";
import test from "node:test";

import {
  buildGitHubActionsSessionValues,
  type GitHubActionsSessionRegistrationUpdate,
} from "../src/worker/github-actions-session-registration.ts";
import { GitHubActionsRepository } from "../src/worker/github-actions-repository.ts";
import type { GitHubActionsRunnerConnectionUpdate } from "../src/worker/github-actions-runner-connection.ts";
import type { GitHubActionsWorkStateUpdate } from "../src/worker/github-actions-session-work-state.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { sessionRow } from "./helpers/session-row.ts";

type Execution = {
  sql: string;
  parameters: unknown[];
  kind: "all" | "run";
};

function runtimeEnv(executions: Execution[], mutationChanges = 1): RuntimeEnv {
  const row = sessionRow({
    id: "IS-101",
    runtime: "github_actions",
    work_key: "issue:101",
  });
  return {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                executions.push({ sql, parameters, kind: "all" });
                return { results: [row], meta: { changes: 1 } };
              },
              async run() {
                executions.push({ sql, parameters, kind: "run" });
                return { meta: { changes: mutationChanges } };
              },
            };
          },
        };
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("GitHub Actions repository owns registration and lifecycle SQL", async () => {
  const executions: Execution[] = [];
  const repository = new GitHubActionsRepository(runtimeEnv(executions));

  assert.equal((await repository.readByWorkKey("issue:101"))?.id, "IS-101");
  assert.equal((await repository.readById("IS-101"))?.work_key, "issue:101");
  await repository.insertSession(
    buildGitHubActionsSessionValues({
      id: "IS-102",
      workKey: "issue:102",
      workKind: "issue",
      repo: "openclaw/crabfleet",
      branch: "main",
      sourceUrl: null,
      runUrl: null,
      purpose: "fix issue",
      summary: "starting",
      owner: "operator",
      ownerSubject: "github:42",
      agentTokenHash: "agent-hash",
      now: 100,
    }),
  );
  await repository.updateSession("IS-101", registrationUpdate, registrationExpectation);
  await repository.updateSession("IS-101", workStateUpdate, undefined, "attached");
  await repository.updateSession("IS-101", runnerConnectionUpdate);

  assert.equal(executions.length, 6);
  assert.match(executions[0].sql, /select .* from "interactive_sessions"/i);
  assert.match(executions[0].sql, /"work_key" = \?/i);
  assert.ok(executions[0].parameters.includes("issue:101"));
  assert.match(executions[1].sql, /"id" = \?/i);
  assert.ok(executions[1].parameters.includes("IS-101"));
  assert.match(executions[2].sql, /insert into "interactive_sessions"/i);
  assert.ok(executions[2].parameters.includes("issue:102"));
  assert.match(executions[3].sql, /"terminal_finalize_pending" = \?/i);
  assert.match(executions[4].sql, /"completion_reason" = \?/i);
  assert.match(executions[5].sql, /"last_heartbeat_at" = \?/i);
  for (const execution of executions.slice(3)) {
    assert.match(execution.sql, /update "interactive_sessions"/i);
    assert.match(execution.sql, /where "id" = \?/i);
    assert.match(execution.sql, /"runtime" = \?/i);
    assert.ok(execution.parameters.includes("IS-101"));
  }
  assert.match(executions[3].sql, /"updated_at" = \?/i);
  assert.match(executions[3].sql, /"status" = \?/i);
  assert.match(executions[3].sql, /"work_state" = \?/i);
  assert.match(executions[3].sql, /"work_phase" = \?/i);
  assert.match(executions[4].sql, /"updated_at" <= \?/i);
  assert.match(executions[4].sql, /"status" = \?/i);
  assert.match(executions[4].sql, /"status" not in/i);
  assert.ok(executions[4].parameters.includes("attached"));
  assert.ok(executions[4].parameters.includes("expired"));
  assert.match(executions[5].sql, /"updated_at" <= \?/i);
  assert.match(executions[3].sql, /"owner_subject" = \?/i);
  assert.doesNotMatch(executions[3].sql, /"work_state" not in/i);
  assert.match(executions[4].sql, /"work_state" not in/i);
  assert.ok(executions[4].parameters.includes("blocked"));
  assert.match(executions[5].sql, /"status" not in/i);
  assert.ok(executions[5].parameters.includes("blocked"));
});

test("GitHub Actions repository rejects stale or invalid state transitions", async () => {
  const executions: Execution[] = [];
  const repository = new GitHubActionsRepository(runtimeEnv(executions, 0));

  await assert.rejects(repository.updateSession("IS-101", runnerConnectionUpdate), (error) => {
    assert.equal(
      typeof error === "object" && error && "status" in error ? error.status : undefined,
      409,
    );
    return true;
  });
  assert.equal(executions.length, 1);
});

test("terminal work-state updates require an observed non-terminal status", async () => {
  const executions: Execution[] = [];
  const repository = new GitHubActionsRepository(runtimeEnv(executions));

  await assert.rejects(
    repository.updateSession("IS-101", {
      ...workStateUpdate,
      status: "stopped",
      work_state: "completed",
      stopped_at: 200,
    }),
    {
      message: "terminal GitHub Actions update requires expected session status",
    },
  );
  assert.equal(executions.length, 0);
});

const registrationUpdate: GitHubActionsSessionRegistrationUpdate = {
  owner: "operator@example.test",
  owner_subject: "github:42",
  repo: "openclaw/crabfleet",
  branch: "main",
  purpose: "fix issue",
  summary: "starting",
  prompt: "fix issue",
  status: "ready",
  lease_id: null,
  stopped_at: null,
  terminal_status: null,
  terminal_failure_reason: null,
  terminal_finalize_pending: 0,
  credential_cleanup_terminal_status: null,
  updated_at: 100,
  last_seen_at: 100,
  last_event: "GitHub Actions work registered",
  agent_token_hash: "agent-hash",
  work_kind: "issue",
  work_state: "registered",
  work_phase: "waiting_for_runner",
  source_url: null,
  github_run_url: null,
  last_heartbeat_at: null,
  completion_reason: null,
};

const registrationExpectation = {
  updated_at: 90,
  status: "stopped",
  work_state: "completed",
  work_phase: "finished",
} as const;

const workStateUpdate: GitHubActionsWorkStateUpdate = {
  status: "attached",
  summary: "working",
  work_state: "running",
  work_phase: "tests",
  codex_thread_id: "thread-1",
  codex_turn_id: "turn-1",
  last_heartbeat_at: 200,
  completion_reason: null,
  last_event: "running: tests",
  last_seen_at: 200,
  updated_at: 200,
  stopped_at: null,
};

const runnerConnectionUpdate: GitHubActionsRunnerConnectionUpdate = {
  status: "ready",
  work_state: "running",
  work_phase: "runner_connected",
  last_heartbeat_at: 300,
  last_seen_at: 300,
  updated_at: 300,
  last_event: "GitHub Actions runner connected",
};
