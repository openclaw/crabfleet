import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  actor,
  authMethods,
  authorize,
  bootstrapSubject,
  createSession,
  devIdentityLogin,
  devIdentityId,
  logout,
  parseRole,
  requireRole,
  requireUser,
  sessionGitHubToken,
  tokenLogin,
  trustedProxyAutomaticRole,
} from "../src/worker/auth.ts";
import { openSecret, sealSecret, sha256 } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { User } from "../src/worker/models.ts";

type D1Result = { results?: unknown[]; changes?: number };
type D1Handler = (sql: string, parameters: unknown[], kind: "all" | "run") => D1Result;

function d1(handler: D1Handler): D1Database {
  return {
    prepare(sql: string) {
      return {
        bind(...parameters: unknown[]) {
          return {
            async all() {
              const result = handler(sql, parameters, "all");
              return { results: result.results ?? [], meta: { changes: result.changes ?? 0 } };
            },
            async run() {
              const result = handler(sql, parameters, "run");
              return { meta: { changes: result.changes ?? 0 } };
            },
          };
        },
      };
    },
  } as unknown as D1Database;
}

function runtimeEnv(db: D1Database, values: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return { DB: db, ...values } as RuntimeEnv;
}

function user(values: Partial<User> = {}): User {
  return {
    subject: "github:42",
    login: "owner",
    email: "owner@example.com",
    name: "Owner",
    role: "viewer",
    allowed: false,
    teams: ["@openclaw/core"],
    ...values,
  };
}

test("allowlist authorization selects the strongest matching identity role", async () => {
  const env = runtimeEnv(
    d1((sql) => {
      assert.match(sql, /from "allow_entries"/i);
      return {
        results: [
          { value: "@owner", role: "viewer" },
          { value: "owner@example.com", role: "maintainer" },
          { value: "@openclaw/core", role: "owner" },
          { value: "@someone-else", role: "owner" },
        ],
      };
    }),
  );

  assert.deepEqual(await authorize(env, user()), { ...user(), role: "owner", allowed: true });
});

