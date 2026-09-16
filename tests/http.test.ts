import assert from "node:assert/strict";
import test from "node:test";

import {
  badRequest,
  bearerToken,
  conflict,
  cookie,
  cookies,
  forbidden,
  json,
  notFound,
  readBoundedJson,
  readBoundedText,
  readJson,
  redirect,
  serviceUnavailable,
  text,
  tooManyRequests,
  unauthorized,
} from "../src/worker/http.ts";

test("JSON and text responses apply security, cache, and byte-length headers", async () => {
  const jsonResponse = json({ message: "crab" }, { status: 201 });
  assert.equal(jsonResponse.status, 201);
  assert.equal(jsonResponse.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(jsonResponse.headers.get("cache-control"), "no-store");
  assert.equal(jsonResponse.headers.get("x-content-type-options"), "nosniff");
  assert.equal(
    Number(jsonResponse.headers.get("content-length")),
    new TextEncoder().encode(await jsonResponse.clone().text()).byteLength,
  );

  const textResponse = text("hello\n", "text/plain; charset=utf-8");
  assert.equal(textResponse.headers.get("cache-control"), "public, max-age=300");
  assert.equal(textResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(textResponse.headers.get("content-length"), "6");
});

test("redirects preserve caller headers", () => {
  const response = redirect("https://fleet.example/app", { "cache-control": "no-store" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://fleet.example/app");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("response helpers accept every HeadersInit form with case-insensitive overrides", () => {
  for (const overrides of [
    { "Cache-Control": "private", "X-Request-ID": "request-1", "Content-Length": "999" },
    new Headers({
      "cache-control": "private",
      "x-request-id": "request-1",
      "content-length": "999",
    }),
    [
      ["Cache-Control", "private"],
      ["X-Request-ID", "request-1"],
      ["Content-Length", "999"],
    ],
  ] as HeadersInit[]) {
    for (const response of [
      text("🦀", "text/plain", overrides),
      json("🦀", { headers: overrides }),
      redirect("/app", overrides),
    ]) {
      assert.equal(response.headers.get("cache-control"), "private");
      assert.equal(response.headers.get("x-request-id"), "request-1");
      if (response.status !== 302) {
        assert.equal(
          response.headers.get("content-length"),
          response.headers.get("content-type") === "text/plain" ? "4" : "6",
        );
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      }
    }
  }
});

test("response helpers preserve separately supplied cookies", () => {
  const values = ["session=fixture; HttpOnly", "csrf=fixture; SameSite=Strict"];
  const tuples: [string, string][] = values.map((value) => ["set-cookie", value]);
  for (const overrides of [tuples, new Headers(tuples)]) {
    for (const response of [
      text("ok", "text/plain", overrides),
      json({ ok: true }, { headers: overrides }),
      redirect("/app", overrides),
    ]) {
      assert.deepEqual(response.headers.getSetCookie(), values);
    }
  }
});

test("JSON parsing and status errors retain stable messages and status codes", async () => {
  assert.deepEqual(
    await readJson<{ value: number }>(
      new Request("https://fleet.example", { method: "POST", body: '{"value":42}' }),
    ),
    { value: 42 },
  );
  await assert.rejects(
    readJson(new Request("https://fleet.example", { method: "POST", body: "{" })),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "invalid json" &&
      "status" in error &&
      error.status === 400,
  );
  const rejectedBody = new ReadableStream({
    start(controller) {
      controller.error(new Error("request body aborted"));
    },
  });
  await assert.rejects(
    readJson(
      new Request("https://fleet.example", {
        method: "POST",
        body: rejectedBody,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "invalid json" &&
      "status" in error &&
      error.status === 400,
  );

  for (const [error, status, message] of [
    [unauthorized(), 401, "unauthorized"],
    [forbidden("blocked"), 403, "blocked"],
    [notFound("missing"), 404, "missing"],
    [conflict("raced"), 409, "raced"],
    [tooManyRequests("slow down"), 429, "slow down"],
    [serviceUnavailable("offline"), 503, "offline"],
    [badRequest("invalid"), 400, "invalid"],
  ] as const) {
    assert.equal(error.status, status);
    assert.equal(error.message, message);
  }
});

test("bounded JSON parsing rejects declared and streamed bodies before unbounded parsing", async () => {
  const limit = 16;
  assert.deepEqual(
    await readBoundedJson<{ value: number }>(
      new Request("https://fleet.example", { method: "POST", body: '{"value":42}' }),
      limit,
    ),
    { value: 42 },
  );

  for (const request of [
    new Request("https://fleet.example", {
      method: "POST",
      headers: { "content-length": "17" },
      body: "{}",
    }),
    new Request("https://fleet.example", {
      method: "POST",
      body: JSON.stringify({ value: "oversized" }),
    }),
  ]) {
    await assert.rejects(readBoundedJson(request, limit), (error: unknown) => {
      assert.equal(
        typeof error === "object" && error && "status" in error ? error.status : undefined,
        413,
      );
      return true;
    });
  }
});

test("bounded text enforces byte limits across chunks and releases the stream reader", async () => {
  const encoded = new TextEncoder().encode("a🦀b");
  const makeRequest = (maximumChunk: number, onCancel = () => {}) => {
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === encoded.length) return controller.close();
        controller.enqueue(encoded.slice(offset, offset + maximumChunk));
        offset = Math.min(encoded.length, offset + maximumChunk);
      },
      cancel: onCancel,
    });
    return new Request("https://fleet.example", {
      method: "POST",
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
  };
  const accepted = makeRequest(2);
  assert.equal(await readBoundedText(accepted, encoded.length), "a🦀b");
  assert.equal(accepted.body?.locked, false);

  let cancelled = false;
  const rejected = makeRequest(2, () => {
    cancelled = true;
  });
  await assert.rejects(
    readBoundedText(rejected, 3, { tooLargeMessage: "request body too large" }),
    {
      status: 413,
      message: "request body too large",
    },
  );
  assert.equal(cancelled, true);
  assert.equal(rejected.body?.locked, false);
  await assert.rejects(
    readBoundedText(new Request("https://fleet.example"), 16, {
      emptyBodyMessage: "invalid native authorization form",
    }),
    { status: 400, message: "invalid native authorization form" },
  );
});

test("JSON parsing rejects integers that cannot round-trip exactly", async () => {
  for (const body of [
    '{"value":9007199254740993}',
    '{"value":9007199254740991.1}',
    '{"value":1.0000000000000001}',
    '{"value":-0}',
    '{"nested":[1e400]}',
  ]) {
    for (const parse of [
      () => readJson(new Request("https://fleet.example", { method: "POST", body })),
      () =>
        readBoundedJson(
          new Request("https://fleet.example", { method: "POST", body }),
          body.length + 1,
        ),
    ]) {
      await assert.rejects(parse(), (error: unknown) => {
        assert.equal(
          typeof error === "object" && error && "status" in error ? error.status : undefined,
          400,
        );
        assert.match(error instanceof Error ? error.message : "", /round-trippable/);
        return true;
      });
    }
  }
});

test("JSON parsing accepts exact integer-equivalent numeric forms", async () => {
  for (const body of ['{"value":1.0}', '{"value":1e0}', '{"value":100e-2}']) {
    assert.deepEqual(
      await readJson<{ value: number }>(
        new Request("https://fleet.example", { method: "POST", body }),
      ),
      { value: 1 },
    );
  }
});

test("JSON parsing handles deeply nested bounded payloads without exhausting the call stack", async () => {
  const depth = 20_000;
  const body = `${"[".repeat(depth)}0${"]".repeat(depth)}`;
  let current = await readBoundedJson<unknown>(
    new Request("https://fleet.example", { method: "POST", body }),
    body.length,
  );
  for (let index = 0; index < depth; index += 1) {
    assert.ok(Array.isArray(current));
    current = current[0];
  }
  assert.equal(current, 0);
});

test("bearer and cookie helpers normalize only their owned protocol surface", () => {
  assert.equal(
    bearerToken(
      new Request("https://fleet.example", { headers: { authorization: "bEaReR token-value" } }),
    ),
    "token-value",
  );
  assert.equal(
    bearerToken(
      new Request("https://fleet.example", { headers: { authorization: "Basic token-value" } }),
    ),
    "",
  );

  const request = new Request("https://fleet.example", {
    headers: { cookie: "session=hello%20world; mode=read" },
  });
  assert.deepEqual(
    [...cookies(request)],
    [
      ["session", "hello world"],
      ["mode", "read"],
    ],
  );
  assert.deepEqual(
    [
      ...cookies(
        new Request("https://fleet.example", {
          headers: { cookie: "ok=hello%20world; bad=%; keep=fine" },
        }),
      ),
    ],
    [
      ["ok", "hello world"],
      ["keep", "fine"],
    ],
  );
  assert.equal(
    cookie(request, "session", "hello world", 60),
    "session=hello%20world; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60",
  );
  assert.equal(
    cookie(new Request("http://localhost:8787"), "session", "local", 60).includes("; Secure"),
    false,
  );
});
