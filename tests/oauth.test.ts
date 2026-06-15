import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  githubOAuthCallbackRequestMatches,
  githubOAuthCanonicalLoginUrl,
  githubOAuthCanonicalSshLinkUrl,
  githubOAuthRedirectUri,
} from "../src/oauth.ts";
import { githubCallback, githubLogin } from "../src/worker/github-auth.ts";
import { refreshGitHubUser, type Fetcher } from "../src/worker/github.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

test("githubOAuthRedirectUri uses configured callback when present", () => {
  assert.equal(
    githubOAuthRedirectUri(
      "https://crabfleet.openclaw.ai/login/github",
      "https://fleet.example/auth/github/callback",
    ),
    "https://fleet.example/auth/github/callback",
  );
});

test("githubOAuthRedirectUri defaults to request origin callback", () => {
  assert.equal(
    githubOAuthRedirectUri("https://crabfleet.openclaw.ai/login/github"),
    "https://crabfleet.openclaw.ai/auth/github/callback",
  );
  assert.equal(
    githubOAuthRedirectUri("http://localhost:8787/login/github"),
    "http://localhost:8787/auth/github/callback",
  );
  assert.throws(
    () => githubOAuthRedirectUri("http://attacker.example/login/github"),
    /HTTPS or loopback HTTP/,
  );
});

test("configured GitHub callback validation fails closed", () => {
  for (const configured of [
    "",
    " https://fleet.example/auth/github/callback",
    "http://fleet.example/auth/github/callback",
    "https:fleet.example/auth/github/callback",
    "https://user:secret@fleet.example/auth/github/callback",
    "https://@fleet.example/auth/github/callback",
    "https://fleet.example/auth/github/call back",
    "https://fleet.example/auth/github/callback?tenant=a",
    "https://fleet.example/auth/github/callback#fragment",
    "https://fleet.example/auth/github/callback/",
    "https://fleet.example/other/callback",
    "/auth/github/callback",
  ]) {
    assert.throws(
      () => githubOAuthRedirectUri("https://request.example/login/github", configured),
      /GITHUB_REDIRECT_URI/,
      configured,
    );
  }
});

test("configured GitHub origin is authoritative across host mismatches", () => {
  const configured = "https://fleet.example/auth/github/callback";
  assert.equal(
    githubOAuthCanonicalLoginUrl("https://attacker.example/login/github", configured),
    "https://fleet.example/login/github",
  );
  assert.equal(
    githubOAuthCanonicalLoginUrl("https://fleet.example/login/github", configured),
    null,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://fleet.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    true,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://attacker.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    false,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "http://fleet.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    false,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://fleet.example/login/github?code=a&state=b",
      configured,
    ),
    false,
  );
});

test("SSH link state canonicalizes before host-only OAuth cookies", async () => {
  const configured = "https://fleet.example/auth/github/callback";
  assert.equal(
    githubOAuthCanonicalSshLinkUrl(
      "https://alias.example/ssh/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    "https://fleet.example/ssh/link/code%2Fwith%2Fslashes",
  );
  assert.equal(
    githubOAuthCanonicalSshLinkUrl(
      "https://fleet.example/ssh/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    null,
  );
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const linkStart = source.indexOf("async function sshLink(");
  const linkEnd = source.indexOf("async function consumeSshLink", linkStart);
  const linkSource = source.slice(linkStart, linkEnd);
  assert.match(linkSource, /githubOAuthCanonicalSshLinkUrl/);
  assert.ok(linkSource.indexOf("canonicalLinkUrl") < linkSource.indexOf("sshLinkCookie"));
});

test("OAuth initiation and token exchange share the authoritative callback", async () => {
  const env = {
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
  } as RuntimeEnv;

  const canonical = await githubLogin(new Request("https://alias.example/login/github"), env);
  assert.equal(canonical.headers.get("location"), "https://fleet.example/login/github");

  const login = await githubLogin(new Request("https://fleet.example/login/github"), env);
  const authorizeUrl = new URL(login.headers.get("location") ?? "");
  assert.equal(authorizeUrl.origin, "https://github.com");
  assert.equal(
    authorizeUrl.searchParams.get("redirect_uri"),
    "https://fleet.example/auth/github/callback",
  );
  assert.match(login.headers.get("set-cookie") ?? "", /^crabbox_oauth_state=/);

  let exchangeCalls = 0;
  let exchangeBody: Record<string, unknown> | undefined;
  const fetcher: Fetcher = async (_input, init) => {
    exchangeCalls += 1;
    exchangeBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ error: "denied" }, { status: 401 });
  };
  const rejected = await githubCallback(
    new Request("https://alias.example/auth/github/callback?code=code&state=state", {
      headers: { cookie: "crabbox_oauth_state=state" },
    }),
    env,
    fetcher,
  );
  assert.equal(rejected.status, 400);
  assert.equal(exchangeCalls, 0);

  const callback = await githubCallback(
    new Request("https://fleet.example/auth/github/callback?code=code&state=state", {
      headers: { cookie: "crabbox_oauth_state=state" },
    }),
    env,
    fetcher,
  );
  assert.equal(callback.status, 401);
  assert.equal(exchangeCalls, 1);
  assert.equal(exchangeBody?.redirect_uri, "https://fleet.example/auth/github/callback");
});

test("GitHub membership refresh builds one normalized organization identity", async () => {
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    const payload = url.pathname.endsWith("/user/emails")
      ? [{ email: "owner@example.com", primary: true, verified: true }]
      : url.pathname.endsWith("/user/teams")
        ? [
            { slug: "core", organization: { login: "OpenClaw" } },
            { slug: "other", organization: { login: "Elsewhere" } },
          ]
        : url.pathname.includes("/memberships/orgs/")
          ? { state: "active" }
          : { id: 42, login: "Owner", email: null, name: "Owner Name" };
    return Response.json(payload);
  };

  assert.deepEqual(
    await refreshGitHubUser({ GITHUB_ORG: "OpenClaw" } as RuntimeEnv, "token", fetcher),
    {
      subject: "github:42",
      login: "Owner",
      email: "owner@example.com",
      name: "Owner Name",
      role: "viewer",
      allowed: false,
      teams: ["@OpenClaw/core"],
    },
  );
});
