import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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

  const indicator = readFileSync(output("screen-recording-indicator.html"), "utf8");
  assert.match(indicator, /class="toc-l2"[^>]*>What you&#39;re seeing/);
  assert.doesNotMatch(indicator, /What you&amp;#39;re seeing/);
  assert.match(
    indicator,
    /<li><strong>The recurring &quot;…bypass the system private window picker and directly access your screen and audio&quot; prompt<\/strong>/,
  );
  assert.equal((indicator.match(/<ol>/g) || []).length, 2);
  assert.doesNotMatch(indicator, /\*\*The recurring/);
});

test("the docs build renders wrapped lists and validates local links", (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "crabfleet-docs-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  cpSync(new URL("../docs", import.meta.url), path.join(root, "docs"), { recursive: true });
  mkdirSync(path.join(root, "scripts"));
  for (const script of ["build-docs-site.mjs", "docs-site-assets.mjs"]) {
    cpSync(new URL(`../scripts/${script}`, import.meta.url), path.join(root, "scripts", script));
  }
  const build = () =>
    execFileSync(process.execPath, ["scripts/build-docs-site.mjs"], { cwd: root, stdio: "pipe" });
  const fixture = (href: string) =>
    writeFileSync(
      path.join(root, "docs", "link-check.md"),
      `# Link check\n\n[Target](${href})\n\n## Target\n`,
    );

  fixture("#target");
  assert.doesNotThrow(build);
  writeFileSync(
    path.join(root, "docs", "list-check.md"),
    "# Lists\n\n3. **Wrapped\n   label**\n\n4. Next item\n\nAfter the list.\n\n- A wrapped\n  bullet\n- Another bullet\n",
  );
  assert.doesNotThrow(build);
  const lists = readFileSync(path.join(root, "dist", "docs-site", "list-check.html"), "utf8");
  assert.match(
    lists,
    /<ol start="3"><li><strong>Wrapped label<\/strong><\/li>\n<li>Next item<\/li><\/ol>\n<p>After the list\.<\/p>/,
  );
  assert.match(lists, /<ul><li>A wrapped bullet<\/li>\n<li>Another bullet<\/li><\/ul>/);
  fixture("#missing");
  assert.throws(build, /#missing -> missing anchor/);
  fixture("path");
  assert.throws(build, /path -> missing path/);
});
