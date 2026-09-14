import assert from "node:assert/strict";
import test from "node:test";

import type { TrustedProxyAuthResult } from "../src/trusted-proxy-auth.ts";
import { sealSecret } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { User } from "../src/worker/models.ts";
import type {
  NativeAuthService,
  NativeDeviceAuthorizationRecord,
} from "../src/worker/native-auth.ts";
import { handleNativeLink } from "../src/worker/native-link.ts";
import { connectorAccessScope } from "../src/worker/native-auth.ts";

const link: NativeDeviceAuthorizationRecord = {
  deviceCodeHash: "device-hash",
  linkCodeHash: "link-hash",
  clientName: "Peter's Mac",
  remoteIp: null,
  subject: null,
  accessTokenHash: null,
  accessTokenCiphertext: null,
  accessTokenExpiresAt: null,
  expiresAt: Date.now() + 60_000,
  nextPollAt: Date.now() + 5_000,
  approvedAt: null,
  consumedAt: null,
  createdAt: Date.now(),
};

function d1(user: User, githubTokenCiphertext: string | null = null): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind() {
          return {
            async all() {
              if (/from "allow_entries"/i.test(sql)) {
                return {
                  results: [
                    {
                      value: user.login ? `@${user.login}` : user.email,
                      role: user.role,
                    },
                  ],
                  meta: { changes: 0 },
                };
              }
              if (/from "sessions"/i.test(sql) && !/from "sessions" as "s"/i.test(sql)) {
                return {
                  results: [{ github_token_ciphertext: githubTokenCiphertext }],
                  meta: { changes: 0 },
                };
              }
              if (/from "sessions" as "s"/i.test(sql) || /from "users"/i.test(sql)) {
                return {
                  results: [{ ...user, allowed: 1, teams: JSON.stringify(user.teams) }],
                  meta: { changes: 0 },
                };
              }
              throw new Error(`unexpected query: ${sql}`);
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

function service(approvals: string[], record = link): NativeAuthService {
  return {
    async link() {
      return record;
    },
    async approve(_code: string, user: User, githubToken?: string) {
      approvals.push(`${user.subject}:${githubToken ?? ""}`);
      return { clientName: link.clientName };
    },
  } as unknown as NativeAuthService;
}

test("trusted-proxy native approval uses asserted identity and exact Origin without cookies", async () => {
  const user: User = {
    subject: "proxy:viewer@example.com",
    login: null,
    email: "viewer@example.com",
    name: "viewer@example.com",
    role: "viewer",
    allowed: true,
    teams: [],
  };
  const env = {
    DB: d1(user),
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
    CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
    CRABFLEET_TRUSTED_PROXY_SECRET: "proxy-secret",
    CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "viewer",
    GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
  } as RuntimeEnv;
  const requestAuth: TrustedProxyAuthResult = {
    kind: "authenticated",
    identity: {
      subject: user.subject,
      identity: user.email!,
      login: null,
      email: user.email,
      name: user.name!,
    },
  };
  const approvals: string[] = [];
  const authService = service(approvals);
  const get = await handleNativeLink(
    new Request("https://backend.example/native/link/link-code"),
    "link-code",
    requestAuth,
    env,
    authService,
  );
  assert.equal(get.status, 200);
  assert.equal(get.headers.has("set-cookie"), false);
  assert.match(get.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(get.headers.get("referrer-policy"), "same-origin");
  assert.equal(get.headers.get("x-frame-options"), "DENY");
  const csrf = (await get.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  assert.ok(csrf);

  const connectorPage = await handleNativeLink(
    new Request("https://backend.example/native/link/link-code"),
    "link-code",
    requestAuth,
    env,
    service([], { ...link, clientName: "Linux fixture", scope: connectorAccessScope }),
  );
  const connectorHtml = await connectorPage.text();
  assert.match(connectorHtml, /Authorize Crabfleet Connect/);
  assert.match(connectorHtml, /publish and manage your shared desktops/);
  assert.match(connectorHtml, /renew this authorization/);
  assert.match(connectorHtml, /Desktop capture and control still require permission/);
  assert.doesNotMatch(connectorHtml, /read your visible Crabfleet sessions for 24 hours/);

  const post = await handleNativeLink(
    new Request("https://backend.example/native/link/link-code", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "https://fleet.example",
      },
      body: new URLSearchParams({ csrf }),
    }),
    "link-code",
    requestAuth,
    env,
    authService,
  );
  assert.equal(post.status, 200);
  assert.match(post.headers.get("content-security-policy") ?? "", /form-action 'self'/);
  assert.equal(post.headers.get("x-frame-options"), "DENY");
  assert.deepEqual(approvals, [`${user.subject}:`]);

  await assert.rejects(
    handleNativeLink(
      new Request("https://backend.example/native/link/link-code", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://fleet.example",
        },
        body: new URLSearchParams({ csrf: "x".repeat(2_000) }),
      }),
      "link-code",
      requestAuth,
      env,
      authService,
    ),
    (error) => httpStatus(error) === 413,
  );

  await assert.rejects(
    handleNativeLink(
      new Request("https://backend.example/native/link/link-code", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "https://attacker.example",
        },
        body: new URLSearchParams({ csrf }),
      }),
      "link-code",
      requestAuth,
      env,
      authService,
    ),
    (error) => httpStatus(error) === 403,
  );
});

