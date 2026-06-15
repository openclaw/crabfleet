import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import type { User } from "../src/worker/models.ts";
import {
  claimManagedSandboxLeaseRefresh,
  claimManagedSandboxProvision,
  commitManagedSandboxLeaseRefresh,
  commitManagedSandboxProvision,
} from "../src/worker/provisioning/sandbox-repository.ts";
import {
  ManagedSandboxLeaseRefreshService,
  ManagedSandboxProvisioningService,
  managedSandboxProvisionPayloadMatches,
  sandboxLeaseRefreshPayload,
  type ManagedSandboxLeaseRefreshDependencies,
  type ManagedSandboxProvisionClaim,
  type ManagedSandboxProvisioningDependencies,
} from "../src/worker/provisioning/sandbox.ts";
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
} from "../src/worker/provisioning/types.ts";
import { sandboxLeaseId } from "../src/worker/sandbox-lease.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const request: InteractiveProvisionRequest = {
  id: "IS-42",
  parentSessionId: null,
  rootSessionId: "IS-42",
  repo: "openclaw/crabfleet",
  branch: "main",
  runtime: "container",
  profile: "cloudflare-sandbox",
  command: "codex",
  prompt: "Fix the issue",
  purpose: "Fix the issue",
  summary: "Working",
  owner: "owner",
  createdBy: "github:42",
};

const owner = sessionRow({
  status: "provisioning",
  lease_id: "sandbox:old:terminal-old:autostart-v4",
  agent_token_hash: "old-agent-hash",
});

const claim: ManagedSandboxProvisionClaim = {
  agentToken: "agent-token",
  agentTokenHash: "agent-token-hash",
  lease: {
    sandboxId: "sandbox-new",
    terminalSessionId: "terminal-new",
  },
  fence: {
    claim: "managed-provision:claim",
    expiresAt: 1_000,
    refreshLeaseId: owner.lease_id,
    sandboxId: "sandbox-new",
  },
  previousSandboxId: "old",
  claimRevision: 101,
};

function readyResult(values: Partial<InteractiveProvisionResult> = {}): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: sandboxLeaseId(claim.lease),
    attachUrl: "/api/terminal/ws",
    vncUrl: null,
    message: "Cloudflare Sandbox ready",
    ...values,
  };
}

