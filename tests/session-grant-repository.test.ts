import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { InteractiveSessionGrantRepository } from "../src/worker/session-grant-repository.ts";

type PreparedStatement = {
  sql: string;
  parameters: unknown[];
  all(): Promise<unknown>;
  run(): Promise<unknown>;
};

function runtimeEnv(options: {
  results?: unknown[];
  allowEntries?: unknown[];
  batches?: PreparedStatement[][];
  mutations?: PreparedStatement[];
  mutationChanges?: number;
  batchChanges?: number[];
  env?: Partial<RuntimeEnv>;
}): RuntimeEnv {
  return {
    ...options.env,
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              sql,
              parameters,
              async all() {
                return {
                  results: /from "allow_entries"/i.test(sql)
                    ? (options.allowEntries ?? [])
                    : (options.results ?? []),
                  meta: { changes: 0 },
                };
              },
              async run() {
                if (!options.mutations) throw new Error(`unexpected standalone mutation: ${sql}`);
                options.mutations?.push({
                  sql,
                  parameters,
                  all: async () => ({}),
                  run: async () => ({}),
                });
                return { meta: { changes: options.mutationChanges ?? 0 } };
              },
            };
          },
        };
      },
      async batch(statements: unknown[]) {
        options.batches?.push(statements as PreparedStatement[]);
        return statements.map((_, index) => ({
          meta: { changes: options.batchChanges?.[index] ?? 0 },
        }));
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
}

test("principal resolution keeps actor-compatible owners and rejects ambiguous identities", async () => {
  const unique = new InteractiveSessionGrantRepository(
    runtimeEnv({
      allowEntries: [{ value: "@operator", role: "maintainer" }],
      results: [
        {
          subject: "github:42",
          login: "operator",
          email: "operator@example.test",
        },
      ],
    }),
  );
  assert.deepEqual(await unique.resolvePrincipal("github:42"), {
    subject: "github:42",
    principal: "@operator",
    actor: "operator",
  });

  const ambiguous = new InteractiveSessionGrantRepository(
    runtimeEnv({
      allowEntries: [{ value: "@operator", role: "maintainer" }],
      results: [
        { subject: "github:42", login: "operator", email: null },
        { subject: "github:99", login: "operator", email: null },
      ],
    }),
  );
  assert.equal(await ambiguous.resolvePrincipal("operator"), null);

  const revoked = new InteractiveSessionGrantRepository(
    runtimeEnv({
      results: [
        {
          subject: "github:42",
          login: "operator",
          email: "operator@example.test",
          allowed: 1,
        },
      ],
    }),
  );
  assert.equal(await revoked.resolvePrincipal("operator"), null);

  const emailOnly = new InteractiveSessionGrantRepository(
    runtimeEnv({
      allowEntries: [{ value: "person@example.test", role: "maintainer" }],
      results: [
        {
          subject: "github:77",
          login: null,
          email: "person@example.test",
        },
      ],
    }),
  );
  assert.equal(await emailOnly.resolvePrincipal("@"), null);
});

test("principal resolution collapses rotated bootstrap rows to one stable tenant", async () => {
  const repository = new InteractiveSessionGrantRepository(
    runtimeEnv({
      env: { CRABBOX_BOOTSTRAP_TOKEN: "rotated-token" },
      results: [
        { subject: "bootstrap:first", login: "bootstrap", email: null },
        { subject: "bootstrap:second", login: "bootstrap", email: null },
      ],
    }),
  );

  for (const value of ["bootstrap:owner", "bootstrap"]) {
    assert.deepEqual(await repository.resolvePrincipal(value), {
      subject: "bootstrap:owner",
      principal: "@bootstrap",
      actor: "bootstrap",
    });
  }
});

test("principal resolution follows current trusted-proxy onboarding policy", async () => {
  const results = [
    {
      subject: "proxy:collaborator",
      login: "collaborator",
      email: null,
      allowed: 1,
    },
  ];
  const proxyEnv = {
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example.test",
    CRABFLEET_TRUSTED_PROXY_SECRET: "secret",
  };
  const enabled = new InteractiveSessionGrantRepository(
    runtimeEnv({
      results,
      env: { ...proxyEnv, CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "maintainer" },
    }),
  );
  assert.equal((await enabled.resolvePrincipal("collaborator"))?.subject, "proxy:collaborator");

  const disabled = new InteractiveSessionGrantRepository(runtimeEnv({ results, env: proxyEnv }));
  assert.equal(await disabled.resolvePrincipal("collaborator"), null);

  const malformed = new InteractiveSessionGrantRepository(
    runtimeEnv({
      results,
      allowEntries: [{ value: "@collaborator", role: "maintainer" }],
      env: { ...proxyEnv, CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "owner" },
    }),
  );
  assert.equal(await malformed.resolvePrincipal("collaborator"), null);
});

