import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspectTrustedProxyAssertion,
  sanitizeTrustedProxyRequest,
  trustedProxyConfigured,
  trustedProxyPublicOrigin,
  trustedProxySecretHeader,
  trustedUserHeader,
} from "../src/trusted-proxy-auth.ts";

const env = {
  CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
  CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
  CRABFLEET_TRUSTED_PROXY_SECRET: "edge-secret",
};

function request(
  headers: Record<string, string> = {},
  options: { url?: string; method?: string; body?: string } = {},
): Request {
  return new Request(options.url ?? "https://backend.example/api/session", {
    headers,
    method: options.method,
    body: options.body,
  });
}

const assertion = {
  "x-authenticated-user": "Owner@Example.com",
  [trustedProxySecretHeader]: "edge-secret",
};

test("trusted proxy authenticates an asserted user on the exact backend origin", () => {
  assert.equal(trustedProxyPublicOrigin(env), "https://fleet.example");
  assert.deepEqual(inspectTrustedProxyAssertion(request(assertion), env), {
    kind: "authenticated",
    identity: {
      subject: "proxy:owner@example.com",
      identity: "Owner@Example.com",
      login: null,
      email: "owner@example.com",
      name: "Owner@Example.com",
    },
  });
});

test("trusted proxy origin is authoritative and assertions fail closed", () => {
  assert.deepEqual(inspectTrustedProxyAssertion(request(), env), { kind: "missing" });
  assert.deepEqual(
    inspectTrustedProxyAssertion(request({}, { url: "https://direct.example/api/session" }), env),
    { kind: "outside-origin" },
  );
  assert.deepEqual(
    inspectTrustedProxyAssertion(
      request(assertion, { url: "https://direct.example/api/session" }),
      env,
    ),
    { kind: "rejected" },
  );

  for (const headers of [
    { "x-authenticated-user": "owner@example.com" },
    { [trustedProxySecretHeader]: "edge-secret" },
    {
      "x-authenticated-user": "owner@example.com",
      [trustedProxySecretHeader]: "wrong-secret",
    },
  ]) {
    assert.deepEqual(inspectTrustedProxyAssertion(request(headers), env), { kind: "rejected" });
  }
});

test("asserted identities cannot collide with team allowlist entries", () => {
  for (const identity of ["org/team", "@org/team", "user name", ".operator"]) {
    assert.deepEqual(
      inspectTrustedProxyAssertion(
        request({
          "x-authenticated-user": identity,
          [trustedProxySecretHeader]: "edge-secret",
        }),
        env,
      ),
      { kind: "rejected" },
    );
  }
});

test("unsafe methods and WebSockets require the exact browser-visible origin", () => {
  for (const headers of [assertion, { ...assertion, origin: "https://wrong.example" }]) {
    assert.deepEqual(
      inspectTrustedProxyAssertion(request(headers, { method: "POST", body: "{}" }), env),
      { kind: "rejected" },
    );
  }

  assert.equal(
    inspectTrustedProxyAssertion(
      request({ ...assertion, origin: "https://fleet.example" }, { method: "POST", body: "{}" }),
      env,
    ).kind,
    "authenticated",
  );
  assert.equal(
    inspectTrustedProxyAssertion(
      request({ ...assertion, origin: "https://fleet.example", upgrade: "websocket" }),
      env,
    ).kind,
    "authenticated",
  );
});

test("disabled mode rejects assertion-shaped headers", () => {
  assert.equal(trustedProxyPublicOrigin({}), null);
  assert.deepEqual(inspectTrustedProxyAssertion(request(), {}), { kind: "disabled" });
  assert.deepEqual(inspectTrustedProxyAssertion(request(assertion), {}), { kind: "rejected" });
});

test("partial or invalid configuration fails closed", () => {
  for (const configured of [
    { CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example" },
    { CRABFLEET_TRUSTED_PROXY_SECRET: "edge-secret" },
    { ...env, CRABFLEET_TRUSTED_PROXY_SECRET: "" },
    { ...env, CRABFLEET_TRUSTED_PROXY_ORIGIN: "http://backend.example" },
    { ...env, CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example/path" },
    { ...env, CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://user@fleet.example" },
  ]) {
    assert.equal(trustedProxyConfigured(configured), false);
    assert.deepEqual(inspectTrustedProxyAssertion(request(), configured), { kind: "rejected" });
  }
});

test("custom identity headers and loopback development origins are supported", () => {
  const custom = {
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "http://127.0.0.1:8787",
    CRABFLEET_TRUSTED_USER_HEADER: "X-Forwarded-Identity",
    CRABFLEET_TRUSTED_PROXY_SECRET: "edge-secret",
  };
  assert.equal(trustedProxyConfigured(custom), true);
  assert.equal(trustedUserHeader(custom), "x-forwarded-identity");
  assert.equal(
    inspectTrustedProxyAssertion(
      request(
        {
          "x-forwarded-identity": "operator",
          [trustedProxySecretHeader]: "edge-secret",
        },
        { url: "http://127.0.0.1:8787/api/session" },
      ),
      custom,
    ).kind,
    "authenticated",
  );
});

test("invalid or reserved identity header configuration is disabled", () => {
  for (const header of ["bad header", trustedProxySecretHeader]) {
    const configured = { ...env, CRABFLEET_TRUSTED_USER_HEADER: header };
    assert.equal(trustedUserHeader(configured), null);
    assert.equal(trustedProxyConfigured(configured), false);
    assert.deepEqual(inspectTrustedProxyAssertion(request(), configured), { kind: "rejected" });
  }
});

test("sanitization removes proxy credentials while preserving request data", async () => {
  const original = request(
    {
      ...assertion,
      cookie: "crabbox_session=stale",
      authorization: "Bearer terminal-token",
      "x-safe": "yes",
    },
    { method: "POST", body: "payload" },
  );
  const sanitized = sanitizeTrustedProxyRequest(original, env);
  assert.equal(sanitized.headers.has("x-authenticated-user"), false);
  assert.equal(sanitized.headers.has(trustedProxySecretHeader), false);
  assert.equal(sanitized.headers.get("cookie"), "crabbox_session=stale");
  assert.equal(sanitized.headers.get("authorization"), "Bearer terminal-token");
  assert.equal(sanitized.headers.get("x-safe"), "yes");
  assert.equal(await sanitized.text(), "payload");
});
