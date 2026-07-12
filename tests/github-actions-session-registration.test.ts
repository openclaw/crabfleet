import assert from "node:assert/strict";
import test from "node:test";

import { githubActionsCapabilities } from "../src/github-actions-runtime.ts";
import type { InteractiveSessionRow, InteractiveSessionTable } from "../src/worker/database.ts";
import {
  GitHubActionsSessionRegistrationService,
  actionWorkIdentifier,
  buildGitHubActionsSessionValues,
  optionalHttpUrl,
  type GitHubActionsSessionRegistrationExpectation,
  type GitHubActionsSessionRegistrationStore,
  type GitHubActionsSessionRegistrationUpdate,
} from "../src/worker/github-actions-session-registration.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type StoreState = {
  rows: Map<string, InteractiveSessionRow>;
  workKeyReads: number;
  inserted: InteractiveSessionTable[];
  updates: Array<{
    id: string;
    values: GitHubActionsSessionRegistrationUpdate;
    expected: GitHubActionsSessionRegistrationExpectation;
  }>;
  events: string[];
  audits: string[];
  operations: string[];
  insertError: unknown;
  disconnectError: unknown;
  concurrentRow: InteractiveSessionRow | null;
};

function registrationStore(initialRows: InteractiveSessionRow[] = []): {
  store: GitHubActionsSessionRegistrationStore;
  state: StoreState;
} {
  const state: StoreState = {
    rows: new Map(initialRows.map((row) => [row.id, row])),
    workKeyReads: 0,
    inserted: [],
    updates: [],
    events: [],
    audits: [],
    operations: [],
    insertError: null,
    disconnectError: null,
    concurrentRow: null,
  };
  const store: GitHubActionsSessionRegistrationStore = {
    now: () => 100,
    newAgentToken: () => "agent-token",
    hashToken: async () => "agent-token-hash",
    requireRepo: async (repo) => {
      state.operations.push(`repo:${repo}`);
    },
    resolvePrincipal: async (value) =>
      value === "operator@example.test"
        ? { subject: "github:42", principal: "operator@example.test", actor: "operator" }
        : value === "other@example.test"
          ? { subject: "github:99", principal: "other@example.test", actor: "other" }
          : null,
    readByWorkKey: async (workKey) => {
      state.workKeyReads += 1;
      if (state.concurrentRow && state.workKeyReads > 1) {
        state.rows.set(state.concurrentRow.id, state.concurrentRow);
        return state.concurrentRow;
      }
      return [...state.rows.values()].find((row) => row.work_key === workKey) ?? null;
    },
    nextSessionId: async () => `IS-${state.inserted.length + 101}`,
    insertSession: async (values) => {
      state.operations.push("insert");
      if (state.insertError) throw state.insertError;
      state.inserted.push(values as InteractiveSessionTable);
      const row = sessionRow(values as Partial<InteractiveSessionRow>);
      state.rows.set(row.id, row);
    },
    readById: async (id) => state.rows.get(id) ?? null,
    updateSession: async (id, values, expected) => {
      state.operations.push("update");
      state.updates.push({ id, values, expected });
      const row = state.rows.get(id);
      if (row) state.rows.set(id, { ...row, ...values });
    },
    isConstraintError: (error) => error === state.insertError,
    disconnectRunner: async () => {
      state.operations.push("disconnect");
      if (state.disconnectError) throw state.disconnectError;
    },
    appendEvent: async (_id, message) => {
      state.operations.push("event");
      state.events.push(message);
    },
    audit: async (message) => {
      state.operations.push("audit");
      state.audits.push(message);
    },
    readSession: async (id) => {
      state.operations.push("read");
      const row = state.rows.get(id);
      return row ? interactiveSession(row, []) : null;
    },
  };
  return { store, state };
}

