import assert from "node:assert/strict";
import test from "node:test";

import {
  handleProvisioningRoute,
  type ProvisioningRouteDependencies,
} from "../src/worker/routes/provisioning.ts";

function request(method: string, path: string): Request {
  return new Request(`https://fleet.example${path}`, { method });
}

function dependencies(calls: string[]): ProvisioningRouteDependencies {
  return {
    async provision() {
      calls.push("provision");
      return { handler: "provision" };
    },
    async stop(_request, provisionId) {
      calls.push(`stop:${provisionId}`);
      return { handler: "stop" };
    },
    async openPty(_request, provisionId) {
      calls.push(`pty:${provisionId}`);
      return new Response("pty", { headers: { "x-handler": "pty" } });
    },
  };
}

async function dispatch(value: Request, calls: string[]): Promise<Response | null> {
  return handleProvisioningRoute(value, new URL(value.url), dependencies(calls));
}

test("provisioning routes dispatch JSON operations and preserve raw PTY responses", async () => {
  const cases: Array<[Request, number, string[], string | null]> = [
    [request("POST", "/api/provision/interactive"), 200, ["provision"], null],
    [
      request("POST", "/api/provision/interactive/provision%2F1/stop"),
      200,
      ["stop:provision/1"],
      null,
    ],
    [
      request("GET", "/api/provision/interactive/provision%2F1/pty"),
      200,
      ["pty:provision/1"],
      "pty",
    ],
  ];

  for (const [value, expectedStatus, expectedCalls, expectedHandler] of cases) {
    const calls: string[] = [];
    const result = await dispatch(value, calls);
    assert.equal(result?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
    assert.equal(result?.headers.get("x-handler"), expectedHandler);
  }
});

test("provisioning routes use exact methods and paths", async () => {
  const calls: string[] = [];
  for (const value of [
    request("GET", "/api/provision/interactive"),
    request("DELETE", "/api/provision/interactive/provision-1/stop"),
    request("POST", "/api/provision/interactive/provision-1/pty"),
    request("GET", "/api/provision/interactive/provision-1"),
    request("GET", "/api/provision/interactive/provision-1/pty/extra"),
  ]) {
    assert.equal(await dispatch(value, calls), null);
  }
  assert.deepEqual(calls, []);
});
