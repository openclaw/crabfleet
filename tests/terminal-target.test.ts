import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { sizedTerminalTargetUrl } from "../src/terminal-target.ts";

test("opaque direct terminal URLs pass through the multiplex hub unchanged", async () => {
  const signed =
    "wss://controller.example/v1/pty?signature=a%2Bb%2Fc%3D&cols=provider-owned&opaque=1";
  assert.equal(sizedTerminalTargetUrl(signed, "attach", 120, 34), signed);
  const source = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");
  const upstreamStart = source.indexOf("async function openInteractiveTerminalUpstream");
  const upstreamEnd = source.indexOf(
    "async function markInteractiveTerminalConnected",
    upstreamStart,
  );
  const upstreamSource = source.slice(upstreamStart, upstreamEnd);
  assert.match(
    upstreamSource,
    /fetch\(sizedTerminalTargetUrl\(target\.url, routeKind, cols, rows\)/,
  );
  assert.doesNotMatch(upstreamSource, /addQuery\(target\.url/);

  const directStart = source.indexOf("async function interactiveSessionPty");
  const directEnd = source.indexOf("function sendTerminalJson", directStart);
  const directSource = source.slice(directStart, directEnd);
  assert.match(directSource, /const targetUrl = sizedTerminalTargetUrl\(/);
  assert.match(directSource, /terminalSize\(request, "cols", 120\)/);
  assert.match(directSource, /terminalSize\(request, "rows", 34\)/);
  assert.match(directSource, /upstreamResponse = await fetch\(targetUrl/);
  assert.doesNotMatch(directSource, /upstreamResponse = await fetch\(target\.url/);
});

test("known bridge and runner targets receive terminal dimensions", () => {
  assert.equal(
    sizedTerminalTargetUrl("wss://bridge.example/pty?token=opaque", "bridge", 120, 34),
    "wss://bridge.example/pty?token=opaque&cols=120&rows=34",
  );
  assert.equal(
    sizedTerminalTargetUrl("wss://runner.example/pty?cols=80", "cloudflare", 132, 40),
    "wss://runner.example/pty?cols=132&rows=40",
  );
});
