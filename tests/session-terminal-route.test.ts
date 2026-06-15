import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  interactiveBridgeUrl,
  interactivePtyRouteKind,
  interactiveTerminalHeaders,
  interactiveTerminalTarget,
  runtimeAdapterTerminalAuthorization,
  terminalQuery,
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
  assert.equal(
    interactivePtyRouteKind(
      { CRABBOX_PTY_BRIDGE_URL: "https://bridge.example/{id}" } as RuntimeEnv,
      routed,
    ),
    "bridge",
  );
  assert.equal(interactivePtyRouteKind({} as RuntimeEnv, routed), "attach");
});

test("bridge targets expand templates, append session context, and use bridge auth", () => {
  const current = session({ lease_id: "bridge:lease/1" });
  const env = {
    CRABBOX_PTY_BRIDGE_URL: "https://bridge.example/pty/{id}/{leaseId}?existing=opaque&repo={repo}",
    CRABBOX_PTY_BRIDGE_TOKEN: "bridge-token",
  } as RuntimeEnv;
  const target = interactiveTerminalTarget(env, current, "bridge");

  assert.equal(
    target?.url,
    "wss://bridge.example/pty/IS-route/bridge%3Alease%2F1?existing=opaque&repo=openclaw%2Fcrabfleet&sessionId=IS-route&leaseId=bridge%3Alease%2F1&branch=feature%2Fterminal+route&runtime=crabbox&profile=default&command=codex+--yolo",
  );
  assert.equal(target?.authorization, "Bearer bridge-token");
  assert.equal(interactiveBridgeUrl("not a url", current), "");
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
  assert.deepEqual(terminalQuery(current), {
    sessionId: "IS-route",
    leaseId: "sandbox:owned",
    repo: "openclaw/crabfleet",
    branch: "feature/terminal route",
    runtime: "crabbox",
    profile: "default",
    command: "codex --yolo",
  });

  const headers = interactiveTerminalHeaders(current, "Bearer upstream");
  assert.equal(headers.get("upgrade"), "websocket");
  assert.equal(headers.get("x-crabbox-session"), "IS-route");
  assert.equal(headers.get("x-crabbox-repo"), "openclaw/crabfleet");
  assert.equal(headers.get("x-crabbox-runtime"), "crabbox");
  assert.equal(headers.get("authorization"), "Bearer upstream");
});
