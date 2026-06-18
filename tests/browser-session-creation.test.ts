import assert from "node:assert/strict";
import test from "node:test";

import {
  BrowserSessionCreationService,
  type BrowserSessionCreationStore,
} from "../src/worker/browser-session-creation.ts";
import type { User } from "../src/worker/models.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const githubUser: User = {
  subject: "github:42",
  login: "operator",
  email: null,
  name: "Operator",
  role: "maintainer",
  allowed: true,
  teams: [],
};

const proxyUser: User = {
  ...githubUser,
  subject: "proxy:operator@example.com",
  login: null,
  email: "operator@example.com",
};

function store(
  calls: string[],
  token: string | null = "github-token",
): BrowserSessionCreationStore {
  return {
    async readGitHubToken(_request, user) {
      calls.push(`token:${user.subject}`);
      return token ?? undefined;
    },
    async createSession(user, input, githubToken) {
      calls.push(`create:${user.subject}:${input.repo}:${githubToken ?? "none"}`);
      return interactiveSession(
        sessionRow({
          owner: user.subject,
          created_by: user.subject,
          repo: input.repo,
        }),
        [],
      );
    },
  };
}

function request(body: string): Request {
  return new Request("https://fleet.example/api/interactive-sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("GitHub browser sessions require and forward the session credential", async () => {
  const calls: string[] = [];
  const result = await new BrowserSessionCreationService(store(calls)).create(
    request('{"repo":"openclaw/crabfleet"}'),
    githubUser,
  );

  assert.equal(result.session.owner, githubUser.subject);
  assert.deepEqual(calls, ["token:github:42", "create:github:42:openclaw/crabfleet:github-token"]);
});

test("trusted proxy browser sessions do not request GitHub credentials", async () => {
  const calls: string[] = [];
  const result = await new BrowserSessionCreationService(store(calls)).create(
    request('{"repo":"openclaw/crabfleet"}'),
    proxyUser,
  );

  assert.equal(result.session.owner, proxyUser.subject);
  assert.deepEqual(calls, ["create:proxy:operator@example.com:openclaw/crabfleet:none"]);
});

test("GitHub browser sessions fail before creation when credentials are missing", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () =>
      new BrowserSessionCreationService(store(calls, null)).create(
        request('{"repo":"openclaw/crabfleet"}'),
        githubUser,
      ),
    (error) => {
      assert.equal(status(error), 403);
      assert.match(String(error), /GitHub PR credentials are not connected/);
      return true;
    },
  );
  assert.deepEqual(calls, ["token:github:42"]);
});

test("invalid browser session JSON fails before credential lookup", async () => {
  const calls: string[] = [];
  await assert.rejects(
    () => new BrowserSessionCreationService(store(calls)).create(request("{"), githubUser),
    (error) => {
      assert.equal(status(error), 400);
      return true;
    },
  );
  assert.deepEqual(calls, []);
});