test("GitHub Actions registration validators accept only bounded canonical input", () => {
  assert.equal(actionWorkIdentifier(" issue:123 ", "workKey", 20), "issue:123");
  assert.equal(optionalHttpUrl("https://example.test/run", "runUrl"), "https://example.test/run");
  assert.equal(optionalHttpUrl("", "runUrl"), null);
  assert.throws(() => actionWorkIdentifier("", "workKey", 20), {
    message: "workKey is required",
  });
  assert.throws(() => actionWorkIdentifier("invalid value", "workKey", 20), {
    message: "workKey contains unsupported characters",
  });
  assert.throws(() => optionalHttpUrl("file:///tmp/run", "runUrl"), {
    message: "runUrl must be an http(s) URL",
  });
});

test("GitHub Actions rows centralize session defaults and scoped ownership", () => {
  const values = buildGitHubActionsSessionValues({
    id: "IS-123",
    workKey: "issue:123",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    branch: "main",
    sourceUrl: "https://example.test/issues/123",
    runUrl: null,
    purpose: "fix issue",
    summary: "starting",
    owner: "operator",
    ownerSubject: "github:42",
    agentTokenHash: "agent-hash",
    now: 100,
  });
  assert.equal(values.runtime, "github_actions");
  assert.equal(values.owner, "operator");
  assert.equal(values.owner_subject, "github:42");
  assert.equal(values.root_session_id, "IS-123");
  assert.equal(values.agent_token_hash, "agent-hash");
  assert.equal(values.work_state, "registered");
  assert.equal(values.work_phase, "waiting_for_runner");
  assert.deepEqual(JSON.parse(values.capabilities_json), githubActionsCapabilities);
});

test("new GitHub Actions work registers, rotates credentials, and records evidence", async () => {
  const { store, state } = registrationStore();
  const result = await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:123",
    workKind: "issue_fix",
    repo: "OpenClaw/CrabFleet",
    sourceUrl: "https://example.test/issues/123",
    owner: "operator@example.test",
  });

  assert.equal(result.session.id, "IS-101");
  assert.equal(result.agentToken, "agent-token");
  assert.equal(result.resumed, false);
  assert.equal(state.inserted[0]?.repo, "openclaw/crabfleet");
  assert.equal(state.inserted[0]?.purpose, "issue fix in openclaw/crabfleet@main");
  assert.equal(state.updates[0]?.values.agent_token_hash, "agent-token-hash");
  assert.deepEqual(state.events, ["GitHub Actions work registered"]);
  assert.deepEqual(state.audits, ["openclaw action session registered IS-101 work=issue:123"]);
  assert.deepEqual(state.operations, [
    "repo:openclaw/crabfleet",
    "insert",
    "update",
    "disconnect",
    "event",
    "audit",
    "read",
  ]);
});

test("GitHub Actions registration requires and persists a stable owner", async () => {
  const missing = registrationStore();
  await assert.rejects(
    new GitHubActionsSessionRegistrationService(missing.store).register({
      workKey: "issue:private-missing",
      workKind: "issue",
      repo: "openclaw/crabfleet",
    }),
    { message: "owner is required for GitHub Actions work" },
  );

  const owned = registrationStore();
  const result = await new GitHubActionsSessionRegistrationService(owned.store).register({
    workKey: "issue:private-owned",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });
  assert.equal(result.session.owner, "operator");
  assert.equal(owned.state.inserted[0]?.owner_subject, "github:42");
  assert.equal(owned.state.updates[0]?.values.owner_subject, "github:42");
});

test("GitHub Actions work keys cannot transfer between tenant owners", async () => {
  const existing = sessionRow({
    id: "IS-owned",
    runtime: "github_actions",
    work_key: "issue:owned",
    owner: "operator@example.test",
    owner_subject: "github:42",
  });
  const { store } = registrationStore([existing]);
  await assert.rejects(
    new GitHubActionsSessionRegistrationService(store).register({
      workKey: "issue:owned",
      workKind: "issue",
      repo: "openclaw/crabfleet",
      owner: "other@example.test",
    }),
    { message: "workKey is already registered to a different owner" },
  );
});

