import assert from "node:assert/strict";
import test from "node:test";

import { trustedProxySecretHeader } from "../src/trusted-proxy-auth.ts";
import {
  enforceWorkerIngressAuth,
  prepareWorkerIngress,
  usesIndependentServiceAuth,
} from "../src/worker/ingress.ts";

const env = {
  CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
  CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
  CRABFLEET_TRUSTED_PROXY_SECRET: "edge-secret",
};

const assertion = {
  "x-authenticated-user": "owner@example.com",
  [trustedProxySecretHeader]: "edge-secret",
};

test("authenticated proxy ingress strips browser and proxy credentials before routing", () => {
  const ingress = prepareWorkerIngress(
    new Request("https://backend.example/api/session", {
      headers: {
        ...assertion,
        authorization: "Bearer upstream-credential",
        cookie: "crabbox_session=stale",
        "x-safe": "preserved",
      },
    }),
    env,
  );

  assert.equal(ingress.trustedProxy.kind, "authenticated");
  assert.equal(ingress.independentServiceAuth, false);
  assert.equal(ingress.request.headers.has("x-authenticated-user"), false);
  assert.equal(ingress.request.headers.has(trustedProxySecretHeader), false);
  assert.equal(ingress.request.headers.has("authorization"), false);
  assert.equal(ingress.request.headers.has("cookie"), false);
  assert.equal(ingress.request.headers.get("x-safe"), "preserved");
});

test("authenticated proxy ingress preserves independent service authorization only", () => {
  const ingress = prepareWorkerIngress(
    new Request("https://backend.example/api/openclaw/rooms", {
      headers: {
        ...assertion,
        authorization: "Bearer service-token",
        cookie: "crabbox_session=stale",
      },
    }),
    env,
  );

  assert.equal(ingress.independentServiceAuth, true);
  assert.equal(ingress.request.headers.get("authorization"), "Bearer service-token");
  assert.equal(ingress.request.headers.has("cookie"), false);
  assert.equal(ingress.request.headers.has("x-authenticated-user"), false);
  assert.equal(ingress.request.headers.has(trustedProxySecretHeader), false);
});

test("rejected proxy assertions fail before a request can be routed", () => {
  assert.throws(
    () =>
      prepareWorkerIngress(
        new Request("https://backend.example/api/session", {
          headers: {
            ...assertion,
            [trustedProxySecretHeader]: "wrong-secret",
          },
        }),
        env,
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "unauthorized" &&
      "status" in error &&
      error.status === 401,
  );
});

test("missing proxy assertions bypass enforcement only on independent service routes", () => {
  const browserIngress = prepareWorkerIngress(
    new Request("https://backend.example/api/session"),
    env,
  );
  assert.throws(() => enforceWorkerIngressAuth(browserIngress), { message: "unauthorized" });

  for (const pathname of [
    "/api/ssh/keys",
    "/api/agent/register",
    "/api/openclaw/rooms",
    "/api/provision/session",
  ]) {
    const ingress = prepareWorkerIngress(new Request(`https://backend.example${pathname}`), env);
    assert.equal(ingress.independentServiceAuth, true);
    assert.doesNotThrow(() => enforceWorkerIngressAuth(ingress));
  }
  const nativeVNC = prepareWorkerIngress(
    new Request("https://backend.example/api/native/v1/sessions/IS-257/native-vnc", {
      method: "POST",
      headers: { authorization: "Bearer native-token" },
    }),
    env,
  );
  assert.equal(nativeVNC.independentServiceAuth, true);
  assert.doesNotThrow(() => enforceWorkerIngressAuth(nativeVNC));
});

test("terminal ingress requires authorization plus an SSH or agent identity", () => {
  for (const headers of [
    {},
    { authorization: "Bearer terminal-token" },
    { "x-crabfleet-ssh-fingerprint": "SHA256:key" },
    { "x-crabfleet-session-id": "session-1" },
  ]) {
    assert.equal(
      usesIndependentServiceAuth(
        new Request("https://backend.example/api/terminal/ws", { headers }),
      ),
      false,
    );
  }

  for (const headers of [
    {
      authorization: "Bearer terminal-token",
      "x-crabfleet-ssh-fingerprint": "SHA256:key",
    },
    {
      authorization: "Bearer terminal-token",
      "x-crabfleet-session-id": "session-1",
    },
  ]) {
    assert.equal(
      usesIndependentServiceAuth(
        new Request("https://backend.example/api/terminal/ws", { headers }),
      ),
      true,
    );
  }

  assert.equal(
    usesIndependentServiceAuth(
      new Request("https://backend.example/api/terminal/ws", {
        headers: {
          authorization: "Bearer terminal-token",
          "x-crabbox-session-id": "legacy-session",
        },
      }),
    ),
    false,
  );
  assert.equal(
    usesIndependentServiceAuth(
      new Request("https://backend.example/api/terminal/ws", {
        headers: {
          authorization: "Bearer terminal-token",
          "x-crabbox-ssh-fingerprint": "legacy-key",
        },
      }),
    ),
    false,
  );
});

test("disabled proxy mode leaves ordinary requests routable but rejects assertion headers", () => {
  const ingress = prepareWorkerIngress(new Request("https://fleet.example/api/session"), {});
  assert.equal(ingress.trustedProxy.kind, "disabled");
  assert.doesNotThrow(() => enforceWorkerIngressAuth(ingress));

  assert.throws(
    () =>
      prepareWorkerIngress(
        new Request("https://fleet.example/api/session", { headers: assertion }),
        {},
      ),
    { message: "unauthorized" },
  );
});

test("native service ingress bypass is limited to exact methods and paths", () => {
  for (const [method, pathname] of [
    ["POST", "/api/native/v1/auth/device"],
    ["POST", "/api/native/v1/auth/token"],
    ["DELETE", "/api/native/v1/auth/token"],
    ["GET", "/api/native/v1/session"],
    ["GET", "/api/native/v1/fleet"],
  ]) {
    const ingress = prepareWorkerIngress(
      new Request(`https://backend.example${pathname}`, { method }),
      env,
    );
    assert.equal(ingress.independentServiceAuth, true);
    assert.doesNotThrow(() => enforceWorkerIngressAuth(ingress));
  }

  for (const [method, pathname] of [
    ["GET", "/api/native/v1/auth/device"],
    ["GET", "/api/native/v1/auth/token"],
    ["POST", "/api/native/v1/fleet"],
    ["GET", "/api/native/v1/unknown"],
    ["POST", "/native/link/code"],
  ]) {
    const ingress = prepareWorkerIngress(
      new Request(`https://backend.example${pathname}`, { method }),
      env,
    );
    assert.equal(ingress.independentServiceAuth, false);
    assert.throws(() => enforceWorkerIngressAuth(ingress), { message: "unauthorized" });
  }
});
