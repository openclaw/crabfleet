import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { test } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("embedded terminals explicitly load the generated Ghostty WASM runtime", async () => {
	await execFileAsync(process.execPath, ["scripts/generate-assets.mjs"]);
	const generated = await import(`../src/generated.ts?terminal-assets=${Date.now()}`);
	const [generator, terminal, worker, wasmBytes] = await Promise.all([
		readFile(new URL("../scripts/generate-assets.mjs", import.meta.url), "utf8"),
		readFile(new URL("../src/app/terminal.js", import.meta.url), "utf8"),
		readFile(new URL("../src/index.ts", import.meta.url), "utf8"),
		readFile(new URL("../node_modules/ghostty-web/dist/ghostty-vt.wasm", import.meta.url)),
	]);

	assert.match(generator, /ghostty-web\/dist\/ghostty-vt\.wasm/);
	assert.match(generator, /\.replaceAll\("__GHOSTTY_WASM_PATH__", ghosttyWasmAssetPath\)/);
	assert.match(generator, /GHOSTTY_VT_WASM_BASE64/);
	assert.match(generator, /GHOSTTY_VT_WASM_PATH/);
	assert.equal(generated.GHOSTTY_VT_WASM_PATH, "/vendor/ghostty-vt.wasm");
	assert.equal(generated.APP_HTML.includes("__GHOSTTY_WASM_PATH__"), false);
	assert.equal(
		Buffer.compare(Buffer.from(generated.GHOSTTY_VT_WASM_BASE64, "base64"), wasmBytes),
		0,
	);
	assert.match(terminal, /module\.Ghostty\.load\(ghosttyWasmPath\)/);
	assert.match(terminal, /ghostty: module\.ghostty/);
	assert.match(worker, /url\.pathname === GHOSTTY_VT_WASM_PATH/);
	assert.match(worker, /securityHeaders\("application\/wasm"\)/);
	assert.match(worker, /"cache-control": "no-store"/);

	const server = createServer((_request, response) => {
		response.writeHead(200, { "content-type": "application/wasm" });
		response.end(wasmBytes);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const { Ghostty, Terminal } = await import("ghostty-web");
		const ghostty = await Ghostty.load(
			`http://127.0.0.1:${address.port}${generated.GHOSTTY_VT_WASM_PATH}`,
		);
		assert.ok(new Terminal({ ghostty }));
	} finally {
		await new Promise<void>((resolve, reject) =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	}
});
