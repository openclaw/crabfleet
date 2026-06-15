import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("proxy users cannot consume a cookie session GitHub credential", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function createInteractiveSession(");
  const createEnd = source.indexOf("async function createInteractiveSessionFromInput", createStart);
  const createSource = source.slice(createStart, createEnd);
  assert.match(createSource, /user\.subject\.startsWith\("github:"\)/);
  assert.match(createSource, /sessionGitHubToken\(request, env, user\.subject\)/);

  const tokenStart = source.indexOf("async function sessionGitHubToken(");
  const tokenEnd = source.indexOf("async function sandboxSessionWithGitHubToken", tokenStart);
  assert.match(source.slice(tokenStart, tokenEnd), /\.where\("subject", "=", expectedSubject\)/);
});

test("trusted proxy requests stay sanitized on terminal forwarding paths", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const standaloneStart = source.indexOf("async function standaloneSandboxPty(");
  const standaloneEnd = source.indexOf("function standaloneSandboxTerminalGrant", standaloneStart);
  assert.match(
    source.slice(standaloneStart, standaloneEnd),
    /sanitizeTrustedProxyRequest\(request, env\)/,
  );

  const openStart = source.indexOf("async function openSandboxTerminalResponse(");
  const openEnd = source.indexOf("async function ensureSandboxTerminalPrepared", openStart);
  assert.match(source.slice(openStart, openEnd), /terminalSession\.terminal\(request, options\)/);
});

test("trusted proxy sign-in cannot pretend that local logout will end the session", async () => {
  const source = await readFile(new URL("../src/app/main.jsx", import.meta.url), "utf8");
  assert.match(source, /user\?\.subject\?\.startsWith\("proxy:"\)/);
  assert.match(source, /disabled=\{trustedProxyUser\}/);
  assert.match(source, /Signed in by your organization/);
});

test("split-origin links use the browser-visible proxy origin", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  assert.match(source, /trustedProxyPublicOrigin\(env\) \?\? new URL\(request\.url\)\.origin/);
  assert.match(source, /shareUrl\(request, env, id, token\)/);
  assert.match(source, /externalRequestOrigin\(request, env\)/);
  assert.match(source, /runtimeAdapterBrowserVncUrl\(browserAppOrigin\(env\), session\.id\)/);
  assert.match(
    source,
    /browserUrl: `\$\{browserAppOrigin\(env\)\}\/app\/sessions\/\$\{encodeURIComponent\(existing\.id\)\}`/,
  );
  assert.match(
    source,
    /new URL\(githubOAuthRedirectUri\(request\.url, env\.GITHUB_REDIRECT_URI\)\)\.origin/,
  );
});
