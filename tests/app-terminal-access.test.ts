import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  applyTerminalInputCapability,
  canSendTerminalInput,
  shouldConnectLiveTerminal,
} from "../src/app/terminal.js";

test("named terminal viewers subscribe live without receiving input authority", () => {
  const namedViewer = {
    kind: "interactive",
    status: "ready",
    capabilities: { terminal: true },
    canControl: false,
    ptyAvailable: true,
    attachUrl: "/api/terminal/ws",
  };
  const ordinaryViewer = { ...namedViewer, ptyAvailable: false, attachUrl: null };

  assert.equal(shouldConnectLiveTerminal(namedViewer), true);
  assert.equal(canSendTerminalInput(namedViewer), false);
  assert.equal(shouldConnectLiveTerminal(ordinaryViewer), false);
});

test("browser terminals consume live control grants and revocations", async () => {
  const source = await readFile(new URL("../src/app/terminal.js", import.meta.url), "utf8");
  assert.match(source, /TerminalMessageType\.ControlGranted/);
  assert.match(source, /TerminalMessageType\.ControlRevoked/);
  assert.match(source, /applyTerminalInputCapability\(host, canInput\)/);
  assert.equal(
    source.match(/encodeResizePayload\(\{ columns: host\.term\.cols, rows: host\.term\.rows \}\)/g)
      ?.length,
    2,
  );
  assert.doesNotMatch(source, /encodeResizePayload\(host\.term\.cols,\s*host\.term\.rows\)/);
});

test("clipboard upload fetch aborts after 30s instead of hanging on Uploading", async () => {
  const source = await readFile(new URL("../src/app/terminal.js", import.meta.url), "utf8");
  const start = source.indexOf("async function uploadTerminalClipboardBlob");
  const end = source.indexOf("function canUploadTerminalClipboardFile");
  assert.ok(
    start >= 0 && end > start,
    "uploadTerminalClipboardBlob must precede canUploadTerminalClipboardFile",
  );
  const upload = source.slice(start, end);
  assert.match(
    upload,
    /fetch\(`\/api\/interactive-sessions\/\$\{encodeURIComponent\(id\)\}\/clipboard`, \{[\s\S]*?signal:\s*AbortSignal\.timeout\(30_000\)/,
  );
  assert.match(upload, /error\?\.name === "TimeoutError" \|\| error\?\.name === "AbortError"/);
  assert.match(upload, /setTerminalStatus\(id, "Paste timed out"\)/);
});

test("server subscription capability authoritatively updates terminal input", () => {
  const readOnly: boolean[] = [];
  const host = {
    canInput: false,
    controller: {
      setReadOnly(value: boolean) {
        readOnly.push(value);
      },
    },
  };

  applyTerminalInputCapability(host, true);
  assert.equal(host.canInput, true);
  applyTerminalInputCapability(host, false);
  assert.equal(host.canInput, false);
  assert.deepEqual(readOnly, [false, true]);

  const term = { options: { disableStdin: true } };
  const fallbackHost = { canInput: false, term };
  applyTerminalInputCapability(fallbackHost, true);
  assert.equal(fallbackHost.canInput, true);
  assert.equal(term.options.disableStdin, false);
});
