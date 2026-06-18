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