test("grant upsert is atomically fenced to the live session revision", async () => {
  const mutations: PreparedStatement[] = [];
  const repository = new InteractiveSessionGrantRepository(
    runtimeEnv({ mutations, mutationChanges: 1 }),
  );
  const input = {
    sessionId: "IS-42",
    subject: "proxy:collaborator@example.test",
    principal: "collaborator@example.test",
    role: "viewer" as const,
    createdBySubject: "proxy:owner@example.test",
    expiresAt: 10_000,
    expectedSessionUpdatedAt: 2_000,
    now: 1_000,
  };

  assert.equal(await repository.upsert(input), true);
  assert.equal(mutations.length, 1);
  assert.match(mutations[0]?.sql ?? "", /^INSERT INTO interactive_session_grants/i);
  assert.match(mutations[0]?.sql ?? "", /FROM interactive_sessions/i);
  assert.match(mutations[0]?.sql ?? "", /updated_at = \?/i);
  assert.match(
    mutations[0]?.sql ?? "",
    /status NOT IN \('stopping', 'stopped', 'expired', 'failed'\)/i,
  );
  assert.deepEqual(mutations[0]?.parameters.slice(-2), ["IS-42", 2_000]);

  const rejected = new InteractiveSessionGrantRepository(
    runtimeEnv({ mutations: [], mutationChanges: 0 }),
  );
  assert.equal(await rejected.upsert(input), false);
});

test("grant revocation atomically removes access and delegated control", async () => {
  const batches: PreparedStatement[][] = [];
  const repository = new InteractiveSessionGrantRepository(
    runtimeEnv({
      batches,
      batchChanges: [1, 1, 1, 1],
    }),
  );

  assert.equal(await repository.revoke("IS-42", "proxy:collaborator@example.test", 2_000), true);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 4);
  assert.match(batches[0]?.[0]?.sql ?? "", /^update "interactive_sessions"/i);
  assert.match(batches[0]?.[0]?.sql ?? "", /exists/i);
  assert.match(batches[0]?.[0]?.sql ?? "", /"control_requested_by_subject" = \?/i);
  assert.doesNotMatch(batches[0]?.[0]?.sql ?? "", /"control_requested_by" in/i);
  assert.doesNotMatch(batches[0]?.[0]?.sql ?? "", /where[^]*"controller_subject" = \?/i);
  assert.match(batches[0]?.[1]?.sql ?? "", /^update "interactive_sessions"/i);
  assert.match(batches[0]?.[1]?.sql ?? "", /"controller_subject" = \?/i);
  assert.doesNotMatch(batches[0]?.[1]?.sql ?? "", /"controller" in/i);
  assert.doesNotMatch(batches[0]?.[1]?.sql ?? "", /where[^]*"control_requested_by_subject" = \?/i);
  assert.match(batches[0]?.[2]?.sql ?? "", /"updated_at" = MAX\(updated_at \+ 1, \?\)/i);
  assert.match(batches[0]?.[3]?.sql ?? "", /^delete from "interactive_session_grants"/i);
  assert.ok(batches[0]?.[0]?.parameters.includes("proxy:collaborator@example.test"));
  assert.ok(batches[0]?.[1]?.parameters.includes("proxy:collaborator@example.test"));
  assert.ok(batches[0]?.[2]?.parameters.includes(2_000));
  assert.ok(batches[0]?.[3]?.parameters.includes("IS-42"));
  assert.ok(batches[0]?.[3]?.parameters.includes("proxy:collaborator@example.test"));
});

test("grant revocation leaves sessions untouched when no grant exists", async () => {
  const batches: PreparedStatement[][] = [];
  const repository = new InteractiveSessionGrantRepository(
    runtimeEnv({ batches, batchChanges: [0, 0, 0, 0] }),
  );

  assert.equal(await repository.revoke("IS-42", "proxy:missing@example.test"), false);
  assert.equal(batches.length, 1);
  assert.equal(batches[0]?.length, 4);
});
