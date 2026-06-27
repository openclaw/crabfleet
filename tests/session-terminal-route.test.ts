import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  interactivePtyRouteKind,
  interactiveTerminalHeaders,
  interactiveTerminalRouteAvailable,
  interactiveTerminalTarget,
  runtimeAdapterTerminalAuthorization,
  validateTerminalWebSocketOrigin,
} from "../src/worker/session-terminal-route.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function session(values: Parameters<typeof sessionRow>[0] = {}) {
  return interactiveSession(
    sessionRow({
      id: "IS-route",
      repo: "openclaw/crabfleet",
      branch: "feature/terminal route",
      runtime: "crabbox",
      profile: "default",
      command: "codex --yolo",
      ...values,
    }),
    [],
  );
}

test("terminal route selection follows managed backend priority", () => {
  const routed = session({
    lease_id: "sandbox:owned",
    attach_url: "wss://attach.example/pty",
  });
  assert.equal(interactivePtyRouteKind({ SANDBOX: {} } as RuntimeEnv, routed), "sandbox");
  assert.equal(interactivePtyRouteKind({} as RuntimeEnv, routed), "attach");
  assert.equal(
    interactivePtyRouteKind({} as RuntimeEnv, session({ lease_id: null, attach_url: null })),
    null,
  );
});

test("terminal route availability covers Sandbox, attach, and GitHub Actions backends", () => {
  assert.equal(
    interactiveTerminalRouteAvailable(
      { SANDBOX: {} } as RuntimeEnv,
      session({ lease_id: "sandbox:owned" }),
    ),
    true,
  );
  assert.equal(
    interactiveTerminalRouteAvailable(
      {} as RuntimeEnv,
      session({ adapter: null, attach_url: "wss://terminal.example/pty" }),
    ),
    true,
  );
  assert.equal(
    interactiveTerminalRouteAvailable(
      {} as RuntimeEnv,
      session({ adapter: null, attach_url: null }),
    ),
    false,
  );
  assert.equal(
    interactiveTerminalRouteAvailable(
      {} as RuntimeEnv,
      session({ runtime: "github_actions", attach_url: null }),
    ),
    true,
  );
});

test("signed attach targets remain opaque and adapter auth is origin-bound", () => {
  const signed = "wss://adapter.example/v1/pty?signature=a%2Bb%2Fc%3D&cols=provider-owned&opaque=1";
  const env = {
    CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example",
    CRABBOX_RUNTIME_ADAPTER_TOKEN: "adapter-token",
  } as RuntimeEnv;
  const current = session({
    adapter: "runtime-v1",
    adapter_control_plane: "https://adapter.example/",
    attach_url: signed,
  });

  assert.deepEqual(interactiveTerminalTarget(env, current, "attach"), {
    url: signed,
    authorization: "Bearer adapter-token",
  });
  assert.equal(
    runtimeAdapterTerminalAuthorization(
      env,
      "default",
      "https://adapter.example",
      "wss://other.example/pty",
    ),
    null,
  );
  assert.equal(
    interactiveTerminalTarget(
      env,
      session({
        adapter: "runtime-v1",
        adapter_control_plane: "https://different.example",
        attach_url: signed,
      }),
      "attach",
    ),
    null,
  );
  assert.deepEqual(
    interactiveTerminalTarget(
      {} as RuntimeEnv,
      session({ adapter: null, attach_url: signed }),
      "attach",
    ),
    { url: signed, authorization: null },
  );
});

test("terminal headers carry canonical session context", () => {
  const current = session({ lease_id: "sandbox:owned" });
  const headers = interactiveTerminalHeaders(current, "Bearer upstream");
  assert.equal(headers.get("upgrade"), "websocket");
  assert.equal(headers.get("x-crabbox-session"), "IS-route");
  assert.equal(headers.get("x-crabbox-repo"), "openclaw/crabfleet");
  assert.equal(headers.get("x-crabbox-runtime"), "crabbox");
  assert.equal(headers.get("authorization"), "Bearer upstream");
});

test("browser terminal websocket origins must match the browser-visible request origin", () => {
  const env = { CRABFLEET_CANONICAL_URL: "https://fleet.example" } as RuntimeEnv;

  assert.doesNotThrow(() =>
    validateTerminalWebSocketOrigin(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { origin: "https://fleet.example", upgrade: "websocket" },
      }),
      env,
      false,
    ),
  );
  assert.doesNotThrow(() =>
    validateTerminalWebSocketOrigin(
      new Request("https://tenant.localhost/api/terminal/ws", {
        headers: { origin: "https://tenant.localhost", upgrade: "websocket" },
      }),
      env,
      false,
    ),
  );
  assert.doesNotThrow(() =>
    validateTerminalWebSocketOrigin(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { upgrade: "websocket" },
      }),
      env,
      false,
    ),
  );
  assert.throws(
    () =>
      validateTerminalWebSocketOrigin(
        new Request("https://fleet.example/api/terminal/ws", {
          headers: { origin: "https://attacker.example", upgrade: "websocket" },
        }),
        env,
        false,
      ),
    { message: "terminal websocket origin is invalid", status: 403 },
  );
  assert.doesNotThrow(() =>
    validateTerminalWebSocketOrigin(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { origin: "https://attacker.example", upgrade: "websocket" },
      }),
      env,
      true,
    ),
  );
});

test("trusted proxy public origin is the browser terminal websocket origin", () => {
  const env = {
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
    CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
    CRABFLEET_TRUSTED_PROXY_SECRET: "proxy-secret",
    CRABFLEET_TRUSTED_PROXY_USER_HEADER: "x-user",
  } as RuntimeEnv;

  assert.doesNotThrow(() =>
    validateTerminalWebSocketOrigin(
      new Request("https://backend.example/api/terminal/ws", {
        headers: { origin: "https://fleet.example", upgrade: "websocket" },
      }),
      env,
      false,
    ),
  );
  assert.throws(
    () =>
      validateTerminalWebSocketOrigin(
        new Request("https://backend.example/api/terminal/ws", {
          headers: { origin: "https://backend.example", upgrade: "websocket" },
        }),
        env,
        false,
      ),
    { message: "terminal websocket origin is invalid", status: 403 },
  );
});
