import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import test from "node:test";

test("the docs build emits hostable page routes and a resolvable documentation index", () => {
  execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], { stdio: "pipe" });
  const output = (path: string) => new URL(`../dist/docs-site/${path}`, import.meta.url);

  assert.ok(statSync(output("404.html")).isFile(), "GitHub Pages needs a root 404.html file");
  for (const route of ["connections", "windows-connector"]) {
    assert.ok(statSync(output(`${route}/index.html`)).isFile());
  }

  const index = readFileSync(output("llms.txt"), "utf8");
  const origin = `https://${readFileSync(output("CNAME"), "utf8").trim()}`;
  const pageURLs = [...index.matchAll(/^- [^\n]+: (https:\/\/\S+)$/gm)].map(
    (match) => new URL(match[1]!),
  );
  assert.ok(pageURLs.length > 0);
  for (const url of pageURLs) {
    assert.equal(url.origin, origin);
    const relative = url.pathname.slice(1);
    const file = relative.endsWith("/") || !relative ? `${relative}index.html` : relative;
    assert.ok(statSync(output(file)).isFile(), `unresolvable documentation URL: ${url}`);
    const html = readFileSync(output(file), "utf8");
    assert.ok(html.includes(`rel="canonical" href="${url.href}"`));
  }
});
