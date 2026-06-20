import assert from "node:assert/strict";
import test from "node:test";

import { GitHubApiError } from "../src/worker/github.ts";
import {
  OpenClawCreateService,
  openClawOwner,
  openClawServiceBranch,
  type OpenClawCreateStore,
} from "../src/worker/openclaw-create.ts";
import { openClawCrabboxRequestHash } from "../src/worker/openclaw-request.ts";
import type { InteractiveSession } from "../src/worker/session-model.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function session(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(sessionRow(values), []);
}

function activeSignal(): AbortSignal {
  return new AbortController().signal;
}

function createStore(overrides: Partial<OpenClawCreateStore> = {}): OpenClawCreateStore {
  return {
    defaultRuntime: "container",
    now: () => 100,
    preparationSignal: activeSignal,
    readRequestSession: async () => null,
    resolvePrincipal: async (value) =>
      value
        ? {
            subject: "github:42",
            principal: `@${openClawOwner(value)}`,
            actor: openClawOwner(value),
          }
        : null,
    prepareBranch: async () => undefined,
    createSession: async () => session(),
    audit: async () => undefined,
    warn: () => undefined,
    ...overrides,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("OpenClaw create normalizes owner and exact Git branch inputs", () => {
  assert.equal(openClawOwner("@maintainer"), "maintainer");
  assert.equal(openClawOwner("github:maintainer"), "maintainer");
  assert.equal(openClawOwner("team owner"), "team owner");
  assert.throws(() => openClawOwner(""), { message: "owner is required" });

  assert.equal(openClawServiceBranch(undefined, "branch", "main"), "main");
  assert.equal(openClawServiceBranch("feature/team-room", "branch"), "feature/team-room");
  assert.throws(() => openClawServiceBranch("feature//team-room", "branch"), {
    message: "branch must be a valid Git branch of at most 120 characters",
  });
});

test("OpenClaw create replays an already-decorated session without creation or audit", async () => {
  const replay = session({ id: "IS-7", attach_url: "/api/terminal/ws" });
  const calls: string[] = [];
  const service = new OpenClawCreateService(
    createStore({
      readRequestSession: async (requestId) => {
        calls.push(`replay:${requestId}`);
        return replay;
      },
      createSession: async () => {
        calls.push("create");
        return session();
      },
      audit: async () => {
        calls.push("audit");
      },
    }),
  );

  const result = await service.create({
    owner: "@maintainer",
    repo: "openclaw/crabfleet",
    branch: "main",
    requestId: "request-1",
  });

  assert.equal(result, replay);
  assert.deepEqual(calls, ["replay:request-1"]);
});

test("OpenClaw create prepares the branch after reservation and before provisioning", async () => {
  const created = session({ id: "IS-8", attach_url: "/api/terminal/ws" });
  const calls: string[] = [];
  let receivedBranch = "";
  let receivedBaseBranch: string | undefined;
  let receivedToken: string | undefined;
  const service = new OpenClawCreateService(
    createStore({
      prepareBranch: async (_repo, branch, baseBranch) => {
        calls.push("prepare");
        receivedBranch = String(branch);
        receivedBaseBranch = baseBranch as string | undefined;
      },
      createSession: async (body, githubToken, options) => {
        calls.push("reserve");
        receivedToken = githubToken;
        assert.equal(options.owner, "maintainer");
        assert.equal(options.ownerSubject, "github:42");
        assert.equal(options.createdBy, "service:openclaw");
        await options.afterReserve();
        calls.push("provision");
        assert.equal(body.branch, "main");
        return created;
      },
      audit: async (message, now) => {
        calls.push(`audit:${now}`);
        assert.equal(message, "openclaw crabbox created IS-8 owner=maintainer");
      },
    }),
  );

  const result = await service.create({
    owner: "github:maintainer",
    repo: "openclaw/crabfleet",
    githubToken: " token ",
  });

  assert.equal(result, created);
  assert.equal(receivedBranch, "main");
  assert.equal(receivedBaseBranch, undefined);
  assert.equal(receivedToken, "token");
  assert.deepEqual(calls, ["reserve", "prepare", "provision", "audit:100"]);
});

test("OpenClaw creation binds the requested owner to a stable subject", async () => {
  let created = false;
  const service = new OpenClawCreateService(
    createStore({
      resolvePrincipal: async (value) =>
        value === "maintainer"
          ? { subject: "github:42", principal: "@maintainer", actor: "maintainer" }
          : null,
      createSession: async (_body, _token, options) => {
        created = true;
        assert.equal(options.owner, "maintainer");
        assert.equal(options.ownerSubject, "github:42");
        return session({ id: "IS-private" });
      },
    }),
  );

  assert.equal(
    (await service.create({ owner: "maintainer", repo: "openclaw/crabfleet" })).id,
    "IS-private",
  );
  assert.equal(created, true);

  await assert.rejects(
    new OpenClawCreateService(createStore({ resolvePrincipal: async () => null })).create({
      owner: "missing",
      repo: "openclaw/crabfleet",
    }),
    { message: "owner must identify one active Crabfleet user" },
  );
});

test("OpenClaw resolves a raw stable subject before normalizing its display owner", async () => {
  const resolved: string[] = [];
  let replayHash = "";
  const service = new OpenClawCreateService(
    createStore({
      resolvePrincipal: async (value) => {
        resolved.push(value);
        return value === "github:42"
          ? { subject: "github:42", principal: "@maintainer", actor: "maintainer" }
          : null;
      },
      readRequestSession: async (_requestId, requestHash) => {
        replayHash = requestHash;
        return null;
      },
      createSession: async (_body, _token, options) => {
        assert.equal(options.ownerSubject, "github:42");
        return session({ id: "IS-subject" });
      },
    }),
  );

  assert.equal(
    (
      await service.create({
        owner: "github:42",
        repo: "openclaw/crabfleet",
        requestId: "stable-owner",
      })
    ).id,
    "IS-subject",
  );
  assert.deepEqual(resolved, ["github:42"]);
  assert.equal(
    replayHash,
    await openClawCrabboxRequestHash(
      { repo: "openclaw/crabfleet", branch: "main" },
      "github:42",
      "container",
    ),
  );
});

test("OpenClaw replay identity uses the stable owner subject", async () => {
  let requestHash = "";
  const service = new OpenClawCreateService(
    createStore({
      resolvePrincipal: async () => ({
        subject: "github:42",
        principal: "@maintainer",
        actor: "maintainer",
      }),
      readRequestSession: async (_requestId, hash) => {
        requestHash = hash;
        return null;
      },
    }),
  );

  await service.create({
    owner: "maintainer",
    repo: "openclaw/crabfleet",
    requestId: "shared-owner",
  });
  assert.equal(
    requestHash,
    await openClawCrabboxRequestHash(
      { repo: "openclaw/crabfleet", branch: "main" },
      "github:42",
      "container",
    ),
  );
});

test("OpenClaw create defers masked branch permissions but reports timeouts", async () => {
  const warnings: Array<Record<string, unknown>> = [];
  const deferred = new OpenClawCreateService(
    createStore({
      prepareBranch: async () => {
        throw new GitHubApiError(403);
      },
      createSession: async (_body, _token, options) => {
        await options.afterReserve();
        return session({ id: "IS-9" });
      },
      warn: (event) => warnings.push(event),
    }),
  );

  assert.equal(
    (
      await deferred.create({
        owner: "maintainer",
        repo: "OpenClaw/Crabfleet",
        branch: "feature/room",
      })
    ).id,
    "IS-9",
  );
  assert.deepEqual(warnings, [
    {
      event: "openclaw_branch_preparation_deferred",
      repo: "openclaw/crabfleet",
      branch: "feature/room",
      status: 403,
    },
  ]);

  const controller = new AbortController();
  controller.abort();
  const timedOut = new OpenClawCreateService(
    createStore({
      preparationSignal: () => controller.signal,
      prepareBranch: async () => {
        throw new GitHubApiError(403);
      },
      createSession: async (_body, _token, options) => {
        await options.afterReserve();
        return session();
      },
    }),
  );
  await assert.rejects(
    timedOut.create({ owner: "maintainer", repo: "openclaw/crabfleet" }),
    (error) => {
      assert.equal(status(error), 503);
      assert.equal((error as Error).message, "OpenClaw branch preparation timed out");
      return true;
    },
  );
});

test("OpenClaw create propagates non-deferred branch failures without audit", async () => {
  let audited = false;
  const service = new OpenClawCreateService(
    createStore({
      prepareBranch: async () => {
        throw new GitHubApiError(401);
      },
      createSession: async (_body, _token, options) => {
        await options.afterReserve();
        return session();
      },
      audit: async () => {
        audited = true;
      },
    }),
  );

  await assert.rejects(
    service.create({ owner: "maintainer", repo: "openclaw/crabfleet" }),
    (error) => {
      assert.equal((error as GitHubApiError).status, 401);
      return true;
    },
  );
  assert.equal(audited, false);
});