function dependencies(
  overrides: Partial<ManagedSandboxProvisioningDependencies> = {},
): ManagedSandboxProvisioningDependencies {
  return {
    now: () => 200,
    preflight: () => null,
    async claim() {
      return claim;
    },
    async provision() {
      return readyResult();
    },
    async stageFailure() {
      return true;
    },
    async commit() {
      return {
        committed: true,
        cleanupPending: false,
        commitRevision: 201,
      };
    },
    async reconcileCleanup() {},
    providerError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

const refreshUser: User = {
  subject: "github:42",
  login: "owner",
  email: null,
  name: null,
  role: "owner",
  allowed: true,
  teams: [],
};

const legacySandboxSession = interactiveSession(
  sessionRow({
    owner: "owner",
    created_by: "github:42",
    lease_id: "sandbox:old:terminal-old:autostart-v3",
    status: "ready",
    updated_at: 100,
  }),
  [],
);

const refreshedSandboxSession = interactiveSession(
  sessionRow({
    owner: "owner",
    created_by: "github:42",
    lease_id: sandboxLeaseId(claim.lease),
    status: "ready",
    updated_at: 201,
  }),
  [],
);

function refreshDependencies(
  overrides: Partial<ManagedSandboxLeaseRefreshDependencies> = {},
): ManagedSandboxLeaseRefreshDependencies {
  return {
    sandboxAvailable: true,
    now: () => 200,
    async ensurePolicy() {},
    async readGitHubToken() {
      return "github-token";
    },
    preflight: () => null,
    async claim() {
      return claim;
    },
    async readSession() {
      return refreshedSandboxSession;
    },
    async provision() {
      return readyResult();
    },
    async stageFailure() {
      return true;
    },
    async commit() {
      return {
        committed: true,
        cleanupPending: false,
        commitRevision: 201,
      };
    },
    async reconcileCleanup() {},
    async appendLog() {},
    providerError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

test("managed Sandbox validates durable ownership before preflight or claim", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      preflight() {
        calls.push("preflight");
        return null;
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );

  const result = await service.provision({ ...request, branch: "different" }, owner);

  assert.equal(result.status, "failed");
  assert.match(result.message, /does not match durable ownership/);
  assert.deepEqual(calls, []);
  assert.equal(managedSandboxProvisionPayloadMatches(request, owner), true);
  assert.equal(
    managedSandboxProvisionPayloadMatches(request, sessionRow({ ...owner, summary: "different" })),
    false,
  );
});

test("managed Sandbox rejects rows owned by any adapter", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      preflight() {
        calls.push("preflight");
        return null;
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );

  const result = await service.provision(request, sessionRow({ ...owner, adapter: "other-v1" }));

  assert.equal(result.status, "failed");
  assert.match(result.message, /does not match durable ownership/);
  assert.deepEqual(calls, []);
});

test("managed Sandbox preflight runs before durable claim", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      preflight() {
        calls.push("preflight");
        return "Sandbox binding is not configured";
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );

  assert.deepEqual(await service.provision(request, owner), {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message: "Sandbox binding is not configured",
  });
  assert.deepEqual(calls, ["preflight"]);
});

test("managed Sandbox claim contention stops before provider work", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      async claim() {
        calls.push("claim");
        return null;
      },
      async provision() {
        calls.push("provision");
        return readyResult();
      },
    }),
  );

  const result = await service.provision(request, owner);

  assert.equal(result.status, "failed");
  assert.match(result.message, /claim was not acquired/);
  assert.deepEqual(calls, ["claim"]);
});

test("managed Sandbox provisions and commits under one claim before cleanup", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      async claim(_session, _owner, now) {
        calls.push(`claim:${now}`);
        return claim;
      },
      async provision(_session, claimed) {
        calls.push(`provision:${claimed.agentToken}:${claimed.fence.claim}`);
        return readyResult();
      },
      async commit(_sessionId, committedClaim, _result, now) {
        calls.push(`commit:${committedClaim.agentTokenHash}:${now}`);
        return {
          committed: true,
          cleanupPending: true,
          commitRevision: 202,
        };
      },
      async reconcileCleanup(sessionId, now) {
        calls.push(`cleanup:${sessionId}:${now}`);
      },
    }),
  );

  const result = await service.provision(request, owner);

  assert.equal(result.status, "ready");
  assert.deepEqual(calls, [
    "claim:200",
    "provision:agent-token:managed-provision:claim",
    "commit:agent-token-hash:200",
    "cleanup:IS-42:202",
  ]);
});

test("managed Sandbox provider failures stage cleanup and return redacted stopping state", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      async provision() {
        throw new Error("provider token=private");
      },
      async stageFailure(_sessionId, _fence, message, now) {
        calls.push(`${message}:${now}`);
        return true;
      },
      providerError: () => "[credential]",
    }),
  );

  const result = await service.provision(request, owner);

  assert.equal(result.status, "stopping");
  assert.equal(
    result.message,
    "Cloudflare Sandbox provision failed: [credential]; credential cleanup pending",
  );
  assert.deepEqual(calls, ["Cloudflare Sandbox provision failed: [credential]:200"]);
});

test("managed Sandbox non-ready results and lease mismatches stage cleanup", async () => {
  const messages: string[] = [];
  const nonReady = new ManagedSandboxProvisioningService(
    dependencies({
      async provision() {
        return readyResult({
          status: "stopping",
          message: "credential cleanup pending",
        });
      },
      async stageFailure(_sessionId, _fence, message) {
        messages.push(message);
        return true;
      },
    }),
  );
  const mismatch = new ManagedSandboxProvisioningService(
    dependencies({
      async provision() {
        return readyResult({ leaseId: "sandbox:different:terminal:autostart-v4" });
      },
      async stageFailure(_sessionId, _fence, message) {
        messages.push(message);
        return false;
      },
    }),
  );

  assert.equal((await nonReady.provision(request, owner)).status, "stopping");
  assert.match((await mismatch.provision(request, owner)).message, /ownership changed/);
  assert.deepEqual(messages, [
    "credential cleanup pending",
    "interactive provision failed: managed Sandbox lease mismatch",
  ]);
});

