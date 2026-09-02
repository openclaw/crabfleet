import assert from "node:assert/strict";
import test from "node:test";

import { api, DEFAULT_FETCH_TIMEOUT_MS } from "../src/app/api.js";

function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

function hangUntilAborted(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const fail = () => reject(signal.reason ?? abortError());
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

async function withMockedFetch<T>(
  mock: typeof fetch,
  timeoutMs: number | null,
  run: () => Promise<T>,
): Promise<{ result: T; timeoutArgs: number[] }> {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeoutArgs: number[] = [];
  globalThis.fetch = mock;
  if (timeoutMs !== null) {
    AbortSignal.timeout = (ms: number) => {
      timeoutArgs.push(ms);
      return originalTimeout(timeoutMs);
    };
  }
  try {
    return { result: await run(), timeoutArgs };
  } finally {
    globalThis.fetch = originalFetch;
    AbortSignal.timeout = originalTimeout;
  }
}

test("api() aborts a hung fetch with the default timeout", async () => {
  await withMockedFetch(hangUntilAborted, 20, async () => {
    const pending = api("/api/state");
    const watchdog = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("did not abort hung api() fetch")), 200);
    });
    await assert.rejects(Promise.race([pending, watchdog]), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "TimeoutError");
      return true;
    });
  });
});

test("api() requests AbortSignal.timeout with the shared default duration", async () => {
  const { timeoutArgs } = await withMockedFetch(hangUntilAborted, 20, async () => {
    const pending = api("/api/state");
    const watchdog = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("did not abort hung api() fetch")), 200);
    });
    await assert.rejects(Promise.race([pending, watchdog]), (error: unknown) => {
      assert.ok(error instanceof DOMException);
      assert.equal(error.name, "TimeoutError");
      return true;
    });
    return undefined;
  });
  assert.deepEqual(timeoutArgs, [DEFAULT_FETCH_TIMEOUT_MS]);
});

test("api() keeps a caller-provided signal instead of replacing it", async () => {
  const controller = new AbortController();
  let seen: AbortSignal | undefined;
  await withMockedFetch(
    async (_input, init) => {
      seen = init?.signal;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
    null,
    async () => api("/api/state", { signal: controller.signal }),
  );
  assert.equal(seen, controller.signal);
});
