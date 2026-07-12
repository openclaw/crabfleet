import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { loadGhosttyRuntime } from "@openclaw/libterminal/browser";
import { GHOSTTY_ASSET_PATHS, readGhosttyAsset } from "@openclaw/libterminal/node";
import { readGhosttyWorkerAsset } from "@openclaw/libterminal/worker-assets";

import { generateAssetsForTest } from "./helpers/generated-assets.ts";

test("libterminal Worker Ghostty assets are byte-exact and keep Crabfleet response policy", async () => {
  await generateAssetsForTest();
  const generated = await import(`../src/generated.ts?terminal-assets=${Date.now()}`);
  const { terminalAssetResponse } = await import(
    `../src/worker/terminal-assets.ts?terminal-assets=${Date.now()}`
  );
  assert.equal(generated.APP_HTML.includes("__GHOSTTY_WASM_PATH__"), false);
  assert.equal(generated.APP_HTML.includes(GHOSTTY_ASSET_PATHS.wasm), true);
  assert.equal("GHOSTTY_VT_WASM_BASE64" in generated, false);

  for (const pathname of Object.values(GHOSTTY_ASSET_PATHS)) {
    const expected = await readGhosttyAsset(pathname);
    const workerAsset = readGhosttyWorkerAsset(pathname);
    const response = terminalAssetResponse(pathname);
    assert.ok(expected);
    assert.equal(workerAsset?.contentType, expected.contentType);
    assert.equal(
      Buffer.compare(Buffer.from(workerAsset?.body ?? []), Buffer.from(expected.body)),
      0,
    );
    assert.equal(response?.status, 200);
    assert.equal(response?.headers.get("content-type"), expected.contentType);
    assert.equal(response?.headers.get("cache-control"), "no-store");
    assert.equal(Buffer.compare(Buffer.from(await response!.arrayBuffer()), expected.body), 0);
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

  const loaded = await loadGhosttyRuntime({ module, wasmUrl: GHOSTTY_ASSET_PATHS.wasm });
  assert.deepEqual(loadedPaths, [GHOSTTY_ASSET_PATHS.wasm]);
  assert.deepEqual(loaded.ghostty, { runtime: GHOSTTY_ASSET_PATHS.wasm });
  assert.equal(loaded.Terminal, module.Terminal);
  await assert.rejects(
    loadGhosttyRuntime({
      module: { Terminal: class {} },
      wasmUrl: GHOSTTY_ASSET_PATHS.wasm,
    }),
    /failed to load Ghostty WASM/,
  );
});

test("generated Ghostty WASM initializes the installed terminal runtime", async () => {
  const wasmBytes = (await readGhosttyAsset(GHOSTTY_ASSET_PATHS.wasm))?.body;
  assert.ok(wasmBytes);
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/wasm" });
    response.end(wasmBytes);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const runtime = await loadGhosttyRuntime({
      wasmUrl: `http://127.0.0.1:${address.port}${GHOSTTY_ASSET_PATHS.wasm}`,
    });
    assert.ok(new runtime.Terminal({ ghostty: runtime.ghostty }));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