test("GitHub Actions work keys cannot be resumed without proving the owner", async () => {
  const existing = sessionRow({
    id: "IS-owned",
    runtime: "github_actions",
    work_key: "issue:owned",
    owner: "operator@example.test",
    owner_subject: "github:42",
  });
  const { store, state } = registrationStore([existing]);

  await assert.rejects(
    new GitHubActionsSessionRegistrationService(store).register({
      workKey: "issue:owned",
      workKind: "issue",
      repo: "openclaw/crabfleet",
    }),
    { message: "owner is required for GitHub Actions work" },
  );
  assert.equal(state.updates.length, 0);
  assert.deepEqual(state.operations, ["repo:openclaw/crabfleet"]);
});

test("GitHub Actions work keys can be resumed by the matching owner", async () => {
  const existing = sessionRow({
    id: "IS-owned",
    runtime: "github_actions",
    work_key: "issue:owned",
    work_state: "completed",
    status: "stopped",
    owner: "operator",
    owner_subject: "github:42",
  });
  const { store, state } = registrationStore([existing]);

  const result = await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:owned",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });

  assert.equal(result.resumed, true);
  assert.equal(result.session.id, "IS-owned");
  assert.equal(state.updates[0]?.values.owner, "operator");
  assert.equal(state.updates[0]?.values.owner_subject, "github:42");
  assert.equal(state.updates[0]?.values.agent_token_hash, "agent-token-hash");
  assert.deepEqual(state.updates[0]?.expected, {
    agent_token_hash: existing.agent_token_hash,
    updated_at: existing.updated_at,
    status: existing.status,
    work_state: existing.work_state,
    work_phase: existing.work_phase,
  });
});

test("GitHub Actions rejects work keys without a stable owner", async () => {
  const subjectless = sessionRow({
    id: "IS-subjectless",
    runtime: "github_actions",
    work_key: "issue:subjectless",
    owner: "subjectless",
    owner_subject: "",
  });
  const { store, state } = registrationStore([subjectless]);

  await assert.rejects(
    new GitHubActionsSessionRegistrationService(store).register({
      workKey: "issue:subjectless",
      workKind: "issue",
      repo: "openclaw/crabfleet",
      owner: "operator@example.test",
    }),
    { message: "workKey is missing a stable owner; use a new workKey" },
  );
  assert.equal(state.updates.length, 0);
  assert.deepEqual(state.operations, ["repo:openclaw/crabfleet"]);
});

test("resumed work preserves omitted links and resets terminal state", async () => {
  const existing = sessionRow({
    id: "IS-200",
    runtime: "github_actions",
    work_key: "pull:200",
    work_kind: "pull_request",
    work_state: "completed",
    status: "stopped",
    source_url: "https://example.test/pull/200",
    github_run_url: "https://example.test/run/1",
    purpose: "existing purpose",
    summary: "existing summary",
  });
  const { store, state } = registrationStore([existing]);
  const result = await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "pull:200",
    workKind: "pull_request",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });

  assert.equal(result.resumed, true);
  assert.equal(state.inserted.length, 0);
  assert.equal(state.updates[0]?.values.source_url, existing.source_url);
  assert.equal(state.updates[0]?.values.github_run_url, existing.github_run_url);
  assert.equal(state.updates[0]?.values.status, "ready");
  assert.equal(state.updates[0]?.values.work_state, "registered");
  assert.equal(state.updates[0]?.values.terminal_finalize_pending, 0);
  assert.deepEqual(state.events, ["GitHub Actions work resumed"]);
});

test("stale runner disconnect failures do not suppress registration evidence", async () => {
  const { store, state } = registrationStore();
  state.disconnectError = new Error("runner already gone");

  await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:disconnect-race",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });

  assert.deepEqual(state.events, ["GitHub Actions work registered"]);
  assert.equal(state.audits.length, 1);
  assert.deepEqual(state.operations.slice(-4), ["disconnect", "event", "audit", "read"]);
});

