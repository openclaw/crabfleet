import assert from "node:assert/strict";
import test from "node:test";

import { githubActionsCapabilities } from "../src/github-actions-runtime.ts";
import type { InteractiveSessionRow, InteractiveSessionTable } from "../src/worker/database.ts";
import {
  GitHubActionsSessionRegistrationService,
  actionWorkIdentifier,
  buildGitHubActionsSessionValues,
  optionalHttpUrl,
  type GitHubActionsSessionRegistrationStore,
  type GitHubActionsSessionRegistrationUpdate,
} from "../src/worker/github-actions-session-registration.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

type StoreState = {
  rows: Map<string, InteractiveSessionRow>;
  workKeyReads: number;
  inserted: InteractiveSessionTable[];
  updates: Array<{ id: string; values: GitHubActionsSessionRegistrationUpdate }>;
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
    privateTenancy: false,
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
    adoptLegacyOwner: async (id, owner, ownerSubject) => {
      state.operations.push("adopt-owner");
      const row = state.rows.get(id);
      if (!row || row.owner_subject) return false;
      state.rows.set(id, { ...row, owner, owner_subject: ownerSubject });
      return true;
    },
    updateSession: async (id, values) => {
      state.operations.push("update");
      state.updates.push({ id, values });
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
    owner: null,
    ownerSubject: null,
    agentTokenHash: "agent-hash",
    now: 100,
  });
  assert.equal(values.runtime, "github_actions");
  assert.equal(values.owner, "github-actions:IS-123");
  assert.equal(values.owner_subject, "");
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

test("private GitHub Actions registration requires and persists a stable owner", async () => {
  const missing = registrationStore();
  missing.store.privateTenancy = true;
  await assert.rejects(
    new GitHubActionsSessionRegistrationService(missing.store).register({
      workKey: "issue:private-missing",
      workKind: "issue",
      repo: "openclaw/crabfleet",
    }),
    { message: "owner is required in private tenancy" },
  );

  const owned = registrationStore();
  owned.store.privateTenancy = true;
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
  store.privateTenancy = true;
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

test("legacy GitHub Actions owner adoption rejects a concurrent winner", async () => {
  const legacy = sessionRow({
    id: "IS-legacy",
    runtime: "github_actions",
    work_key: "issue:legacy",
    owner: "legacy",
    owner_subject: "",
  });
  const { store, state } = registrationStore([legacy]);
  store.privateTenancy = true;
  store.adoptLegacyOwner = async (id) => {
    state.operations.push("adopt-owner-lost");
    const row = state.rows.get(id);
    assert.ok(row);
    state.rows.set(id, { ...row, owner: "other", owner_subject: "github:99" });
    return false;
  };

  await assert.rejects(
    new GitHubActionsSessionRegistrationService(store).register({
      workKey: "issue:legacy",
      workKind: "issue",
      repo: "openclaw/crabfleet",
      owner: "operator@example.test",
    }),
    { message: "workKey is already registered to a different owner" },
  );
  assert.equal(state.updates.length, 0);
  assert.deepEqual(state.operations, ["repo:openclaw/crabfleet", "adopt-owner-lost"]);
});

test("legacy GitHub Actions owner adoption is conditional and reread", async () => {
  const legacy = sessionRow({
    id: "IS-legacy-owned",
    runtime: "github_actions",
    work_key: "issue:legacy-owned",
    owner: "legacy",
    owner_subject: "",
  });
  const { store, state } = registrationStore([legacy]);
  store.privateTenancy = true;

  const result = await new GitHubActionsSessionRegistrationService(store).register({
    workKey: "issue:legacy-owned",
    workKind: "issue",
    repo: "openclaw/crabfleet",
    owner: "operator@example.test",
  });
  assert.equal(result.session.owner, "operator");
  assert.equal(state.rows.get("IS-legacy-owned")?.owner_subject, "github:42");
  assert.ok(state.operations.indexOf("adopt-owner") < state.operations.indexOf("update"));
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
  });

  assert.equal(result.session.id, "IS-concurrent");
  assert.equal(state.workKeyReads, 2);
  assert.equal(state.updates[0]?.id, "IS-concurrent");
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
      }),
    { message: "workKey is already registered to a different runtime" },
  );
  await assert.rejects(
    () => service.register({ workKey: "bad key", workKind: "issue", repo: "openclaw/crabfleet" }),
    { message: "workKey contains unsupported characters" },
  );
});
