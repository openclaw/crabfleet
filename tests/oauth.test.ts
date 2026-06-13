import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  githubOAuthCallbackRequestMatches,
  githubOAuthCanonicalLoginUrl,
  githubOAuthCanonicalSshLinkUrl,
  githubOAuthRedirectUri,
} from "../src/oauth.ts";

test("githubOAuthRedirectUri uses configured callback when present", () => {
  assert.equal(
    githubOAuthRedirectUri(
      "https://crabfleet.openclaw.ai/login/github",
      "https://fleet.example/auth/github/callback",
    ),
    "https://fleet.example/auth/github/callback",
  );
});

test("githubOAuthRedirectUri defaults to request origin callback", () => {
  assert.equal(
    githubOAuthRedirectUri("https://crabfleet.openclaw.ai/login/github"),
    "https://crabfleet.openclaw.ai/auth/github/callback",
  );
  assert.equal(
    githubOAuthRedirectUri("http://localhost:8787/login/github"),
    "http://localhost:8787/auth/github/callback",
  );
  assert.throws(
    () => githubOAuthRedirectUri("http://attacker.example/login/github"),
    /HTTPS or loopback HTTP/,
  );
});

test("configured GitHub callback validation fails closed", () => {
  for (const configured of [
    "",
    " https://fleet.example/auth/github/callback",
    "http://fleet.example/auth/github/callback",
    "https:fleet.example/auth/github/callback",
    "https://user:secret@fleet.example/auth/github/callback",
    "https://@fleet.example/auth/github/callback",
    "https://fleet.example/auth/github/call back",
    "https://fleet.example/auth/github/callback?tenant=a",
    "https://fleet.example/auth/github/callback#fragment",
    "https://fleet.example/auth/github/callback/",
    "https://fleet.example/other/callback",
    "/auth/github/callback",
  ]) {
    assert.throws(
      () => githubOAuthRedirectUri("https://request.example/login/github", configured),
      /GITHUB_REDIRECT_URI/,
      configured,
    );
  }
});

test("configured GitHub origin is authoritative across host mismatches", () => {
  const configured = "https://fleet.example/auth/github/callback";
  assert.equal(
    githubOAuthCanonicalLoginUrl("https://attacker.example/login/github", configured),
    "https://fleet.example/login/github",
  );
  assert.equal(
    githubOAuthCanonicalLoginUrl("https://fleet.example/login/github", configured),
    null,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://fleet.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    true,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://attacker.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    false,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "http://fleet.example/auth/github/callback?code=a&state=b",
      configured,
    ),
    false,
  );
  assert.equal(
    githubOAuthCallbackRequestMatches(
      "https://fleet.example/login/github?code=a&state=b",
      configured,
    ),
    false,
  );
});

test("SSH link state canonicalizes before host-only OAuth cookies", async () => {
  const configured = "https://fleet.example/auth/github/callback";
  assert.equal(
    githubOAuthCanonicalSshLinkUrl(
      "https://alias.example/ssh/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    "https://fleet.example/ssh/link/code%2Fwith%2Fslashes",
  );
  assert.equal(
    githubOAuthCanonicalSshLinkUrl(
      "https://fleet.example/ssh/link/code%2Fwith%2Fslashes",
      "code/with/slashes",
      configured,
    ),
    null,
  );
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const linkStart = source.indexOf("async function sshLink(");
  const linkEnd = source.indexOf("async function consumeSshLink", linkStart);
  const linkSource = source.slice(linkStart, linkEnd);
  assert.match(linkSource, /githubOAuthCanonicalSshLinkUrl/);
  assert.ok(linkSource.indexOf("canonicalLinkUrl") < linkSource.indexOf("sshLinkCookie"));
});

test("OAuth initiation and token exchange share the authoritative callback", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const loginStart = source.indexOf("async function githubLogin");
  const callbackStart = source.indexOf("async function githubCallback", loginStart);
  const loginSource = source.slice(loginStart, callbackStart);
  const callbackEnd = source.indexOf("async function sshLink", callbackStart);
  const callbackSource = source.slice(callbackStart, callbackEnd);

  assert.match(loginSource, /githubOAuthRedirectUri\(url, env\.GITHUB_REDIRECT_URI\)/);
  assert.match(loginSource, /githubOAuthCanonicalLoginUrl\(url, env\.GITHUB_REDIRECT_URI\)/);
  assert.ok(loginSource.indexOf("canonicalLoginUrl") < loginSource.indexOf("crypto.randomUUID"));
  assert.match(callbackSource, /githubOAuthCallbackRequestMatches/);
  assert.ok(
    callbackSource.indexOf("githubOAuthCallbackRequestMatches") <
      callbackSource.indexOf('fetch("https://github.com/login/oauth/access_token"'),
  );
  assert.match(callbackSource, /redirect_uri: redirectUri/);
});
