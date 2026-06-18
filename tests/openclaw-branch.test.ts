import assert from "node:assert/strict";
import test from "node:test";

import { OpenClawBranchService } from "../src/worker/openclaw-branch.ts";
import { GitHubApiError, type Fetcher } from "../src/worker/github.ts";

type RequestRecord = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

function branchService(
  fetcher: Fetcher,
  overrides: { token?: string; repos?: string[] } = {},
): { service: OpenClawBranchService; repos: string[] } {
  const repos = overrides.repos ?? [];
  return {
    repos,
    service: new OpenClawBranchService({
      token: overrides.token ?? "github-token",
      requireRepo: async (repo) => {
        repos.push(repo);
      },
      fetcher,
    }),
  };
}

test("OpenClaw branch preparation validates and authorizes before transport", async () => {
  let requests = 0;
  const { service, repos } = branchService(async () => {
    requests += 1;
    return Response.json({ object: { sha: "target-sha" } });
  });

  await service.ensure("OpenClaw/Crabfleet", "main", "main");
  assert.deepEqual(repos, ["openclaw/crabfleet"]);
  assert.equal(requests, 0);

  await assert.rejects(service.ensure("not-a-repo", "main", "base"), {
    message: "repo must be a GitHub owner/name",
  });
  await assert.rejects(service.ensure("openclaw/crabfleet", "bad branch", "base"), {
    message: "branch must be a valid Git branch of at most 120 characters",
  });
});

test("OpenClaw branch preparation stops after an existing target ref", async () => {
  const requests: RequestRecord[] = [];
  const { service } = branchService(async (input, init) => {
    requests.push({ input, init });
    return Response.json({ object: { sha: "target-sha" } });
  });

  await service.ensure("openclaw/crabfleet", "feature/room", "main");

  assert.equal(requests.length, 1);
  assert.equal(
    requests[0]?.input,
    "https://api.github.com/repos/openclaw/crabfleet/git/ref/heads/feature%2Froom",
  );
  assert.equal(requests[0]?.init?.headers && "authorization" in requests[0].init.headers, true);
});

test("OpenClaw branch preparation creates a missing target from the base ref", async () => {
  const requests: RequestRecord[] = [];
  const { service } = branchService(async (input, init) => {
    requests.push({ input, init });
    const url = String(input);
    if (url.endsWith("/git/ref/heads/feature%2Froom")) {
      return new Response(null, { status: 404 });
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "base-sha" } });
    }
    return new Response(null, { status: 201 });
  });

  await service.ensure("openclaw/crabfleet", "feature/room", "main");

  assert.equal(requests.length, 3);
  assert.equal(requests[2]?.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(requests[2]?.init?.body)), {
    ref: "refs/heads/feature/room",
    sha: "base-sha",
  });
});

test("OpenClaw branch creation accepts a concurrent 422 only after rereading the target", async () => {
  let targetReads = 0;
  const { service } = branchService(async (input, init) => {
    const url = String(input);
    if (url.endsWith("/git/ref/heads/feature%2Frace")) {
      targetReads += 1;
      return targetReads === 1
        ? new Response(null, { status: 404 })
        : Response.json({ object: { sha: "winner-sha" } });
    }
    if (url.endsWith("/git/ref/heads/main")) {
      return Response.json({ object: { sha: "base-sha" } });
    }
    assert.equal(init?.method, "POST");
    return new Response(null, { status: 422 });
  });

  await service.ensure("openclaw/crabfleet", "feature/race", "main");
  assert.equal(targetReads, 2);
});

test("OpenClaw branch preparation propagates non-race GitHub failures", async () => {
  const { service } = branchService(async () => new Response(null, { status: 401 }));

  await assert.rejects(service.ensure("openclaw/crabfleet", "feature/room", "main"), (error) => {
    assert.equal((error as GitHubApiError).status, 401);
    return true;
  });
});

test("OpenClaw branch preparation does not call GitHub without a configured token", async () => {
  let requests = 0;
  const { service, repos } = branchService(
    async () => {
      requests += 1;
      return new Response(null, { status: 500 });
    },
    { token: "" },
  );

  await service.ensure("openclaw/crabfleet", "feature/room", "main");
  assert.deepEqual(repos, ["openclaw/crabfleet"]);
  assert.equal(requests, 0);
});
