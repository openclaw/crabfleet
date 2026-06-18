import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { appUserPresentation } from "../src/app/app-shell-state.js";

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