test("trusted-proxy native links redirect when the OAuth callback has a distinct origin", async () => {
  const user: User = {
    subject: "proxy:viewer@example.com",
    login: null,
    email: "viewer@example.com",
    name: "viewer@example.com",
    role: "viewer",
    allowed: true,
    teams: [],
  };
  const response = await handleNativeLink(
    new Request("https://backend.example/native/link/link-code"),
    "link-code",
    {
      kind: "authenticated",
      identity: {
        subject: user.subject,
        identity: user.email!,
        login: null,
        email: user.email,
        name: user.name!,
      },
    },
    {
      DB: d1(user),
      CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
      CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://public.example",
      CRABFLEET_TRUSTED_PROXY_SECRET: "proxy-secret",
      CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "viewer",
      GITHUB_REDIRECT_URI: "https://callback.example/auth/github/callback",
    } as RuntimeEnv,
    {
      async link() {
        throw new Error("link lookup must not run before canonicalization");
      },
    } as unknown as NativeAuthService,
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://callback.example/native/link/link-code");
  assert.equal(response.headers.has("set-cookie"), false);
});

test("unauthenticated native links mark the intended OAuth return flow", async () => {
  const user: User = {
    subject: "github:1",
    login: "viewer",
    email: null,
    name: "Viewer",
    role: "viewer",
    allowed: true,
    teams: [],
  };
  const response = await handleNativeLink(
    new Request("https://fleet.example/native/link/link-code"),
    "link-code",
    { kind: "disabled" },
    {
      DB: d1(user),
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
    } as RuntimeEnv,
    service([]),
  );

  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/login/github?flow=native");
  assert.match(response.headers.get("set-cookie") ?? "", /^crabbox_native_link=link-code;/);
});

test("cookie sessions require the link-bound CSRF cookie", async () => {
  const user: User = {
    subject: "github:1",
    login: "viewer",
    email: null,
    name: "Viewer",
    role: "viewer",
    allowed: true,
    teams: [],
  };
  const cryptoEnv = {
    CRABBOX_TOKEN_ENCRYPTION_KEY: "native-link-test-key",
  } as RuntimeEnv;
  const githubTokenCiphertext = await sealSecret(cryptoEnv, "github-token");
  assert.ok(githubTokenCiphertext);
  const env = {
    DB: d1(user, githubTokenCiphertext),
    CRABFLEET_CANONICAL_URL: "https://browser.example",
    CRABBOX_TOKEN_ENCRYPTION_KEY: "native-link-test-key",
    GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
  } as RuntimeEnv;
  const approvals: string[] = [];
  const authService = service(approvals);
  const get = await handleNativeLink(
    new Request("https://fleet.example/native/link/link-code", {
      headers: { cookie: "crabbox_session=browser-session" },
    }),
    "link-code",
    { kind: "disabled" },
    env,
    authService,
  );
  const csrf = (await get.text()).match(/name="csrf" value="([^"]+)"/)?.[1];
  const csrfCookie = get.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(csrf);
  assert.ok(csrfCookie);

  await assert.rejects(
    handleNativeLink(
      new Request("https://fleet.example/native/link/link-code", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: "crabbox_session=browser-session",
          origin: "https://fleet.example",
        },
        body: new URLSearchParams({ csrf }),
      }),
      "link-code",
      { kind: "disabled" },
      env,
      authService,
    ),
    (error) => httpStatus(error) === 403,
  );

  const post = await handleNativeLink(
    new Request("https://fleet.example/native/link/link-code", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: `crabbox_session=browser-session; ${csrfCookie}`,
        origin: "https://fleet.example",
      },
      body: new URLSearchParams({ csrf }),
    }),
    "link-code",
    { kind: "disabled" },
    env,
    authService,
  );
  assert.equal(post.status, 200);
  assert.deepEqual(approvals, [`${user.subject}:github-token`]);
});

