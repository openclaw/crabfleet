import assert from "node:assert/strict";
import test from "node:test";

import type { TrustedProxyAuthResult } from "../src/trusted-proxy-auth.ts";
import type { User } from "../src/worker/models.ts";
import { handleNativeRoute, type NativeRouteDependencies } from "../src/worker/routes/native.ts";

const disabled: TrustedProxyAuthResult = { kind: "disabled" };
const viewer: User = {
  subject: "github:1",
  login: "viewer",
  email: null,
  name: "Viewer",
  role: "viewer",
  allowed: true,
  teams: [],
};

function dependencies(calls: string[]): NativeRouteDependencies {
  return {
    async startDevice(clientName, remoteIp) {
      calls.push(`start:${clientName}:${remoteIp}`);
      return {
        deviceCode: "device-code",
        verificationUri: "https://fleet.example/native/link/link-code",
        expiresAt: 601_000,
        intervalSeconds: 5,
      };
    },
    async pollToken(deviceCode) {
      calls.push(`poll:${deviceCode}`);
      return { kind: "pending", intervalSeconds: 5 };
    },
    async requireUser() {
      calls.push("authenticate");
      return viewer;
    },
    async revokeToken() {
      calls.push("revoke");
    },
    async readFleet(user) {
      calls.push(`fleet:${user.subject}`);
      return { sessions: [] };
    },
    async createNativeVNCGrant(user, sessionId) {
      calls.push(`native-vnc:${user.subject}:${sessionId}`);
      return {
        brokerUrl: "https://crabbox.example.test",
        leaseId: "cbx_native123",
        ticket: "native_vnc_0123456789abcdef0123456789abcdef",
        expiresAt: 660_000,
      };
    },
    deployment: {
      label: "Fleet",
      canonicalUrl: "https://fleet.example",
      productUrl: "https://product.example",
      sshHost: "ssh.example",
    },
  };
}

