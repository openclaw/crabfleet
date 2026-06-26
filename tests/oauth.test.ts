import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  githubOAuthCallbackRequestMatches,
  githubOAuthCanonicalLoginUrl,
  githubOAuthCanonicalNativeLinkUrl,
  githubOAuthCanonicalSshLinkUrl,
  githubOAuthRedirectUri,
} from "../src/oauth.ts";
import { githubCallback, githubLogin } from "../src/worker/github-auth.ts";
import {
  refreshGitHubUser,
  refreshGitHubUserWithEvidence,
  type Fetcher,
} from "../src/worker/github.ts";
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
  const source = await readFile(new URL("../src/worker/ssh-gateway.ts", import.meta.url), "utf8");
  const linkStart = source.indexOf("async link(");
  const linkEnd = source.indexOf("async authenticate(", linkStart);
  const linkSource = source.slice(linkStart, linkEnd);
  assert.match(linkSource, /githubOAuthCanonicalSshLinkUrl/);
  assert.ok(linkSource.indexOf("canonicalLinkUrl") < linkSource.indexOf("sshLinkCookie"));
  assert.match(linkSource, /redirect\("\/login\/github\?flow=ssh"/);
});

test("native link state canonicalizes to the authoritative OAuth origin", () => {
  const configured = "https://fleet.example/auth/github/callback";
  assert.equal(
    githubOAuthCanonicalNativeLinkUrl(
      "https://alias.example/native/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    "https://fleet.example/native/link/code%2Fwith%2Fslashes",
  );
  assert.equal(
    githubOAuthCanonicalNativeLinkUrl(
      "https://fleet.example/native/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    null,
  );
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

test("OAuth state binds the intended link flow instead of stale competing cookies", async () => {
  const env = {
    DB: oauthDatabase(),
    GITHUB_CLIENT_ID: "client-id",
    GITHUB_CLIENT_SECRET: "client-secret",
    GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
  } as RuntimeEnv;
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "github.com") return Response.json({ access_token: "github-token" });
    if (url.pathname.endsWith("/user/emails") || url.pathname.endsWith("/user/teams")) {
      return Response.json([]);
    }
    if (url.pathname.includes("/memberships/orgs/")) {
      return Response.json({ state: "active" });
    }
    return Response.json({ id: 42, login: "owner", email: null, name: "Owner" });
  };

  for (const { query, pendingCookies, expected } of [
    {
      query: "?flow=native",
      pendingCookies: "crabbox_ssh_link=stale-ssh; crabbox_native_link=new-native",
      expected: "/native/link/new-native",
    },
    {
      query: "?flow=ssh",
      pendingCookies: "crabbox_ssh_link=new-ssh; crabbox_native_link=stale-native",
      expected: "/ssh/link/new-ssh",
    },
    {
      query: "",
      pendingCookies: "crabbox_ssh_link=stale-ssh; crabbox_native_link=stale-native",
      expected: "/app?login=github",
    },
  ]) {
    const login = await githubLogin(
      new Request(`https://fleet.example/login/github${query}`, {
        headers: { cookie: pendingCookies },
      }),
      env,
    );
    const authorize = new URL(login.headers.get("location") ?? "");
    const state = authorize.searchParams.get("state");
    const stateCookie = login.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(state);
    assert.ok(stateCookie);
    assert.equal(state.includes("new-native"), false);
    assert.equal(state.includes("new-ssh"), false);

    const callback = await githubCallback(
      new Request(
        `https://fleet.example/auth/github/callback?code=code&state=${encodeURIComponent(state)}`,
        { headers: { cookie: `${stateCookie}; ${pendingCookies}` } },
      ),
      env,
      fetcher,
    );
    assert.equal(callback.status, 302);
    assert.equal(callback.headers.get("location"), expected);
  }
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

test("GitHub membership refresh reports incomplete email evidence without breaking callers", async () => {
  const fetcher: Fetcher = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/user/emails")) {
      return new Response("unavailable", { status: 503 });
    }
    if (url.pathname.endsWith("/user/teams")) return Response.json([]);
    if (url.pathname.includes("/memberships/orgs/")) {
      return Response.json({ state: "active" });
    }
    return Response.json({ id: 42, login: "Owner", email: null, name: "Owner Name" });
  };
  const env = { GITHUB_ORG: "OpenClaw" } as RuntimeEnv;

  const evidence = await refreshGitHubUserWithEvidence(env, "token", fetcher);
  assert.equal(evidence.emailLookupComplete, false);
  assert.equal(evidence.user?.subject, "github:42");
  assert.equal(evidence.user?.email, null);
  assert.deepEqual(await refreshGitHubUser(env, "token", fetcher), evidence.user);
});

function oauthDatabase(): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              return {
                results: /from "allow_entries"/iu.test(sql)
                  ? [{ value: "@owner", role: "viewer" }]
                  : [],
                meta: { changes: 0 },
              };
            },
            async run() {
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}
