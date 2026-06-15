import assert from "node:assert/strict";
import test from "node:test";

import {
  GitHubReferenceService,
  type GitHubReferenceServiceDependencies,
} from "../src/worker/github-reference-service.ts";

function dependencies(
  fetcher: GitHubReferenceServiceDependencies["fetcher"],
  values: Partial<GitHubReferenceServiceDependencies> = {},
): GitHubReferenceServiceDependencies {
  return {
    readEnabledRepos: async () => ["other/repo", "openclaw/crabfleet"],
    preferredRepo: "openclaw/crabfleet",
    authenticated: false,
    headers: { accept: "application/vnd.github+json" },
    fetcher,
    ...values,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("GitHub reference search rejects invalid numbers before reading repositories", async () => {
  let read = false;
  const service = new GitHubReferenceService(
    dependencies(async () => new Response(null, { status: 500 }), {
      readEnabledRepos: async () => {
        read = true;
        return [];
      },
    }),
  );

  await assert.rejects(service.search("0"), (error) => {
    assert.equal(status(error), 400);
    return true;
  });
  assert.equal(read, false);
});

test("public GitHub reference search uses the preferred repository", async () => {
  const calls: string[] = [];
  const service = new GitHubReferenceService(
    dependencies(async (input) => {
      calls.push(String(input));
      return Response.json({
        number: 42,
        title: "Public issue",
        state: "open",
        html_url: "https://github.com/openclaw/crabfleet/issues/42",
        body: null,
        user: { login: "octocat" },
        updated_at: "2026-06-15T10:00:00Z",
      });
    }),
  );

  assert.deepEqual(await service.search("42"), {
    matches: [
      {
        repo: "openclaw/crabfleet",
        number: 42,
        title: "Public issue",
        source: "Issue",
        state: "open",
        url: "https://github.com/openclaw/crabfleet/issues/42",
        author: "octocat",
        updatedAt: "2026-06-15T10:00:00Z",
        body: "",
      },
    ],
  });
  assert.deepEqual(calls, ["https://api.github.com/repos/openclaw/crabfleet/issues/42"]);
});

test("authenticated GitHub reference search batches and maps enabled repositories", async () => {
  let requestBody: { query?: string; variables?: { number?: number } } = {};
  const service = new GitHubReferenceService(
    dependencies(
      async (_input, init) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          data: {
            r0: {
              issueOrPullRequest: {
                __typename: "PullRequest",
                number: 7,
                title: "Preferred PR",
                state: "OPEN",
                url: "https://github.com/openclaw/crabfleet/pull/7",
                body: "Body",
                author: { login: "maintainer" },
                updatedAt: "2026-06-15T11:00:00Z",
              },
            },
            r1: {
              issueOrPullRequest: {
                __typename: "Issue",
                number: 7,
                title: "Other issue",
                state: "CLOSED",
                url: "https://github.com/other/repo/issues/7",
                body: null,
                author: null,
                updatedAt: "2026-06-15T09:00:00Z",
              },
            },
          },
        });
      },
      { authenticated: true },
    ),
  );

  const result = await service.search(7);
  assert.deepEqual(
    result.matches.map((match) => [match.repo, match.source, match.state]),
    [
      ["openclaw/crabfleet", "PR", "open"],
      ["other/repo", "Issue", "closed"],
    ],
  );
  assert.equal(requestBody.variables?.number, 7);
  assert.match(requestBody.query ?? "", /r0: repository\(owner: "openclaw", name: "crabfleet"\)/);
  assert.match(requestBody.query ?? "", /r1: repository\(owner: "other", name: "repo"\)/);
});

test("GitHub reference search reports transport and GraphQL rate limits", async () => {
  const transport = new GitHubReferenceService(
    dependencies(async () => new Response(null, { status: 429 }), { authenticated: true }),
  );
  await assert.rejects(transport.search(1), (error) => {
    assert.equal(status(error), 503);
    return true;
  });

  const graphql = new GitHubReferenceService(
    dependencies(
      async () =>
        Response.json({
          errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
        }),
      { authenticated: true },
    ),
  );
  await assert.rejects(graphql.search(1), (error) => {
    assert.equal(status(error), 503);
    return true;
  });
});
