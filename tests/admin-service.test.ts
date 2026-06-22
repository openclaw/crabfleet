import assert from "node:assert/strict";
import test from "node:test";

import type { AdminMutationStore } from "../src/worker/admin-repository.ts";
import { AdminService, type AdminServiceDependencies } from "../src/worker/admin-service.ts";
import type { User } from "../src/worker/models.ts";
import type { RepoWorkflow } from "../src/worker/workflow-model.ts";

const owner: User = {
  subject: "github:1",
  login: "owner",
  email: null,
  name: "Owner",
  role: "owner",
  allowed: true,
  teams: [],
};

const maintainer: User = { ...owner, role: "maintainer" };
const disallowedOwner: User = { ...owner, allowed: false };

function workflow(repo: string, status: RepoWorkflow["status"] = "ok"): RepoWorkflow {
  return {
    repo,
    status,
    sourcePath: "CRABBOX.md",
    sourceSha: "sha-1",
    config: {},
    prompt: "",
    error: null,
    evaluatedAt: 100,
    updatedAt: 100,
  };
}

function dependencies(calls: string[]): AdminServiceDependencies {
  const store: AdminMutationStore = {
    async requireRepo(repo) {
      calls.push(`require:${repo}`);
    },
    async writePolicy(policy) {
      calls.push(`policy:${policy.cap}:${policy.retention}:${policy.merge}`);
    },
    async upsertAllowEntry(value, role, now) {
      calls.push(`allow:upsert:${value}:${role}:${now}`);
    },
    async removeAllowEntry(value) {
      calls.push(`allow:remove:${value}`);
    },
    async upsertRepo(repo, now) {
      calls.push(`repo:upsert:${repo}:${now}`);
    },
    async disableRepo(repo, now) {
      calls.push(`repo:disable:${repo}:${now}`);
    },
  };
  return {
    store,
    preferredRepo: "openclaw/crabfleet",
    now: () => 100,
    async refreshWorkflow(repo, now) {
      calls.push(`workflow:${repo}:${now}`);
      return workflow(repo);
    },
    async audit(_user, message, now) {
      calls.push(`audit:${message}:${now}`);
    },
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("admin policy normalizes bounds and records audit after persistence", async () => {
  const calls: string[] = [];
  const service = new AdminService(dependencies(calls));

  assert.deepEqual(
    await service.updatePolicy({ cap: 500, retention: "60", merge: "maintainers" }, owner),
    { cap: 200, retention: "60", merge: "maintainers" },
  );
  assert.deepEqual(calls, [
    "policy:200:60:maintainers",
    "audit:policy updated cap=200 retention=60 merge=maintainers:100",
  ]);

  calls.length = 0;
  assert.deepEqual(
    await service.updatePolicy({ cap: Number.NaN, retention: "forever", merge: "always" }, owner),
    { cap: 20, retention: "30", merge: "guarded" },
  );
});

test("admin mutations require an allowed owner before store writes", async () => {
  const attempts: Array<[string, (service: AdminService, user: User) => Promise<unknown>]> = [
    ["updatePolicy", (service, user) => service.updatePolicy({ cap: 5 }, user)],
    ["evaluateWorkflow", (service, user) => service.evaluateWorkflow({}, user)],
    ["addAllowEntry", (service, user) => service.addAllowEntry({ value: "team/core" }, user)],
    ["removeAllowEntry", (service, user) => service.removeAllowEntry("team/core", user)],
    ["addRepo", (service, user) => service.addRepo({ repo: "openclaw/crabfleet" }, user)],
    ["removeRepo", (service, user) => service.removeRepo("openclaw/crabfleet", user)],
  ];

  for (const [name, attempt] of attempts) {
    for (const user of [maintainer, disallowedOwner]) {
      const calls: string[] = [];
      const service = new AdminService(dependencies(calls));
      await assert.rejects(attempt(service, user), (error) => {
        assert.equal(status(error), 403, name);
        return true;
      });
      assert.deepEqual(calls, [], name);
    }
  }
});

test("admin workflow evaluation validates the preferred repo before refresh", async () => {
  const calls: string[] = [];
  const result = await new AdminService(dependencies(calls)).evaluateWorkflow({}, owner);

  assert.equal(result.repo, "openclaw/crabfleet");
  assert.deepEqual(calls, [
    "require:openclaw/crabfleet",
    "workflow:openclaw/crabfleet:100",
    "audit:workflow evaluated openclaw/crabfleet status=ok:100",
  ]);
});

test("admin allowlist mutations normalize identity and default role", async () => {
  const calls: string[] = [];
  const service = new AdminService(dependencies(calls));

  assert.deepEqual(await service.addAllowEntry({ value: " Team/Core " }, owner), {
    value: "@team/core",
    role: "maintainer",
  });
  assert.equal(await service.removeAllowEntry("USER@EXAMPLE.COM", owner), "user@example.com");
  assert.deepEqual(calls, [
    "allow:upsert:@team/core:maintainer:100",
    "audit:allowlist updated @team/core role=maintainer:100",
    "allow:remove:user@example.com",
    "audit:allowlist removed user@example.com:100",
  ]);

  await assert.rejects(service.addAllowEntry({ value: " " }, owner), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
});

test("admin repository mutations accept one normalized GitHub owner/name", async () => {
  const calls: string[] = [];
  const service = new AdminService(dependencies(calls));

  assert.equal(
    await service.addRepo({ repo: "https://github.com/OpenClaw/Crabfleet.git" }, owner),
    "openclaw/crabfleet",
  );
  assert.equal(await service.removeRepo("OpenClaw/Crabfleet", owner), "openclaw/crabfleet");
  assert.deepEqual(calls, [
    "repo:upsert:openclaw/crabfleet:100",
    "audit:repo allowlisted openclaw/crabfleet:100",
    "repo:disable:openclaw/crabfleet:100",
    "audit:repo removed openclaw/crabfleet:100",
  ]);

  await assert.rejects(service.addRepo({ repo: "openclaw/crabfleet/extra" }, owner), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
  await assert.rejects(service.removeRepo("openclaw/crabfleet/extra", owner), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
  await assert.rejects(service.removeRepo(" ", owner), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
});
