import assert from "node:assert/strict";
import test from "node:test";

import type { TrustedProxyAuthResult } from "../src/trusted-proxy-auth.ts";
import {
  handlePublicAuthRoute,
  handleSessionAuthRoute,
  type PublicAuthRouteDependencies,
} from "../src/worker/routes/auth.ts";
import type { User } from "../src/worker/models.ts";

const requestAuth: TrustedProxyAuthResult = { kind: "disabled" };

function response(name: string): Response {
  return new Response(name, { headers: { "x-handler": name } });
}

function dependencies(calls: string[]): PublicAuthRouteDependencies {
  return {
    async githubLogin() {
      calls.push("github-login");
      return response("github-login");
    },
    async githubCallback() {
      calls.push("github-callback");
      return response("github-callback");
    },
    async sshLink(_request, code, auth) {
      calls.push(`ssh-link:${code}:${auth.kind}`);
      return response("ssh-link");
    },
    async nativeLink(_request, code, auth) {
      calls.push(`native-link:${code}:${auth.kind}`);
      return response("native-link");
    },
    async tokenLogin() {
      calls.push("token-login");
      return response("token-login");
    },
    async devIdentityLogin() {
      calls.push("dev-login");
      return response("dev-login");
    },
    async logout() {
      calls.push("logout");
      return response("logout");
    },
    authState() {
      calls.push("auth-state");
      return response("auth-state");
    },
  };
}

test("public auth routes dispatch exact paths and methods", async () => {
  const cases: Array<[string, string, string]> = [
    ["GET", "/login/github", "github-login"],
    ["GET", "/auth/github/callback", "github-callback"],
    ["POST", "/ssh/link/code%2Fvalue", "ssh-link"],
    ["GET", "/native/link/code%2Fvalue", "native-link"],
    ["POST", "/api/login/token", "token-login"],
    ["POST", "/api/login/dev", "dev-login"],
    ["POST", "/api/logout", "logout"],
    ["GET", "/api/auth", "auth-state"],
  ];

  for (const [method, path, expected] of cases) {
    const calls: string[] = [];
    const request = new Request(`https://fleet.example${path}`, { method });
    const result = await handlePublicAuthRoute(
      request,
      new URL(request.url),
      requestAuth,
      dependencies(calls),
    );

    assert.equal(result?.headers.get("x-handler"), expected);
    assert.equal(calls.length, 1);
    if (expected === "ssh-link" || expected === "native-link") {
      assert.equal(calls[0], `${expected}:code/value:disabled`);
    } else {
      assert.equal(calls[0], expected);
    }
  }
});

test("public auth routes fall through on inexact methods and paths", async () => {
  const calls: string[] = [];
  const deps = dependencies(calls);
  const requests = [
    new Request("https://fleet.example/api/login/token"),
    new Request("https://fleet.example/api/auth", { method: "POST" }),
    new Request("https://fleet.example/ssh/link/code", { method: "DELETE" }),
    new Request("https://fleet.example/api/session"),
  ];

  for (const request of requests) {
    assert.equal(
      await handlePublicAuthRoute(request, new URL(request.url), requestAuth, deps),
      null,
    );
  }
  assert.deepEqual(calls, []);
});

test("authenticated session metadata has one exact route", () => {
  const user: User = {
    subject: "github:42",
    login: "owner",
    email: null,
    name: "Owner",
    role: "owner",
    allowed: true,
    teams: [],
  };
  const calls: string[] = [];
  const dependencies = {
    sessionState(_request: Request, authenticatedUser: User) {
      calls.push(authenticatedUser.subject);
      return response("session");
    },
  };
  const get = new Request("https://fleet.example/api/session");
  const post = new Request("https://fleet.example/api/session", { method: "POST" });

  assert.equal(
    handleSessionAuthRoute(get, new URL(get.url), user, dependencies)?.headers.get("x-handler"),
    "session",
  );
  assert.equal(handleSessionAuthRoute(post, new URL(post.url), user, dependencies), null);
  assert.deepEqual(calls, ["github:42"]);
});