test("managed Sandbox commit ownership loss stages failure", async () => {
  const messages: string[] = [];
  const service = new ManagedSandboxProvisioningService(
    dependencies({
      async commit() {
        return {
          committed: false,
          cleanupPending: false,
          commitRevision: 201,
        };
      },
      async stageFailure(_sessionId, _fence, message) {
        messages.push(message);
        return false;
      },
    }),
  );

  const result = await service.provision(request, owner);

  assert.equal(result.status, "failed");
  assert.match(result.message, /ownership changed/);
  assert.deepEqual(messages, ["interactive provision failed: managed session ownership changed"]);
});

test("current managed Sandbox leases only revalidate credential policy", async () => {
  const calls: string[] = [];
  const current = {
    ...refreshedSandboxSession,
    leaseId: sandboxLeaseId(claim.lease),
  };
  const service = new ManagedSandboxLeaseRefreshService(
    refreshDependencies({
      async ensurePolicy(_session, sandboxId) {
        calls.push(`policy:${sandboxId}`);
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );

  assert.equal(
    await service.ensureCurrent(new Request("https://example.test"), refreshUser, current),
    current,
  );
  assert.deepEqual(calls, [`policy:${claim.lease.sandboxId}`]);
});

test("managed Sandbox lease refresh claims, provisions, commits, cleans, and logs in order", async () => {
  const calls: string[] = [];
  let reads = 0;
  const service = new ManagedSandboxLeaseRefreshService(
    refreshDependencies({
      async readGitHubToken() {
        calls.push("token");
        return "github-token";
      },
      preflight(payload) {
        calls.push(`preflight:${payload.githubToken}`);
        return null;
      },
      async claim(_session, now) {
        calls.push(`claim:${now}`);
        return claim;
      },
      async provision(payload, claimed) {
        calls.push(`provision:${payload.githubToken}:${claimed.agentToken}`);
        return readyResult();
      },
      async commit(_sessionId, _claim, _result, now) {
        calls.push(`commit:${now}`);
        return {
          committed: true,
          cleanupPending: true,
          commitRevision: 202,
        };
      },
      async reconcileCleanup(sessionId, now) {
        calls.push(`cleanup:${sessionId}:${now}`);
      },
      async readSession() {
        reads += 1;
        calls.push(`read:${reads}`);
        return refreshedSandboxSession;
      },
      async appendLog(sessionId, user, message, now) {
        calls.push(`log:${sessionId}:${user.login}:${message}:${now}`);
      },
    }),
  );

  const refreshed = await service.ensureCurrent(
    new Request("https://example.test"),
    refreshUser,
    legacySandboxSession,
  );

  assert.equal(refreshed.leaseId, sandboxLeaseId(claim.lease));
  assert.equal(refreshed.githubToken, "github-token");
  assert.deepEqual(calls, [
    "token",
    "preflight:github-token",
    "claim:200",
    "provision:github-token:agent-token",
    "commit:200",
    "cleanup:IS-42:202",
    "read:1",
    "log:IS-42:owner:Cloudflare Sandbox lease refreshed:200",
    "read:2",
  ]);
});

test("managed Sandbox lease refresh fails before claiming without owner credentials", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxLeaseRefreshService(
    refreshDependencies({
      async readGitHubToken() {
        calls.push("token");
        return undefined;
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );

  await assert.rejects(
    service.ensureCurrent(new Request("https://example.test"), refreshUser, legacySandboxSession),
    /GitHub PR credentials are not connected/,
  );
  assert.deepEqual(calls, ["token"]);
});

test("managed Sandbox lease refresh stages redacted provider failures", async () => {
  const calls: string[] = [];
  const service = new ManagedSandboxLeaseRefreshService(
    refreshDependencies({
      async provision() {
        throw new Error("token=private");
      },
      providerError: () => "[credential]",
      async stageFailure(_sessionId, _fence, message, now) {
        calls.push(`${message}:${now}`);
        return true;
      },
    }),
  );

  await assert.rejects(
    service.ensureCurrent(new Request("https://example.test"), refreshUser, legacySandboxSession),
    /Cloudflare Sandbox lease refresh failed: \[credential\]/,
  );
  assert.deepEqual(calls, ["Cloudflare Sandbox lease refresh failed: [credential]:200"]);
});

test("Sandbox lease refresh payload preserves durable identity and scoped credentials", () => {
  assert.deepEqual(sandboxLeaseRefreshPayload(legacySandboxSession, "github-token"), {
    id: legacySandboxSession.id,
    parentSessionId: legacySandboxSession.parentSessionId,
    rootSessionId: legacySandboxSession.rootSessionId ?? legacySandboxSession.id,
    repo: legacySandboxSession.repo,
    branch: legacySandboxSession.branch,
    runtime: "container",
    profile: legacySandboxSession.profile,
    command: legacySandboxSession.command,
    prompt: legacySandboxSession.prompt,
    purpose: legacySandboxSession.purpose,
    summary: legacySandboxSession.summary,
    owner: legacySandboxSession.owner,
    createdBy: legacySandboxSession.createdBy,
    githubToken: "github-token",
  });
});

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(
  handler: (
    sql: string,
    parameters: unknown[],
    kind: "all" | "run",
  ) => {
    results?: unknown[];
    changes?: number;
  },
  batchHandler: (statements: PreparedStatement[]) => unknown[] = () => [],
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
        return batchHandler(statements as PreparedStatement[]);
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("managed Sandbox claim compiles the complete durable ownership fence", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = runtimeEnv((sql, parameters) => {
    executions.push({ sql, parameters });
    return { changes: 1 };
  });

  const claimed = await claimManagedSandboxProvision(env, request, owner, 200, 900);

  assert.ok(claimed);
  assert.equal(claimed.claimRevision, 200);
  assert.equal(claimed.fence.expiresAt, 1_100);
  assert.equal(claimed.fence.refreshLeaseId, owner.lease_id);
  assert.equal(claimed.previousSandboxId, "old");
  assert.equal(executions.length, 1);
  assert.match(executions[0].sql, /preparation_pending/);
  assert.match(executions[0].sql, /parent_session_id/);
  assert.match(executions[0].sql, /root_session_id/);
  assert.match(executions[0].sql, /agent_token_hash/);
  assert.match(executions[0].sql, /"adapter" is null/i);
  assert.match(executions[0].sql, /sandbox_refresh_claim_expires_at/);
  assert.match(executions[0].sql, /credential_cleanup_terminal_status/);
  assert.ok(executions[0].parameters.includes(owner.updated_at));
  assert.ok(executions[0].parameters.includes(owner.agent_token_hash));
  assert.ok(executions[0].parameters.includes(owner.lease_id));
});

test("managed Sandbox claim returns null when the ownership fence loses", async () => {
  const env = runtimeEnv(() => ({ changes: 0 }));

  assert.equal(await claimManagedSandboxProvision(env, request, owner, 200, 900), null);
});

test("managed Sandbox refresh claim persists one fenced replacement lease", async () => {
  const executions: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = runtimeEnv((sql, parameters) => {
    executions.push({ sql, parameters });
    return { changes: 1 };
  });

  const claimed = await claimManagedSandboxLeaseRefresh(env, legacySandboxSession, 200, 900);

  assert.ok(claimed);
  assert.equal(claimed.claimRevision, 200);
  assert.equal(claimed.fence.expiresAt, 1_100);
  assert.match(claimed.fence.refreshLeaseId ?? "", /:refreshing-200-[a-f0-9]+$/);
  assert.equal(claimed.previousSandboxId, "old");
  assert.equal(executions.length, 1);
  assert.match(executions[0].sql, /sandbox_refresh_sandbox_id/);
  assert.match(executions[0].sql, /sandbox_refresh_claim_expires_at/);
  assert.match(executions[0].sql, /agent_token_hash/);
  assert.ok(executions[0].parameters.includes(legacySandboxSession.leaseId));
  assert.ok(executions[0].parameters.includes("ready"));
  assert.ok(executions[0].parameters.includes("attached"));
  assert.ok(executions[0].parameters.includes("detached"));
});

test("managed Sandbox commit fences activation and previous-policy cleanup", async () => {
  let statements: PreparedStatement[] = [];
  const expectedLeaseId = sandboxLeaseId(claim.lease);
  const env = runtimeEnv(
    (sql) =>
      /select .*lease_id/i.test(sql)
        ? {
            results: [
              {
                lease_id: expectedLeaseId,
                status: "ready",
                sandbox_refresh_claim: null,
                agent_token_hash: claim.agentTokenHash,
              },
            ],
          }
        : { changes: 1 },
    (prepared) => {
      statements = prepared;
      return prepared.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  );

  const committed = await commitManagedSandboxProvision(env, request.id, claim, readyResult(), 200);

  assert.deepEqual(committed, {
    committed: true,
    cleanupPending: true,
    commitRevision: 200,
  });
  assert.equal(statements.length, 2);
  const batchSql = statements.map((statement) => statement.sql).join("\n");
  assert.match(batchSql, /sandbox_refresh_claim_expires_at/);
  assert.match(batchSql, /agent_token_hash/);
  assert.match(batchSql, /credential_cleanup_terminal_status/);
  assert.match(batchSql, /interactive_session_credential_policies/);
  const parameters = statements.flatMap((statement) => statement.parameters);
  assert.ok(parameters.includes("cleanup_pending"));
  assert.ok(parameters.includes(claim.fence.claim));
  assert.ok(parameters.includes(claim.fence.expiresAt));
  assert.ok(parameters.includes(claim.agentTokenHash));
  assert.ok(parameters.includes(expectedLeaseId));
  assert.ok(parameters.includes(claim.previousSandboxId));
});

test("managed Sandbox refresh commit clears the claim before prior-policy cleanup", async () => {
  let statements: PreparedStatement[] = [];
  const expectedLeaseId = sandboxLeaseId(claim.lease);
  const env = runtimeEnv(
    (sql) =>
      /select .*lease_id/i.test(sql)
        ? {
            results: [
              {
                lease_id: expectedLeaseId,
                status: "ready",
                credential_cleanup_terminal_status: null,
                agent_token_hash: claim.agentTokenHash,
              },
            ],
          }
        : { changes: 1 },
    (prepared) => {
      statements = prepared;
      return prepared.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  );

  const committed = await commitManagedSandboxLeaseRefresh(
    env,
    request.id,
    claim,
    readyResult(),
    200,
  );

  assert.deepEqual(committed, {
    committed: true,
    cleanupPending: true,
    commitRevision: 200,
  });
  assert.equal(statements.length, 2);
  const batchSql = statements.map((statement) => statement.sql).join("\n");
  assert.match(batchSql, /sandbox_refresh_claim/);
  assert.match(batchSql, /sandbox_refresh_claim_expires_at/);
  assert.match(batchSql, /agent_token_hash/);
  assert.match(batchSql, /interactive_session_credential_policies/);
  const parameters = statements.flatMap((statement) => statement.parameters);
  assert.ok(parameters.includes("cleanup_pending"));
  assert.ok(parameters.includes(claim.fence.claim));
  assert.ok(parameters.includes(claim.fence.expiresAt));
  assert.ok(parameters.includes(claim.agentTokenHash));
  assert.ok(parameters.includes(expectedLeaseId));
  assert.ok(parameters.includes(claim.previousSandboxId));
});
