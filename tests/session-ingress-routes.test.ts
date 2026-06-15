import assert from "node:assert/strict";
import test from "node:test";

import {
  handleSessionIngressRoute,
  type SessionIngressRouteDependencies,
} from "../src/worker/routes/session-ingress.ts";

function request(method: string, path: string): Request {
  return new Request(`https://fleet.example${path}`, { method });
}

function dependencies(calls: string[]): SessionIngressRouteDependencies {
  return {
    async readSharedSession(sessionId, token) {
      calls.push(`shared:${sessionId}:${token}`);
      return { handler: "shared" };
    },
    async openTerminal() {
      calls.push("terminal");
      return new Response("terminal", { headers: { "x-handler": "terminal" } });
    },
  };
}

async function dispatch(value: Request, calls: string[]): Promise<Response | null> {
  return handleSessionIngressRoute(value, new URL(value.url), dependencies(calls));
}

test("session ingress routes decode shared sessions and preserve terminal responses", async () => {
  const sharedCalls: string[] = [];
  const shared = await dispatch(
    request("GET", "/api/shared-sessions/IS%2F2?token=share%20token"),
    sharedCalls,
  );
  assert.equal(shared?.status, 200);
  assert.deepEqual(sharedCalls, ["shared:IS/2:share token"]);

  const terminalCalls: string[] = [];
  const terminal = await dispatch(request("GET", "/api/terminal/ws"), terminalCalls);
  assert.equal(terminal?.status, 200);
  assert.equal(terminal?.headers.get("x-handler"), "terminal");
  assert.deepEqual(terminalCalls, ["terminal"]);
});

test("session ingress routes use exact methods and paths", async () => {
  const calls: string[] = [];
  for (const value of [
    request("POST", "/api/shared-sessions/IS-2"),
    request("GET", "/api/shared-sessions"),
    request("GET", "/api/shared-sessions/IS-2/"),
    request("POST", "/api/terminal/ws"),
    request("GET", "/api/terminal/ws/extra"),
  ]) {
    assert.equal(await dispatch(value, calls), null);
  }
  assert.deepEqual(calls, []);
});
