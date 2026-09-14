import assert from "node:assert/strict";
import test from "node:test";

import { api, DEFAULT_FETCH_TIMEOUT_MS } from "../src/app/api.js";

test("browser API aborts stalled requests after the default deadline", async (t) => {
  const timeout = AbortSignal.timeout;
  const durations: number[] = [];
  t.mock.method(AbortSignal, "timeout", (duration: number) => {
    durations.push(duration);
    return timeout(10);
  });
  t.mock.method(globalThis, "fetch", async (_path: string, options: RequestInit) => {
    const signal = options.signal!;
    return new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  });
  // Keep the event loop alive while AbortSignal's unreferenced timer runs.
  const watchdog = setTimeout(() => {}, 1000);
  try {
    await assert.rejects(api("/api/fleet"), { name: "TimeoutError" });
    assert.deepEqual(durations, [DEFAULT_FETCH_TIMEOUT_MS]);
    assert.equal(DEFAULT_FETCH_TIMEOUT_MS, 30_000);
  } finally {
    clearTimeout(watchdog);
  }
});

test("browser API preserves caller cancellation and request options", async (t) => {
  const controller = new AbortController();
  const body = JSON.stringify({ value: "@test-person", role: "viewer" });
  t.mock.method(AbortSignal, "timeout", () => {
    assert.fail("a caller signal must replace the default deadline");
  });
  t.mock.method(globalThis, "fetch", async (path: string, options: RequestInit) => {
    assert.equal(path, "/api/admin/allow");
    assert.equal(options.method, "POST");
    assert.equal(options.body, body);
    assert.deepEqual(options.headers, {
      "content-type": "application/json",
      accept: "application/json",
    });
    assert.equal(options.signal, controller.signal);
    return new Promise((_resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason), {
        once: true,
      });
    });
  });
  const pending = api("/api/admin/allow", {
    method: "POST",
    body,
    headers: { accept: "application/json" },
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});

test("browser API retains JSON results and HTTP error status for session handling", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ user: { name: "Test" } }));
  assert.deepEqual(await api("/api/session"), { user: { name: "Test" } });

  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ error: "Sign in again" }, { status: 401 }),
  );
  await assert.rejects(api("/api/session"), { message: "Sign in again", status: 401 });
});
