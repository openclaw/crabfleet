import assert from "node:assert/strict";
import test from "node:test";

import type { StandaloneSandboxProvisionRow } from "../src/worker/database.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  activateStandaloneSandboxProvision,
  claimStandaloneSandboxProvision,
  stageStandaloneSandboxClaimCleanup,
} from "../src/worker/provisioning/standalone-sandbox-repository.ts";
import {
  isManagedInteractiveSessionId,
  StandaloneSandboxProvisioningService,
  standaloneSandboxProvisionRequestHashInput,
  type StandaloneSandboxProvisionClaim,
  type StandaloneSandboxProvisioningDependencies,
} from "../src/worker/provisioning/standalone-sandbox.ts";
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
} from "../src/worker/provisioning/types.ts";
import { sandboxLeaseId } from "../src/worker/sandbox-lease.ts";

const request: InteractiveProvisionRequest = {
  id: "external-42",
  parentSessionId: null,
  rootSessionId: "external-42",
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
  githubToken: "secret",
};

const claim: StandaloneSandboxProvisionClaim = {
  lease: {
    sandboxId: "sandbox-new",
    terminalSessionId: "terminal-new",
  },
  fence: {
    claim: "standalone:claim",
    provisionId: request.id,
    sandboxId: "sandbox-new",
  },
  expiresAt: 10_000,
  claimRevision: 200,
};

function owner(values: Partial<StandaloneSandboxProvisionRow> = {}): StandaloneSandboxProvisionRow {
  return {
    id: request.id,
    request_hash: "hash",
    sandbox_id: "sandbox-old",
    state: "provisioning",
    ownership_claim: "standalone:old",
    ownership_claim_expires_at: 100,
    lease_id: "sandbox:sandbox-old:terminal-old:autostart-v4",
    attach_url: null,
    vnc_url: null,
    expires_at: 9_000,
    message: "standalone Sandbox provision started",
    created_at: 1,
    updated_at: 2,
    ...values,
  };
}

function readyResult(values: Partial<InteractiveProvisionResult> = {}): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: sandboxLeaseId(claim.lease),
    attachUrl: "wss://crabfleet.example/pty",
    vncUrl: null,
    message: "Cloudflare Sandbox ready",
    ...values,
  };
}

function dependencies(
  overrides: Partial<StandaloneSandboxProvisioningDependencies> = {},
): StandaloneSandboxProvisioningDependencies {
  return {
    now: () => 200,
    requestHash: async () => "hash",
    readOwner: async () => null,
    stageOwnerCleanup: async () => true,
    reconcileCleanup: async () => {},
    claim: async () => claim,
    provision: async () => readyResult(),
    stageClaimCleanup: async () => {},
    queuePolicyCleanup: async () => {},
    activate: async () => true,
    providerError: (error) => (error instanceof Error ? error.message : String(error)),
    ...overrides,
  };
}

test("standalone Sandbox rejects the managed namespace before persistence", async () => {
  const calls: string[] = [];
  const service = new StandaloneSandboxProvisioningService(
    dependencies({
      async requestHash() {
        calls.push("hash");
        return "hash";
      },
      async readOwner() {
        calls.push("read");
        return null;
      },
    }),
  );

  const result = await service.provision({ ...request, id: "IS-42" });

  assert.equal(isManagedInteractiveSessionId("is-42"), true);
  assert.equal(result.status, "failed");
  assert.match(result.message, /managed session namespace/);
  assert.deepEqual(calls, []);
});

test("standalone Sandbox hash excludes transient GitHub credentials", () => {
  const { githubToken: _githubToken, ...expected } = request;
  const hashInput = standaloneSandboxProvisionRequestHashInput(request);

  assert.deepEqual(hashInput, expected);
  assert.equal("githubToken" in hashInput, false);
});

test("standalone Sandbox replays an active owner and rejects hash conflicts", async () => {
  const active = owner({
    state: "active",
    ownership_claim: null,
    ownership_claim_expires_at: null,
    expires_at: 1_000,
    attach_url: "wss://crabfleet.example/existing",
    message: "existing",
  });
  const calls: string[] = [];
  const replay = new StandaloneSandboxProvisioningService(
    dependencies({
      async readOwner() {
        calls.push("read");
        return active;
      },
      async claim() {
        calls.push("claim");
        return claim;
      },
    }),
  );
  const conflict = new StandaloneSandboxProvisioningService(
    dependencies({
      requestHash: async () => "different",
      readOwner: async () => active,
    }),
  );

  assert.deepEqual(await replay.provision(request), {
    status: "ready",
    leaseId: active.lease_id,
    attachUrl: active.attach_url,
    vncUrl: active.vnc_url,
    expiresAt: active.expires_at,
    expiresAtPresent: true,
    message: active.message,
  });
  assert.deepEqual(calls, ["read"]);
  assert.match((await conflict.provision(request)).message, /already registered/);
});

