import { readFileSync } from "node:fs";

import preact from "@preact/preset-vite";
import { defineConfig } from "vite";

import { buildLucideIconScript } from "./scripts/lucide-icon-script.mjs";

const lucideIconNodes = JSON.parse(
  readFileSync(new URL("./node_modules/lucide-static/icon-nodes.json", import.meta.url), "utf8"),
);
const localGhosttyWasmPath = "/node_modules/ghostty-web/ghostty-vt.wasm";
const localDevelopmentAssets = {
  name: "crabfleet-local-development-assets",
  apply: "serve",
  transformIndexHtml(html) {
    return html
      .replaceAll("__CRABBOX_LOGO__", "/src/assets/crabbox-logo.png")
      .replace("__LUCIDE_ICONS__", buildLucideIconScript(lucideIconNodes));
  },
  transform(source, id) {
    if (id.endsWith("/src/app/branding.js")) {
      return source.replaceAll("__CRABBOX_LOGO__", "/src/assets/crabbox-logo.png");
    }
    if (id.endsWith("/src/app/terminal.js")) {
      return source.replaceAll("__GHOSTTY_WASM_PATH__", localGhosttyWasmPath);
    }
  },
};

export default defineConfig(({ command }) => ({
  plugins: [preact(), localDevelopmentAssets],
  resolve: {
    alias:
      command === "build"
        ? {
            "ghostty-web": "/vendor/ghostty-web.js",
          }
        : {},
  },
  build: {
    outDir: "dist/app-bundle",
    emptyOutDir: true,
    rollupOptions: {
      external: ["/vendor/ghostty-web.js"],
      input: "src/app.html",
    },
  },
}));
