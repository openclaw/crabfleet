import assert from "node:assert/strict";
import test from "node:test";

import { ResponseBodyLimitError } from "../src/bounded-response.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  interactiveTerminalFetch,
  readRuntimeAdapterResponseBody,
  runtimeAdapterFetch,
  runtimeAdapterFetcher,
} from "../src/worker/runtime-adapter-transport.ts";

type FetchCall = {
  input: RequestInfo | URL;
  init?: RequestInit;
};

function recordingFetcher(response: Response): {
  fetcher: Fetcher;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  return {
    calls,
    fetcher: {
      async fetch(input, init) {
        calls.push({ input, init });
        return response;
      },
    } as Fetcher,
  };
}

test("runtime adapter fetcher selects the coordinator only for its exact origin", () => {
  const coordinator = recordingFetcher(new Response()).fetcher;
  const fallback = recordingFetcher(new Response()).fetcher;
  const env = {
    CRABBOX_COORDINATOR: coordinator,
    CRABBOX_COORDINATOR_ORIGIN: "https://adapter.example/base",
  } as RuntimeEnv;

  assert.equal(
    runtimeAdapterFetcher(env, new URL("https://adapter.example/v1"), fallback),
    coordinator,
  );
  assert.equal(
    runtimeAdapterFetcher(env, new URL("wss://adapter.example/v1"), fallback),
    coordinator,
  );
  assert.equal(runtimeAdapterFetcher(env, new URL("https://other.example/v1"), fallback), fallback);
  assert.equal(
    runtimeAdapterFetcher({} as RuntimeEnv, new URL("https://adapter.example"), fallback),
    fallback,
  );
});

test("runtime adapter lifecycle fetches authenticate, bound redirects, and reject unsafe targets", async () => {
  const ok = recordingFetcher(new Response("{}", { status: 200 }));
  const env = {
    CRABBOX_COORDINATOR: ok.fetcher,
    CRABBOX_COORDINATOR_ORIGIN: "https://adapter.example",
    CRABBOX_RUNTIME_ADAPTER_TOKEN: " adapter-token ",
  } as RuntimeEnv;
  const response = await runtimeAdapterFetch(
    env,
    "https://adapter.example/v1/workspaces",
    { method: "POST", body: "{}" },
    recordingFetcher(new Response("fallback")).fetcher,
  );
  assert.equal(response.status, 200);
  assert.equal(ok.calls.length, 1);
  assert.equal(String(ok.calls[0]?.input), "https://adapter.example/v1/workspaces");
  const request = ok.calls[0]?.init;
  assert.equal(request?.method, "POST");
  assert.equal(request?.redirect, "manual");
  assert.ok(request?.signal instanceof AbortSignal);
  const headers = new Headers(request?.headers);
  assert.equal(headers.get("authorization"), "Bearer adapter-token");
  assert.equal(headers.get("accept"), "application/json");
  assert.equal(headers.get("content-type"), "application/json");

  const redirect = recordingFetcher(
    new Response(null, { status: 302, headers: { location: "https://other.example" } }),
  );
  await assert.rejects(
    runtimeAdapterFetch(
      {
        ...env,
        CRABBOX_COORDINATOR: redirect.fetcher,
      },
      "https://adapter.example/v1/workspaces",
      { method: "GET" },
    ),
    { message: "runtime adapter redirect refused" },
  );
  await assert.rejects(
    runtimeAdapterFetch(
      { CRABBOX_RUNTIME_ADAPTER_TOKEN: "token" } as RuntimeEnv,
      "http://adapter.example",
      {},
      ok.fetcher,
    ),
    { message: "runtime adapter URL must use HTTPS or loopback HTTP" },
  );
  await assert.rejects(
    runtimeAdapterFetch({} as RuntimeEnv, "https://adapter.example", {}, ok.fetcher),
    { message: "runtime adapter token is not configured" },
  );
});

test("terminal upgrades use the coordinator for adapter sessions and normalize WebSocket schemes", async () => {
  const coordinator = recordingFetcher(new Response(null, { status: 200 }));
  const fallback = recordingFetcher(new Response(null, { status: 200 }));
  const env = {
    CRABBOX_COORDINATOR: coordinator.fetcher,
    CRABBOX_COORDINATOR_ORIGIN: "https://adapter.example",
  } as RuntimeEnv;
  const headers = new Headers({ upgrade: "websocket" });

  await interactiveTerminalFetch(
    env,
    { adapter: "runtime-v1" },
    "wss://adapter.example/v1/terminal?signature=opaque",
    headers,
    fallback.fetcher,
  );
  assert.equal(
    String(coordinator.calls[0]?.input),
    "https://adapter.example/v1/terminal?signature=opaque",
  );
  assert.equal(new Headers(coordinator.calls[0]?.init?.headers).get("upgrade"), "websocket");

  await interactiveTerminalFetch(
    env,
    { adapter: null },
    "ws://127.0.0.1:8787/terminal",
    headers,
    fallback.fetcher,
  );
  assert.equal(String(fallback.calls[0]?.input), "http://127.0.0.1:8787/terminal");
});

test("runtime adapter response parsing is bounded and preserves non-JSON error text", async () => {
  assert.deepEqual(
    await readRuntimeAdapterResponseBody(
      new Response('{"status":"ready","workspaceId":"workspace-1"}'),
    ),
    { status: "ready", workspaceId: "workspace-1" },
  );
  assert.deepEqual(await readRuntimeAdapterResponseBody(new Response("provider unavailable")), {
    message: "provider unavailable",
  });
  assert.equal(await readRuntimeAdapterResponseBody(new Response(null)), null);
  await assert.rejects(
    readRuntimeAdapterResponseBody(
      new Response("small", { headers: { "content-length": String(64 * 1024 + 1) } }),
    ),
    ResponseBodyLimitError,
  );
});
