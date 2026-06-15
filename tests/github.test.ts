import assert from "node:assert/strict";
import test from "node:test";

import { fetchGithubRepoNodeId, githubNodeBelongsToRepo } from "../src/worker/github.ts";

test("GitHub repository metadata lookup returns the exact node id", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const nodeId = await fetchGithubRepoNodeId(
    "openclaw/crabfleet",
    "github-secret",
    (input, init) => {
      requests.push({ input, init });
      return Promise.resolve(Response.json({ node_id: "R_crabfleet" }));
    },
  );

  assert.equal(nodeId, "R_crabfleet");
  assert.equal(requests[0]?.input, "https://api.github.com/repos/openclaw/crabfleet");
  assert.deepEqual(requests[0]?.init?.headers, {
    accept: "application/vnd.github+json",
    authorization: "Bearer github-secret",
    "user-agent": "crabbox-ai",
    "x-github-api-version": "2022-11-28",
  });
});

test("GitHub node ownership accepts direct and nested repository nodes only", async () => {
  const direct = await githubNodeBelongsToRepo(
    "R_repo",
    "openclaw/crabfleet",
    "github-secret",
    async () =>
      Response.json({
        data: { node: { owner: { login: "OpenClaw" }, name: "Crabfleet" } },
      }),
  );
  const nested = await githubNodeBelongsToRepo(
    "PR_repo",
    "openclaw/crabfleet",
    "github-secret",
    async () =>
      Response.json({
        data: {
          node: {
            repository: { owner: { login: "openclaw" }, name: "crabfleet" },
          },
        },
      }),
  );
  const other = await githubNodeBelongsToRepo(
    "R_other",
    "openclaw/crabfleet",
    "github-secret",
    async () =>
      Response.json({
        data: { node: { owner: { login: "openclaw" }, name: "agent-scripts" } },
      }),
  );
  const errors = await githubNodeBelongsToRepo(
    "R_repo",
    "openclaw/crabfleet",
    "github-secret",
    async () => Response.json({ errors: [{ message: "denied" }] }),
  );

  assert.equal(direct, true);
  assert.equal(nested, true);
  assert.equal(other, false);
  assert.equal(errors, false);
});