function request(method: string, path: string, body?: Record<string, unknown>): Request {
  return new Request(`https://fleet.example${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      authorization: "Bearer native-token",
      "cf-connecting-ip": "192.0.2.1",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function dispatch(
  value: Request,
  calls: string[],
  overrides: Partial<NativeRouteDependencies> = {},
  auth = disabled,
): Promise<Response | null> {
  return handleNativeRoute(value, new URL(value.url), auth, {
    ...dependencies(calls),
    ...overrides,
  });
}

test("native routes expose device, session, fleet, native VNC, and revoke contracts", async () => {
  const startCalls: string[] = [];
  const start = await dispatch(
    request("POST", "/api/native/v1/auth/device", { clientName: "Peter's Mac" }),
    startCalls,
  );
  assert.equal(start?.status, 201);
  assert.deepEqual(await start?.json(), {
    deviceCode: "device-code",
    verificationUri: "https://fleet.example/native/link/link-code",
    expiresAt: 601_000,
    intervalSeconds: 5,
  });
  assert.deepEqual(startCalls, ["start:Peter's Mac:192.0.2.1"]);

  const sessionCalls: string[] = [];
  const session = await dispatch(request("GET", "/api/native/v1/session"), sessionCalls);
  assert.equal(session?.status, 200);
  assert.deepEqual(await session?.json(), {
    user: viewer,
    deployment: dependencies([]).deployment,
  });
  assert.deepEqual(sessionCalls, ["authenticate"]);

  const fleetCalls: string[] = [];
  const fleet = await dispatch(request("GET", "/api/native/v1/fleet"), fleetCalls);
  assert.deepEqual(await fleet?.json(), { fleet: { sessions: [] } });
  assert.deepEqual(fleetCalls, ["authenticate", "fleet:github:1"]);

  const vncCalls: string[] = [];
  const vnc = await dispatch(
    request("POST", "/api/native/v1/sessions/IS-257/native-vnc"),
    vncCalls,
  );
  assert.equal(vnc?.status, 200);
  assert.equal(vnc?.headers.get("cache-control"), "no-store");
  assert.deepEqual(await vnc?.json(), {
    grant: {
      brokerUrl: "https://crabbox.example.test",
      leaseId: "cbx_native123",
      ticket: "native_vnc_0123456789abcdef0123456789abcdef",
      expiresAt: 660_000,
    },
  });
  assert.deepEqual(vncCalls, ["authenticate", "native-vnc:github:1:IS-257"]);

  const revokeCalls: string[] = [];
  const revoke = await dispatch(request("DELETE", "/api/native/v1/auth/token"), revokeCalls);
  assert.deepEqual(await revoke?.json(), { ok: true });
  assert.deepEqual(revokeCalls, ["revoke"]);
});

test("native token polling returns pending, slowdown, and one-time token shapes", async () => {
  for (const [result, status, body] of [
    [{ kind: "pending", intervalSeconds: 5 }, 202, { status: "pending" }],
    [{ kind: "slow_down", intervalSeconds: 5 }, 429, { error: "slow_down" }],
    [
      {
        kind: "authorized",
        accessToken: "access-token",
        expiresAt: 86_401_000,
        user: viewer,
      },
      200,
      {
        accessToken: "access-token",
        tokenType: "Bearer",
        expiresAt: 86_401_000,
        user: viewer,
      },
    ],
  ] as const) {
    const response = await dispatch(
      request("POST", "/api/native/v1/auth/token", { deviceCode: "device-code" }),
      [],
      { pollToken: async () => result },
    );
    assert.equal(response?.status, status);
    assert.deepEqual(await response?.json(), body);
    if (status !== 200) assert.equal(response?.headers.get("retry-after"), "5");
  }
});

test("native bearer routes reject simultaneous trusted-proxy identity", async () => {
  const authenticated: TrustedProxyAuthResult = {
    kind: "authenticated",
    identity: {
      subject: "proxy:viewer@example.com",
      identity: "viewer@example.com",
      login: null,
      email: "viewer@example.com",
      name: "viewer@example.com",
    },
  };
  for (const [method, path] of [
    ["POST", "/api/native/v1/auth/device"],
    ["POST", "/api/native/v1/auth/token"],
    ["GET", "/api/native/v1/session"],
    ["GET", "/api/native/v1/fleet"],
    ["POST", "/api/native/v1/sessions/IS-257/native-vnc"],
    ["DELETE", "/api/native/v1/auth/token"],
  ]) {
    await assert.rejects(dispatch(request(method, path), [], {}, authenticated), (error) => {
      assert.equal(httpStatus(error), 401);
      return true;
    });
  }
});

test("native routes fall through on inexact methods and paths", async () => {
  for (const value of [
    request("GET", "/api/native/v1/auth/device"),
    request("GET", "/api/native/v1/auth/token"),
    request("POST", "/api/native/v1/fleet", {}),
    request("GET", "/api/native/v2/fleet"),
    request("POST", "/api/native/v1/sessions/IS-0/native-vnc"),
    request("POST", "/api/native/v1/sessions/IS-257/native-vnc/extra"),
  ]) {
    assert.equal(await dispatch(value, []), null);
  }
});

test("native unauthenticated JSON bodies are content-typed and bounded", async () => {
  await assert.rejects(
    dispatch(
      new Request("https://fleet.example/api/native/v1/auth/device", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "{}",
      }),
      [],
    ),
    (error) => httpStatus(error) === 400,
  );
  await assert.rejects(
    dispatch(request("POST", "/api/native/v1/auth/device", { clientName: "x".repeat(2_000) }), []),
    (error) => httpStatus(error) === 413,
  );
});

test("native device and token routes require top-level JSON objects", async () => {
  for (const path of ["/api/native/v1/auth/device", "/api/native/v1/auth/token"]) {
    for (const body of ["null", "[]", '"value"', "1", "true"]) {
      const calls: string[] = [];
      await assert.rejects(
        dispatch(
          new Request(`https://fleet.example${path}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          }),
          calls,
        ),
        (error) => httpStatus(error) === 400,
      );
      assert.deepEqual(calls, []);
    }
  }
});

function httpStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}