test("development sessions are invalidated when the local login gate is unavailable", async () => {
  let deletedTokenHash: unknown;
  const token = "dev-session-token";
  const env = runtimeEnv(
    d1((sql, parameters, kind) => {
      if (kind === "all" && /from "sessions" as "s"/i.test(sql)) {
        return {
          results: [
            {
              subject: "dev:operator",
              login: "operator",
              email: null,
              name: "Operator",
              role: "owner",
              allowed: 1,
              teams: "[]",
            },
          ],
        };
      }
      if (kind === "run" && /^delete from "sessions"/i.test(sql)) {
        deletedTokenHash = parameters[0];
        return { changes: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    { CRABFLEET_DEV_LOGIN_ENABLED: "false" },
  );

  await assert.rejects(
    requireUser(
      new Request("https://fleet.example/api/session", {
        headers: { cookie: `crabbox_session=${token}` },
      }),
      env,
      { kind: "disabled" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "unauthorized" &&
      "status" in error &&
      error.status === 401,
  );
  assert.equal(deletedTokenHash, await sha256(token));
});

test("session GitHub credentials are bound to the authenticated subject", async () => {
  const token = "browser-session-token";
  const secretEnv = runtimeEnv({} as D1Database, {
    CRABBOX_TOKEN_ENCRYPTION_KEY: "encryption-key",
  });
  const ciphertext = await sealSecret(secretEnv, "github-token");
  assert.ok(ciphertext);

  const env = runtimeEnv(
    d1((sql, parameters) => {
      assert.match(sql, /from "sessions"/i);
      assert.match(sql, /"subject" = \?/i);
      return parameters.includes("github:42")
        ? { results: [{ github_token_ciphertext: ciphertext }] }
        : { results: [] };
    }),
    { CRABBOX_TOKEN_ENCRYPTION_KEY: "encryption-key" },
  );
  const request = new Request("https://fleet.example/api/session", {
    headers: { cookie: `crabbox_session=${token}` },
  });

  assert.equal(await sessionGitHubToken(request, env, "github:42"), "github-token");
  assert.equal(await sessionGitHubToken(request, env, "proxy:owner@example.com"), undefined);
});

test("session creation and logout persist only hashed browser tokens", async () => {
  const writes: Array<{ sql: string; parameters: unknown[] }> = [];
  const env = runtimeEnv(
    d1((sql, parameters, kind) => {
      if (kind === "run") writes.push({ sql, parameters });
      return { changes: 1 };
    }),
    { CRABBOX_TOKEN_ENCRYPTION_KEY: "encryption-key" },
  );
  const request = new Request("https://fleet.example/api/session");
  const session = await createSession(env, request, "github:42", 1_000, 900, "github-token");
  const cookieValue = session.match(/^crabbox_session=([^;]+)/)?.[1];
  assert.ok(cookieValue);
  assert.equal(writes.length, 2);
  assert.match(writes[0]?.sql ?? "", /^delete from "sessions"/i);
  assert.match(writes[1]?.sql ?? "", /^insert into "sessions"/i);
  assert.equal(writes[1]?.parameters.includes(cookieValue), false);
  assert.ok(writes[1]?.parameters.includes(await sha256(decodeURIComponent(cookieValue))));

  const response = await logout(
    new Request("https://fleet.example/api/logout", {
      headers: { cookie: `crabbox_session=${cookieValue}` },
    }),
    env,
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("set-cookie") ?? "", /Max-Age=0/);
  assert.match(writes.at(-1)?.sql ?? "", /^delete from "sessions"/i);
});

test("bootstrap and development login handlers own their validation and sessions", async () => {
  const writes: string[] = [];
  const env = runtimeEnv(
    d1((sql, _parameters, kind) => {
      if (kind === "run") writes.push(sql);
      return { changes: 1 };
    }),
    {
      CRABBOX_BOOTSTRAP_TOKEN: "bootstrap",
      CRABFLEET_DEV_LOGIN_ENABLED: "true",
    },
  );
  const invalid = await tokenLogin(
    new Request("https://fleet.example/api/login/token", {
      method: "POST",
      body: JSON.stringify({ token: "wrong" }),
    }),
    env,
  );
  assert.equal(invalid.status, 401);
  assert.equal(writes.length, 0);

  const bootstrap = await tokenLogin(
    new Request("https://fleet.example/api/login/token", {
      method: "POST",
      body: JSON.stringify({ token: "bootstrap" }),
    }),
    env,
  );
  assert.equal(bootstrap.status, 200);
  assert.match(bootstrap.headers.get("set-cookie") ?? "", /^crabbox_session=/);
  assert.equal(
    (await bootstrap.json<{ user: User }>()).user.subject.startsWith("bootstrap:"),
    true,
  );

  const development = await devIdentityLogin(
    new Request("http://127.0.0.1:8787/api/login/dev", {
      method: "POST",
      body: JSON.stringify({ id: " Jane Doe ", name: "Jane", role: "maintainer" }),
    }),
    env,
  );
  assert.equal(development.status, 200);
  assert.deepEqual((await development.json<{ user: User }>()).user, {
    subject: "dev:jane-doe",
    login: "jane-doe",
    email: null,
    name: "Jane",
    role: "maintainer",
    allowed: true,
    teams: [],
  });
  assert.ok(writes.some((sql) => /^insert into "users"/i.test(sql)));
  assert.ok(writes.some((sql) => /^insert into "sessions"/i.test(sql)));
});

test("development login is hidden outside its explicit local gate", async () => {
  const response = await devIdentityLogin(
    new Request("https://fleet.example/api/login/dev", {
      method: "POST",
      body: JSON.stringify({ id: "owner" }),
    }),
    runtimeEnv({} as D1Database, { CRABFLEET_DEV_LOGIN_ENABLED: "true" }),
  );

  assert.equal(response.status, 404);
});

test("auth policy helpers normalize identities, advertise configured methods, and enforce roles", async () => {
  assert.equal(devIdentityId(" DEV:Jane Doe "), "jane-doe");
  assert.equal(devIdentityId("***"), "dev");
  assert.equal(parseRole("maintainer"), "maintainer");
  assert.equal(parseRole("invalid"), "owner");
  assert.equal(actor(user({ login: null })), "owner@example.com");

  const configured = runtimeEnv({} as D1Database, {
    CRABBOX_BOOTSTRAP_TOKEN: "bootstrap",
    GITHUB_CLIENT_ID: "client",
    GITHUB_CLIENT_SECRET: "secret",
    CRABFLEET_DEV_LOGIN_ENABLED: "true",
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
    CRABFLEET_TRUSTED_PROXY_SECRET: "proxy-secret",
  });
  assert.deepEqual(authMethods(configured, new Request("http://127.0.0.1:8787/api/auth/config")), {
    github: true,
    token: true,
    devIdentity: true,
    trustedProxy: true,
  });
  assert.match(await bootstrapSubject(configured), /^bootstrap:[a-f0-9]{24}$/);

  assert.doesNotThrow(() => requireRole(user({ role: "owner" }), "maintainer"));
  assert.throws(() => requireRole(user({ role: "viewer" }), "maintainer"), {
    message: "insufficient role",
  });

  const config = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  assert.match(config, /"CRABFLEET_DEV_LOGIN_ENABLED": "false"/);
});

test("trusted proxy automatic roles admit authenticated users without a global allowlist", async () => {
  const writes: string[] = [];
  const env = runtimeEnv(
    d1((sql, _parameters, kind) => {
      if (kind === "all" && /from "allow_entries"/i.test(sql)) return { results: [] };
      if (kind === "all" && /from "users"/i.test(sql)) return { results: [] };
      if (kind === "run" && /^insert into "users"/i.test(sql)) {
        writes.push(sql);
        return { changes: 1 };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
    { CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "maintainer" },
  );

  const authenticated = await requireUser(new Request("https://fleet.example/api/state"), env, {
    kind: "authenticated",
    identity: {
      subject: "proxy:operator@example.test",
      identity: "operator@example.test",
      login: null,
      email: "operator@example.test",
      name: "operator@example.test",
    },
  });

  assert.deepEqual(authenticated, {
    subject: "proxy:operator@example.test",
    login: null,
    email: "operator@example.test",
    name: "operator@example.test",
    role: "maintainer",
    allowed: true,
    teams: [],
  });
  assert.equal(writes.length, 1);
});

test("trusted proxy automatic roles fail closed on elevated or malformed values", async () => {
  assert.equal(trustedProxyAutomaticRole("viewer"), "viewer");
  assert.equal(trustedProxyAutomaticRole("maintainer"), "maintainer");
  for (const value of [undefined, "", "owner", "Maintainer", " maintainer "]) {
    assert.equal(trustedProxyAutomaticRole(value), null);
  }

  const env = runtimeEnv(
    d1((sql) => {
      assert.match(sql, /from "allow_entries"/i);
      return { results: [] };
    }),
    { CRABFLEET_TRUSTED_PROXY_AUTO_ROLE: "owner" },
  );
  await assert.rejects(
    requireUser(new Request("https://fleet.example/api/state"), env, {
      kind: "authenticated",
      identity: {
        subject: "proxy:operator@example.test",
        identity: "operator@example.test",
        login: null,
        email: "operator@example.test",
        name: "operator@example.test",
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "trusted proxy automatic role is invalid" &&
      "status" in error &&
      error.status === 403,
  );
});

test("secret encryption round-trips with the configured key and fails closed", async () => {
  const env = runtimeEnv({} as D1Database, {
    CRABBOX_TOKEN_ENCRYPTION_KEY: "encryption-key",
  });
  const sealed = await sealSecret(env, "credential");
  assert.match(sealed ?? "", /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(await openSecret(env, sealed ?? ""), "credential");
  assert.equal(await openSecret(env, `${sealed}corrupt`), null);
  assert.equal(await sealSecret(runtimeEnv({} as D1Database), "credential"), null);
});
