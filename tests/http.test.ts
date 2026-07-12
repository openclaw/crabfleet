import assert from "node:assert/strict";
import test from "node:test";

import {
  badRequest,
  bearer,
  bearerToken,
  conflict,
  cookie,
  cookies,
  forbidden,
  json,
  notFound,
  readBoundedJson,
  readJson,
  redirect,
  serviceUnavailable,
  text,
  tooManyRequests,
  unauthorized,
  wantsMarkdown,
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

test("redirects preserve caller headers and Markdown negotiation is explicit", () => {
  const response = redirect("https://fleet.example/app", { "cache-control": "no-store" });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "https://fleet.example/app");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(
    wantsMarkdown(
      new Request("https://fleet.example/docs", { headers: { accept: "text/markdown" } }),
    ),
    true,
  );
  assert.equal(wantsMarkdown(new Request("https://fleet.example/docs")), false);
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
  assert.equal(bearer("token-value"), "Bearer token-value");
  assert.equal(bearer(undefined), null);

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
  assert.equal(
    cookie(request, "session", "hello world", 60),
    "session=hello%20world; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=60",
  );
  assert.equal(
    cookie(new Request("http://localhost:8787"), "session", "local", 60).includes("; Secure"),
    false,
  );
});
