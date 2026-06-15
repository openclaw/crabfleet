import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredHttpOrigin,
  developmentIdentityEnabled,
  exactSecureHttpUrl,
  exactSecureWebSocketUrl,
  normalizedSecureHttpUrl,
  normalizedSecureWebSocketUrl,
  strictSecureHttpOrigin,
} from "../src/url-security.ts";

test("secure URL validators share exact loopback and credential rules", () => {
  const cases = [
    ["https://service.example/path", true],
    ["http://localhost:8787/path", true],
    ["http://127.0.0.1:8787/path", true],
    ["http://[::1]:8787/path", true],
    ["http://service.example/path", false],
    ["http://127.1:8787/path", false],
    ["http://2130706433:8787/path", false],
    ["https://user:secret@service.example/path", false],
    [" https://service.example/path", false],
    ["https://service.example/path\n", false],
  ] as const;

  for (const [value, accepted] of cases) {
    assert.equal(exactSecureHttpUrl(value) !== null, accepted, value);
    assert.equal(normalizedSecureHttpUrl(value) !== null, accepted, value);
  }

  const signed = "https://Service.Example:443/%7Epath?signature=a%2Bb%2Fc%3D&dup=1&dup=2";
  assert.equal(exactSecureHttpUrl(signed), signed);
  assert.equal(
    normalizedSecureHttpUrl(signed),
    "https://service.example/%7Epath?signature=a%2Bb%2Fc%3D&dup=1&dup=2",
  );
});

test("WebSocket URL validators require WSS except exact literal loopback WS", () => {
  for (const [value, accepted] of [
    ["wss://terminal.example/path", true],
    ["ws://localhost:8787/path", true],
    ["ws://127.0.0.1:8787/path", true],
    ["ws://[::1]:8787/path", true],
    ["ws://terminal.example/path", false],
    ["ws://127.1:8787/path", false],
    ["wss://user:secret@terminal.example/path", false],
  ] as const) {
    assert.equal(exactSecureWebSocketUrl(value) !== null, accepted, value);
    assert.equal(normalizedSecureWebSocketUrl(value) !== null, accepted, value);
  }
});

test("strict origins reject paths, credentials, queries, fragments, and inexact input", () => {
  assert.equal(strictSecureHttpOrigin("https://fleet.example"), "https://fleet.example");
  assert.equal(strictSecureHttpOrigin("https://fleet.example/"), "https://fleet.example");
  assert.equal(strictSecureHttpOrigin("http://localhost:8787"), "http://localhost:8787");
  for (const value of [
    " https://fleet.example",
    "https://fleet.example/path",
    "https://fleet.example?query=1",
    "https://fleet.example#fragment",
    "https://user@fleet.example",
    "http://fleet.example",
    "http://127.1:8787",
  ]) {
    assert.equal(strictSecureHttpOrigin(value), null, value);
  }
});

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