test("standalone Sandbox expires active owners through staged cleanup", async () => {
  const calls: string[] = [];
  const expired = owner({
    state: "active",
    ownership_claim: null,
    ownership_claim_expires_at: null,
    expires_at: 200,
  });
  const service = new StandaloneSandboxProvisioningService(
    dependencies({
      readOwner: async () => expired,
      async stageOwnerCleanup(_owner, message, now) {
        calls.push(`stage:${message}:${now}`);
        return true;
      },
      async reconcileCleanup(provisionId, now) {
        calls.push(`reconcile:${provisionId}:${now}`);
      },
    }),
  );

  const result = await service.provision(request);

  assert.equal(result.status, "failed");
  assert.match(result.message, /provision expired/);
  assert.deepEqual(calls, [
    "stage:standalone Sandbox provision expired:200",
    "reconcile:external-42:200",
  ]);
});

test("standalone Sandbox recovers a stale owner before taking a new claim", async () => {
  const calls: string[] = [];
  const owners = [owner(), null];
  const service = new StandaloneSandboxProvisioningService(
    dependencies({
      async readOwner() {
        calls.push("read");
        return owners.shift() ?? null;
      },
      async stageOwnerCleanup(_owner, message, now) {
        calls.push(`stage:${message}:${now}`);
        return true;
      },
      async reconcileCleanup(provisionId, now) {
        calls.push(`reconcile:${provisionId}:${now}`);
      },
      async claim(_session, requestHash, now) {
        calls.push(`claim:${requestHash}:${now}`);
        return claim;
      },
      async provision() {
        calls.push("provision");
        return readyResult();
      },
      async activate() {
        calls.push("activate");
        return true;
      },
    }),
  );

  const result = await service.provision(request);

  assert.equal(result.status, "ready");
  assert.equal(result.expiresAt, claim.expiresAt);
  assert.deepEqual(calls, [
    "read",
    "stage:abandoned standalone Sandbox provision cleanup:200",
    "reconcile:external-42:200",
    "read",
    "claim:hash:200",
    "provision",
    "activate",
  ]);
});

test("standalone Sandbox refuses lost or incomplete stale-owner cleanup", async () => {
  const stale = owner();
  const ownershipLost = new StandaloneSandboxProvisioningService(
    dependencies({
      readOwner: async () => stale,
      stageOwnerCleanup: async () => false,
    }),
  );
  const cleanupPending = new StandaloneSandboxProvisioningService(
    dependencies({
      readOwner: async () => stale,
      stageOwnerCleanup: async () => true,
      reconcileCleanup: async () => {},
    }),
  );

  assert.match((await ownershipLost.provision(request)).message, /ownership changed/);
  assert.match((await cleanupPending.provision(request)).message, /cleanup is pending/);
});

