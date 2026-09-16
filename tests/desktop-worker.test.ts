import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { registerHooks } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { sqliteRuntimeEnv } from "./helpers/sqlite-env.ts";
import { createNativeAuthService } from "../src/worker/native-auth.ts";
import { usesIndependentServiceAuth } from "../src/worker/ingress.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";

// The relay's pairing protocol has its own tests; the HTTP integration uses real SQLite.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") {
      return { url: "data:text/javascript,export class DurableObject {}", shortCircuit: true };
    }
    if (specifier.endsWith("/generated.ts")) {
      return {
        url: 'data:text/javascript,export const APP_HTML="<html>Desktop companion</html>";export const LOGO_PNG_BASE64="";export const BROWSER_ASSETS={};',
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { default: worker } = await import("../src/index.ts");
hooks.deregister();

function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const migrations = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(migrations)
    .filter((name) => name.endsWith(".sql"))
    .sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  const env: RuntimeEnv = {
    ...sqliteRuntimeEnv(sqlite),
    CRABFLEET_DEV_LOGIN_ENABLED: "true",
    CRABFLEET_CANONICAL_URL: "http://127.0.0.1:8787",
    CRABBOX_BOOTSTRAP_TOKEN: "test-only-recovery-token",
    CRABBOX_TOKEN_ENCRYPTION_KEY: "test-only-encryption-material",
  };
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    worker.fetch(
      new Request(`http://127.0.0.1:8787${path}`, {
        method,
        headers: { "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      env,
    );
  const login = async (id: string) => {
    const result = await request("POST", "/api/login/dev", { id });
    assert.equal(result.status, 200);
    return result.headers.get("set-cookie")!.split(";", 1)[0]!;
  };
  return { sqlite, env, request, login };
}

test("malformed cookies do not interrupt authenticated requests or logout", async () => {
  const { sqlite, request, login } = setup();
  try {
    const session = await login("alice");
    const headers = { cookie: `bad=%; ${session}; invalid=%FF; keep=fine` };
    const current = await request("GET", "/api/session", undefined, headers);
    assert.equal(current.status, 200);
    assert.equal((await current.json()).user.subject, "dev:alice");

    const logout = await request("POST", "/api/logout", undefined, headers);
    assert.equal(logout.status, 200);
    assert.equal(
      (await request("GET", "/api/session", undefined, { cookie: session })).status,
      401,
    );
  } finally {
    sqlite.close();
  }
});

test("malformed native sign-in paths return a client error", async () => {
  const { sqlite, request } = setup();
  try {
    for (const method of ["GET", "POST"]) {
      for (const code of ["%", "%GG", "%FF", "%E2%82"]) {
        const response = await request(method, `/native/link/${code}`);
        assert.equal(response.status, 400, `${method} ${code}`);
        assert.deepEqual(await response.json(), { error: "invalid path identifier" });
      }
    }
  } finally {
    sqlite.close();
  }
});

test("desktop-only Worker preserves publication ownership, private discovery, and removal", async () => {
  const { sqlite, request, login } = setup();
  try {
    const cookie = await login("alice");
    const registration = await request(
      "PUT",
      "/api/desktop-hosts/studio",
      { name: "Studio", address: "100.64.0.8", port: 5901 },
      {
        cookie,
        "x-crabfleet-ownership-mode": "token-v1",
        "x-crabfleet-publication-id": "publication-one",
      },
    );
    assert.equal(registration.status, 200);
    const { ownershipToken } = await registration.json();
    assert.ok(ownershipToken);
    const fleet = await (await request("GET", "/api/fleet", undefined, { cookie })).json();
    assert.equal(fleet.fleet.desktopHosts[0].name, "Studio");
    assert.equal(fleet.fleet.desktopHosts[0].relayCapable, true);
    assert.equal("ownershipToken" in fleet.fleet.desktopHosts[0], false);
    assert.deepEqual(fleet.fleet.sessions, []);
    assert.deepEqual(fleet.fleet.totals, { active: 0, sessions: 0, vnc: 0 });
    const otherCookie = await login("bob");
    const otherFleet = await (
      await request("GET", "/api/fleet", undefined, { cookie: otherCookie })
    ).json();
    assert.deepEqual(otherFleet.fleet.desktopHosts, []);
    const deniedRelay = await request("GET", "/api/desktop-hosts/studio/relay/viewer", undefined, {
      cookie: otherCookie,
      upgrade: "websocket",
    });
    assert.equal(deniedRelay.status, 404);
    const recovered = await (
      await request(
        "POST",
        "/api/desktop-hosts/studio?recover=1",
        { publicationID: "publication-one" },
        { cookie },
      )
    ).json();
    assert.equal(recovered.ownershipToken, ownershipToken);
    const removed = await request("DELETE", "/api/desktop-hosts/studio", undefined, {
      cookie,
      "x-crabfleet-ownership-token": ownershipToken,
    });
    assert.equal(removed.status, 200);
    assert.deepEqual(
      (await (await request("GET", "/api/fleet", undefined, { cookie })).json()).fleet.desktopHosts,
      [],
    );
  } finally {
    sqlite.close();
  }
});

test("native device sign-in discovers desktops without any workspace runtime", async () => {
  const { sqlite, env, request } = setup();
  try {
    const login = await request("POST", "/api/login/token", { token: env.CRABBOX_BOOTSTRAP_TOKEN });
    const { user } = await login.json();
    const deviceResponse = await request("POST", "/api/native/v1/auth/device", {
      clientName: "Test Mac",
    });
    assert.equal(deviceResponse.status, 201);
    const device = await deviceResponse.json();
    const code = new URL(device.verificationUri).pathname.split("/").pop()!;
    await createNativeAuthService(env).approve(code, user);
    const tokenResponse = await request("POST", "/api/native/v1/auth/token", {
      deviceCode: device.deviceCode,
    });
    assert.equal(tokenResponse.status, 200);
    const { accessToken } = await tokenResponse.json();
    const headers = { authorization: `Bearer ${accessToken}` };
    assert.equal((await request("GET", "/api/native/v1/session", undefined, headers)).status, 200);
    const fleet = await request("GET", "/api/native/v1/fleet", undefined, headers);
    assert.equal(fleet.status, 200);
    assert.deepEqual((await fleet.json()).fleet.desktopHosts, []);
    assert.equal(
      (await request("DELETE", "/api/native/v1/auth/token", undefined, headers)).status,
      200,
    );
    assert.equal((await request("GET", "/api/native/v1/fleet", undefined, headers)).status, 401);
  } finally {
    sqlite.close();
  }
});

test("retired agent, board, workspace, terminal, and SSH routes are absent", async () => {
  const { sqlite, request, login } = setup();
  try {
    const cookie = await login("owner");
    for (const [method, path] of [
      ["GET", "/app/board"],
      ["GET", "/app/sessions/IS-1"],
      ["GET", "/sessions/IS-1"],
      ["GET", "/docs/spec"],
      ["GET", "/ssh/link/code"],
      ["GET", "/api/state"],
      ["POST", "/api/cards"],
      ["POST", "/api/interactive-sessions"],
      ["GET", "/api/terminal/ws"],
      ["POST", "/api/provision/interactive"],
      ["POST", "/api/openclaw/action-sessions"],
      ["GET", "/api/agent/state"],
      ["GET", "/api/ssh/state"],
      ["POST", "/api/native/v1/native-vnc"],
    ]) {
      assert.equal(
        (await request(method!, path!, undefined, { cookie })).status,
        404,
        `${method} ${path}`,
      );
    }
  } finally {
    sqlite.close();
  }
});

test("proxy bypass is limited to exact desktop service routes", () => {
  for (const [method, path] of [
    ["POST", "/api/native/v1/auth/device"],
    ["GET", "/api/native/v1/fleet"],
    ["GET", "/api/connector/v1/session"],
    ["PUT", "/api/connector/v1/desktop-hosts/linux"],
    ["POST", "/api/connector/v1/desktop-hosts/linux/recover"],
    ["GET", "/api/desktop-hosts/linux/relay/host"],
  ])
    assert.equal(
      usesIndependentServiceAuth(new Request(`https://fleet.example${path}`, { method })),
      true,
      path,
    );
  for (const path of [
    "/api/terminal/ws",
    "/api/ssh/state",
    "/api/agent/state",
    "/api/openclaw/rooms",
    "/api/provision/interactive",
    "/api/native/v1/native-vnc",
    "/api/connector/v1/unknown",
    "/api/desktop-hosts/linux/relay/viewer",
  ]) {
    assert.equal(
      usesIndependentServiceAuth(new Request(`https://fleet.example${path}`)),
      false,
      path,
    );
  }
});
