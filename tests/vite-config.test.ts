import assert from "node:assert/strict";
import test from "node:test";

import viteConfig from "../vite.config.mjs";
import { lucideIconNames } from "../scripts/lucide-icon-script.mjs";

test("Vite keeps Worker Ghostty assets in builds without breaking local development", () => {
  assert.ok(lucideIconNames.includes("user-plus"));
  assert.equal(typeof viteConfig, "function");
  if (typeof viteConfig !== "function") return;
  const build = viteConfig({ command: "build", mode: "production" });
  const serve = viteConfig({ command: "serve", mode: "development" });

  assert.deepEqual(build.resolve?.alias, { "ghostty-web": "/vendor/ghostty-web.js" });
  assert.deepEqual(serve.resolve?.alias, {});
  assert.deepEqual(build.build?.rollupOptions?.external, ["/vendor/ghostty-web.js"]);

  const assets = serve.plugins?.find(
    (plugin) => plugin && "name" in plugin && plugin.name === "crabfleet-local-development-assets",
  );
  assert.ok(assets && typeof assets === "object");
  if (!assets || typeof assets !== "object") return;
  assert.equal(assets.apply, "serve");
  assert.equal(typeof assets.transformIndexHtml, "function");
  assert.equal(typeof assets.transform, "function");
  if (typeof assets.transformIndexHtml !== "function" || typeof assets.transform !== "function") {
    return;
  }

  const html = assets.transformIndexHtml(
    '<script>__LUCIDE_ICONS__</script><img src="__CRABBOX_LOGO__">',
  );
  assert.match(html, /globalThis\.lucideIconNodes/);
  assert.match(html, /\/src\/assets\/crabbox-logo\.png/);
  assert.doesNotMatch(html, /__LUCIDE_ICONS__|__CRABBOX_LOGO__/);

  const terminal = assets.transform(
    'const wasm = "__GHOSTTY_WASM_PATH__";',
    "/repo/src/app/terminal.js",
  );
  assert.match(String(terminal), /\/node_modules\/ghostty-web\/ghostty-vt\.wasm/);
  assert.doesNotMatch(String(terminal), /__GHOSTTY_WASM_PATH__/);

  const branding = assets.transform(
    'export const appLogo = "__CRABBOX_LOGO__";',
    "/repo/src/app/branding.js",
  );
  assert.match(String(branding), /\/src\/assets\/crabbox-logo\.png/);
  assert.doesNotMatch(String(branding), /__CRABBOX_LOGO__/);
});