test("standalone Sandbox claim contention stops before provider work", async () => {
  const calls: string[] = [];
  const service = new StandaloneSandboxProvisioningService(
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

  const result = await service.provision(request);

  assert.equal(result.status, "failed");
  assert.match(result.message, /already in progress/);
  assert.deepEqual(calls, ["claim"]);
});

test("standalone Sandbox failures stage owner and policy cleanup", async () => {
  const messages: string[] = [];
  const service = new StandaloneSandboxProvisioningService(
    dependencies({
      async provision() {
        throw new Error("token=private");
      },
      providerError: () => "[credential]",
      async stageClaimCleanup(_claim, message) {
        messages.push(`owner:${message}`);
      },
      async queuePolicyCleanup(_provisionId, _sandboxId, now) {
        messages.push(`policy:${now}`);
      },
      async reconcileCleanup(_provisionId, now) {
        messages.push(`reconcile:${now}`);
      },
    }),
  );

  const result = await service.provision(request);

  assert.equal(result.status, "failed");
  assert.equal(result.message, "Cloudflare Sandbox provision failed: [credential]");
  assert.deepEqual(messages, [
    "owner:Cloudflare Sandbox provision failed: [credential]",
    "policy:200",
    "reconcile:200",
  ]);
});

test("standalone Sandbox rejects non-ready, mismatched, and lost activations", async () => {
  const messages: string[] = [];
  const cleanup = {
    async stageClaimCleanup(
      _claim: StandaloneSandboxProvisionClaim,
      message: string,
    ): Promise<void> {
      messages.push(message);
    },
    async queuePolicyCleanup(): Promise<void> {},
    async reconcileCleanup(): Promise<void> {},
  };
  const nonReady = new StandaloneSandboxProvisioningService(
    dependencies({
      ...cleanup,
      provision: async () => readyResult({ status: "stopping", message: "cleanup pending" }),
    }),
  );
  const mismatch = new StandaloneSandboxProvisioningService(
    dependencies({
      ...cleanup,
      provision: async () => readyResult({ leaseId: "sandbox:different:terminal:autostart-v4" }),
    }),
  );
  const activationLost = new StandaloneSandboxProvisioningService(
    dependencies({
      ...cleanup,
      activate: async () => false,
    }),
  );

  assert.equal((await nonReady.provision(request)).status, "stopping");
  assert.match((await mismatch.provision(request)).message, /lease mismatch/);
  assert.match((await activationLost.provision(request)).message, /ownership claim expired/);
  assert.deepEqual(messages, [
    "cleanup pending",
    "interactive provision failed: standalone Sandbox lease mismatch",
    "standalone ownership claim expired",
  ]);
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

test("standalone Sandbox claim inserts without overwriting an existing owner", async () => {
  let insertSql = "";
  let insertParameters: unknown[] = [];
  const env = runtimeEnv((sql, parameters, kind) => {
    if (kind === "run") {
      insertSql = sql;
      insertParameters = parameters;
      return { changes: 1 };
    }
    return {
      results: [
        owner({
          request_hash: String(insertParameters[1]),
          sandbox_id: String(insertParameters[2]),
          ownership_claim: String(insertParameters[3]),
          ownership_claim_expires_at: Number(insertParameters[4]),
          lease_id: String(insertParameters[5]),
          expires_at: Number(insertParameters[6]),
          created_at: Number(insertParameters[7]),
          updated_at: Number(insertParameters[8]),
        }),
      ],
    };
  });

  const claimed = await claimStandaloneSandboxProvision(env, request, "hash", 200, 900, 5_000);

  assert.ok(claimed);
  assert.match(insertSql, /ON CONFLICT\(id\) DO NOTHING/i);
  assert.doesNotMatch(insertSql, /DO UPDATE/i);
  assert.equal(claimed.expiresAt, 5_200);
  assert.equal(claimed.claimRevision, 200);
  assert.equal(claimed.fence.provisionId, request.id);
  assert.equal(claimed.fence.sandboxId, claimed.lease.sandboxId);
});

test("standalone Sandbox claim returns null when another owner wins", async () => {
  const env = runtimeEnv((_sql, _parameters, kind) =>
    kind === "all" ? { results: [owner({ ownership_claim_expires_at: 1_000 })] } : { changes: 0 },
  );

  assert.equal(await claimStandaloneSandboxProvision(env, request, "hash", 200, 900, 5_000), null);
});

test("standalone Sandbox claim cleanup fences the exact owner revision", async () => {
  let execution: { sql: string; parameters: unknown[] } | null = null;
  const env = runtimeEnv((sql, parameters) => {
    execution = { sql, parameters };
    return { changes: 1 };
  });

  await stageStandaloneSandboxClaimCleanup(env, claim, "failed", 200);

  assert.ok(execution);
  assert.match(execution.sql, /ownership_claim/i);
  assert.match(execution.sql, /lease_id/i);
  assert.match(execution.sql, /expires_at/i);
  assert.ok(execution.parameters.includes(claim.fence.claim));
  assert.ok(execution.parameters.includes(sandboxLeaseId(claim.lease)));
  assert.ok(execution.parameters.includes(claim.expiresAt));
  assert.ok(execution.parameters.includes(201));
});

test("standalone Sandbox activation fences owner and complete policy generation", async () => {
  let statements: PreparedStatement[] = [];
  const expectedLeaseId = sandboxLeaseId(claim.lease);
  const env = runtimeEnv(
    (sql) => {
      if (/from "interactive_session_credential_policies"/i.test(sql)) {
        return {
          results: [
            {
              lookup_id: claim.lease.sandboxId,
              state: "active",
              registration_generation: "generation-1",
              registration_claim: null,
            },
          ],
        };
      }
      if (/from "standalone_sandbox_provisions"/i.test(sql)) {
        return {
          results: [
            {
              state: "active",
              sandbox_id: claim.lease.sandboxId,
              lease_id: expectedLeaseId,
              expires_at: claim.expiresAt,
            },
          ],
        };
      }
      return { changes: 1 };
    },
    (prepared) => {
      statements = prepared;
      return prepared.map(() => ({ results: [], meta: { changes: 1 } }));
    },
  );

  assert.equal(
    await activateStandaloneSandboxProvision(env, request.id, claim, readyResult(), 200),
    true,
  );
  assert.equal(statements.length, 2);
  const sql = statements.map((statement) => statement.sql).join("\n");
  assert.match(sql, /interactive_session_credential_policies/);
  assert.match(sql, /standalone_sandbox_provisions/);
  assert.match(sql, /ownership_claim_expires_at/);
  assert.match(sql, /registration_generation/);
  const parameters = statements.flatMap((statement) => statement.parameters);
  assert.ok(parameters.includes(claim.fence.claim));
  assert.ok(parameters.includes("generation-1"));
  assert.ok(parameters.includes(expectedLeaseId));
  assert.ok(parameters.includes(201));
});
