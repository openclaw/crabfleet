import assert from "node:assert/strict";
import test from "node:test";

import {
  readTerminalClipboardBytes,
  terminalClipboardFilename,
} from "../src/worker/interactive-terminal.ts";

test("terminal clipboard filenames are bounded, sanitized, and typed", () => {
  assert.equal(terminalClipboardFilename("screen shot", "image/png"), "screen-shot.png");
  assert.equal(terminalClipboardFilename("notes.txt", "text/plain"), "notes.txt");
  assert.equal(terminalClipboardFilename("folder/notes.txt", "text/plain"), "notes.txt");
  assert.equal(terminalClipboardFilename("folder\\notes.txt", "text/plain"), "notes.txt");
  assert.equal(terminalClipboardFilename("../../", "application/pdf"), "clipboard.pdf");
  assert.equal(terminalClipboardFilename("", "application/json"), "clipboard.json");
  assert.equal(terminalClipboardFilename("", "text/markdown; charset=utf-8"), "clipboard.md");
  assert.ok(terminalClipboardFilename("x".repeat(200), "application/octet-stream").length <= 94);
});

test("terminal clipboard upload rejects empty and declared oversized bodies", async () => {
  await assert.rejects(
    () => readTerminalClipboardBytes(new Request("https://example.test", { method: "POST" })),
    /clipboard file is empty/,
  );
  await assert.rejects(
    () =>
      readTerminalClipboardBytes(
        new Request("https://example.test", {
          method: "POST",
          body: "x",
          headers: { "content-length": String(10 * 1024 * 1024 + 1) },
        }),
      ),
    /clipboard file exceeds 10 MiB/,
  );
  assert.deepEqual(
    await readTerminalClipboardBytes(
      new Request("https://example.test", { method: "POST", body: "abc" }),
    ),
    new Uint8Array([97, 98, 99]),
  );
});
