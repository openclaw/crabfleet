import assert from "node:assert/strict";
import test from "node:test";

import { configuredHttpOrigin, developmentIdentityEnabled } from "../src/url-security.ts";

test("configured origins require HTTPS except literal loopback HTTP", () => {
  const fallback = "https://fleet.example";
  assert.equal(
    configuredHttpOrigin("https://internal.example/path", fallback),
    "https://internal.example",
  );
  assert.equal(
    configuredHttpOrigin("http://localhost:8787/path", fallback),
    "http://localhost:8787",
  );
  assert.equal(
    configuredHttpOrigin("http://127.0.0.1:8787/path", fallback),
    "http://127.0.0.1:8787",
  );
  assert.equal(configuredHttpOrigin("http://internal.example", fallback), fallback);
  assert.equal(configuredHttpOrigin("https://user:secret@internal.example", fallback), fallback);
});

test("development identity requires an explicit true gate and literal loopback host", () => {
  assert.equal(developmentIdentityEnabled(undefined, "http://localhost:8787"), false);
  assert.equal(developmentIdentityEnabled("false", "http://localhost:8787"), false);
  assert.equal(developmentIdentityEnabled("TRUE", "http://localhost:8787"), false);
  assert.equal(developmentIdentityEnabled("true", "http://localhost:8787"), true);
  assert.equal(developmentIdentityEnabled("true", "http://127.0.0.1:8787"), true);
  assert.equal(developmentIdentityEnabled("true", "http://[::1]:8787"), true);
  assert.equal(developmentIdentityEnabled("true", "http://tenant.localhost:8787"), false);
  assert.equal(developmentIdentityEnabled("true", "https://fleet.example"), false);
  assert.equal(developmentIdentityEnabled("true", "not a url"), false);
});
