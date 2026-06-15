import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

import { loadGhosttyRuntime } from "../src/app/ghostty-loader.js";

const execFileAsync = promisify(execFile);

test("generated Ghostty WASM is byte-exact and served with executable asset policy", async () => {
  await execFileAsync(process.execPath, ["scripts/generate-assets.mjs"]);
  const generated = await import(`../src/generated.ts?terminal-assets=${Date.now()}`);
  const { terminalAssetResponse } = await import(
    `../src/worker/terminal-assets.ts?terminal-assets=${Date.now()}`
  );
  const wasmBytes = await readFile(
    new URL("../node_modules/ghostty-web/dist/ghostty-vt.wasm", import.meta.url),
  );

  assert.equal(generated.GHOSTTY_VT_WASM_PATH, "/vendor/ghostty-vt.wasm");
  assert.equal(generated.APP_HTML.includes("__GHOSTTY_WASM_PATH__"), false);
  assert.equal(
    Buffer.compare(Buffer.from(generated.GHOSTTY_VT_WASM_BASE64, "base64"), wasmBytes),
    0,
  );

  const wasm = terminalAssetResponse(generated.GHOSTTY_VT_WASM_PATH);
  assert.equal(wasm?.status, 200);
  assert.equal(wasm?.headers.get("content-type"), "application/wasm");
  assert.equal(wasm?.headers.get("cache-control"), "no-store");
  assert.equal(Buffer.compare(Buffer.from(await wasm!.arrayBuffer()), wasmBytes), 0);

  for (const path of ["/vendor/ghostty-web.js", "/vendor/__vite-browser-external-2447137e.js"]) {
    const asset = terminalAssetResponse(path);
    assert.equal(asset?.status, 200);
    assert.equal(asset?.headers.get("content-type"), "text/javascript; charset=utf-8");
    assert.equal(asset?.headers.get("cache-control"), "no-store");
  }
  assert.equal(terminalAssetResponse("/vendor/unknown.js"), null);
});

test("Ghostty loader injects the explicit WASM runtime into terminal modules", async () => {
  const loadedPaths: string[] = [];
  const module = {
    Terminal: class {},
    Ghostty: {
      async load(path: string) {
        loadedPaths.push(path);
        return { runtime: path };
      },
    },
  };

  const loaded = await loadGhosttyRuntime(module, "/vendor/ghostty-vt.wasm");
  assert.deepEqual(loadedPaths, ["/vendor/ghostty-vt.wasm"]);
  assert.deepEqual(loaded.ghostty, { runtime: "/vendor/ghostty-vt.wasm" });
  assert.equal(loaded.Terminal, module.Terminal);
  await assert.rejects(
    loadGhosttyRuntime({ Terminal: class {} }, "/vendor/ghostty-vt.wasm"),
    /missing WASM loader/,
  );
});

test("generated Ghostty WASM initializes the installed terminal runtime", async () => {
  const wasmBytes = await readFile(
    new URL("../node_modules/ghostty-web/dist/ghostty-vt.wasm", import.meta.url),
  );
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/wasm" });
    response.end(wasmBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const { Ghostty, Terminal } = await import("ghostty-web");
    const ghostty = await Ghostty.load(`http://127.0.0.1:${address.port}/vendor/ghostty-vt.wasm`);
    assert.ok(new Terminal({ ghostty }));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
