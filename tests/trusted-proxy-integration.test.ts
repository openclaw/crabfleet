import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { appUserPresentation } from "../src/app/app-shell-state.js";

test("interactive session creation requests browser credentials only for GitHub users", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const createStart = source.indexOf("async function createInteractiveSession(");
  const createEnd = source.indexOf("async function createInteractiveSessionFromInput", createStart);
  const createSource = source.slice(createStart, createEnd);
  assert.match(createSource, /user\.subject\.startsWith\("github:"\)/);
  assert.match(createSource, /sessionGitHubToken\(request, env, user\.subject\)/);
});

test("trusted proxy requests stay sanitized on terminal forwarding paths", async () => {
  const sandboxRuntimeSource = await readFile(
    new URL("../src/worker/sandbox-runtime.ts", import.meta.url),
    "utf8",
  );
  const provisioningEndpointSource = await readFile(
    new URL("../src/worker/provisioning/endpoints.ts", import.meta.url),
    "utf8",
  );
  const standaloneStart = provisioningEndpointSource.indexOf("async openPty(");
  const standaloneEnd = provisioningEndpointSource.indexOf("private authorize(", standaloneStart);
  assert.match(
    provisioningEndpointSource.slice(standaloneStart, standaloneEnd),
    /sanitizeTrustedProxyRequest\(request, this\.env\)/,
  );

  const openStart = sandboxRuntimeSource.indexOf(
    "export async function openSandboxTerminalResponse(",
  );
  const openEnd = sandboxRuntimeSource.indexOf("export function sandboxSessionEnv", openStart);
  assert.match(
    sandboxRuntimeSource.slice(openStart, openEnd),
    /terminalSession\.terminal\(request, options\)/,
  );
});

test("trusted proxy sign-in cannot pretend that local logout will end the session", () => {
  assert.equal(
    appUserPresentation({
      signedIn: true,
      user: { subject: "proxy:alice", login: "alice", role: "maintainer" },
    }).trustedProxyUser,
    true,
  );
});

test("split-origin links use the browser-visible proxy origin", async () => {
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const sshGatewaySource = await readFile(
    new URL("../src/worker/ssh-gateway.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /trustedProxyPublicOrigin\(env\) \?\? new URL\(request\.url\)\.origin/);
  assert.match(source, /shareUrl\(request, env, id, result\.shareToken\)/);
  assert.match(source, /externalRequestOrigin\(request, env\)/);
  assert.match(
    source,
    /browserVncUrl: \(sessionId\) => runtimeAdapterBrowserVncUrl\(browserAppOrigin\(env\), sessionId\)/,
  );
  assert.match(
    sshGatewaySource,
    /githubOAuthRedirectUri\(request\.url, this\.env\.GITHUB_REDIRECT_URI\)/,
  );
});