test("native links canonicalize before lookup or host cookies", async () => {
  const approvals: string[] = [];
  const response = await handleNativeLink(
    new Request("https://alias.example/native/link/link-code"),
    "link-code",
    { kind: "disabled" },
    {
      DB: d1({
        subject: "github:1",
        login: "viewer",
        email: null,
        name: "Viewer",
        role: "viewer",
        allowed: true,
        teams: [],
      }),
      GITHUB_REDIRECT_URI: "https://fleet.example/auth/github/callback",
    } as RuntimeEnv,
    {
      async link() {
        throw new Error("link lookup must not run before canonicalization");
      },
    } as unknown as NativeAuthService,
  );
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://fleet.example/native/link/link-code");
  assert.equal(response.headers.has("set-cookie"), false);
  assert.deepEqual(approvals, []);
});

test("finished native authorization links offer recovery without another approval", async () => {
  for (const [record, heading] of [
    [{ ...link, expiresAt: Date.now() - 1 }, "This sign-in link expired"],
    [{ ...link, approvedAt: Date.now() }, "This link has already been used"],
    [{ ...link, consumedAt: Date.now() }, "This link has already been used"],
  ] as const) {
    const approvals: string[] = [];
    const response = await handleNativeLink(
      new Request("https://fleet.example/native/link/link-code"),
      "link-code",
      { kind: "disabled" },
      {} as RuntimeEnv,
      service(approvals, record),
    );
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.has("set-cookie"), false);
    assert.match(response.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
    const html = await response.text();
    assert.ok(html.includes(`<h1>${heading}</h1>`));
    assert.match(html, /your computer/);
    assert.doesNotMatch(html, /<form|name="csrf"/);
    assert.deepEqual(approvals, []);
  }
});

test("native authorization safely renders long device names and preserves explicit approval", async () => {
  const user: User = {
    subject: "proxy:viewer@example.com",
    login: null,
    email: "viewer@example.com",
    name: "Viewer",
    role: "viewer",
    allowed: true,
    teams: [],
  };
  const approvals: string[] = [];
  const response = await handleNativeLink(
    new Request("https://fleet.example/native/link/link-code"),
    "link-code",
    {
      kind: "authenticated",
      identity: {
        subject: user.subject,
        identity: user.email!,
        login: null,
        email: user.email,
        name: user.name!,
      },
    },
    { DB: d1(user), CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "viewer" } as RuntimeEnv,
    service(approvals, {
      ...link,
      clientName: `${"workstation".repeat(12)}<ScRiPt>alert(1)</ScRiPt>`,
      scope: connectorAccessScope,
    }),
  );
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /&lt;ScRiPt&gt;alert\(1\)&lt;\/ScRiPt&gt;/);
  assert.doesNotMatch(html, /<script\b/i);
  assert.match(html, /<form method="post" action="\/native\/link\/link-code">/);
  assert.match(html, /name="csrf" value="[^"]+"/);
  assert.match(html, /Authorize this connector/);
  assert.deepEqual(approvals, []);
});

test("native sign-in recovery keeps unauthenticated access unauthorized", async () => {
  const approvals: string[] = [];
  const response = await handleNativeLink(
    new Request("https://fleet.example/native/link/link-code"),
    "link-code",
    { kind: "disabled" },
    {} as RuntimeEnv,
    service(approvals),
  );
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const html = await response.text();
  assert.match(html, /Sign in to continue/);
  assert.match(html, /href="\/">Open Crabfleet/);
  assert.doesNotMatch(html, /<form|name="csrf"/);
  assert.deepEqual(approvals, []);
});

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}