test("registration adopts a concurrently inserted work key", async () => {
  const { store, state } = registrationStore();
  const constraint = new Error("unique constraint");
  state.insertError = constraint;
  state.concurrentRow = sessionRow({
    id: "IS-concurrent",
    runtime: "github_actions",
    work_key: "issue:race",
  });

  const result = await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:race",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });

  assert.equal(result.session.id, "IS-concurrent");
  assert.equal(state.workKeyReads, 2);
  assert.equal(state.updates[0]?.id, "IS-concurrent");
  assert.equal(state.updates[0]?.values.updated_at, 100);
  assert.equal(state.updates[0]?.expected.agent_token_hash, state.concurrentRow.agent_token_hash);
});

test("concurrent registration adoption rotates exactly one usable token", async () => {
  const existing = sessionRow({
    id: "IS-concurrent",
    runtime: "github_actions",
    work_key: "issue:race-cas",
    owner: "operator",
    owner_subject: "github:42",
    updated_at: 100,
  });
  const { store, state } = registrationStore([existing]);
  let tokenSequence = 0;
  let arrivals = 0;
  let releaseUpdates!: () => void;
  const updatesReady = new Promise<void>((resolve) => {
    releaseUpdates = resolve;
  });
  store.newAgentToken = () => `agent-token-${++tokenSequence}`;
  store.hashToken = async (token) => `${token}-hash`;
  store.updateSession = async (id, values, expected) => {
    arrivals += 1;
    if (arrivals === 2) releaseUpdates();
    await updatesReady;
    const current = state.rows.get(id);
    if (
      !current ||
      current.updated_at !== expected.updated_at ||
      current.agent_token_hash !== expected.agent_token_hash ||
      current.status !== expected.status ||
      current.work_state !== expected.work_state ||
      current.work_phase !== expected.work_phase
    ) {
      throw new Error("GitHub Actions session changed; retry");
    }
    state.rows.set(id, { ...current, ...values });
  };

  const input = {
    workKey: "issue:race-cas",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  };
  const results = await Promise.allSettled([
    new GitHubActionsSessionRegistrationService(store).register(input),
    new GitHubActionsSessionRegistrationService(store).register(input),
  ]);

  const fulfilled = results.filter(
    (
      result,
    ): result is PromiseFulfilledResult<
      Awaited<ReturnType<GitHubActionsSessionRegistrationService["register"]>>
    > => result.status === "fulfilled",
  );
  assert.equal(fulfilled.length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(
    state.rows.get(existing.id)?.agent_token_hash,
    `${fulfilled[0]?.value.agentToken}-hash`,
  );
  assert.equal(state.rows.get(existing.id)?.updated_at, 100);
});

test("registration repairs a future timestamp without blocking immediate writers", async () => {
  const existing = sessionRow({
    id: "IS-future-revision",
    runtime: "github_actions",
    work_key: "issue:future-revision",
    owner: "operator",
    owner_subject: "github:42",
    updated_at: 500,
  });
  const { store, state } = registrationStore([existing]);

  await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:future-revision",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });

  assert.equal(state.rows.get(existing.id)?.updated_at, 100);
});

test("registration rejects invalid input and work keys owned by another runtime", async () => {
  const { store } = registrationStore([
    sessionRow({
      id: "IS-container",
      runtime: "container",
      work_key: "issue:container",
    }),
  ]);
  const service = new GitHubActionsSessionRegistrationService(store);

  await assert.rejects(
    () =>
      service.register({
        workKey: "issue:container",
        workKind: "issue",
        repo: "openclaw/crabfleet",
        owner: "operator@example.test",
      }),
    { message: "workKey is already registered to a different runtime" },
  );
  await assert.rejects(
    () => service.register({ workKey: "bad key", workKind: "issue", repo: "openclaw/crabfleet" }),
    { message: "workKey contains unsupported characters" },
  );
});
