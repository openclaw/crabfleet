import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

test("browser assets build from paths with spaces and include every worklet", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "crabfleet build "));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"));
  await mkdir(join(fixture, "src"));
  for (const path of [
    "package.json",
    "vite.config.mjs",
    "scripts/generate-assets.mjs",
    "src/app.html",
    "src/app",
    "src/assets",
  ]) {
    await cp(new URL(`../${path}`, import.meta.url), join(fixture, path), { recursive: true });
  }
  await symlink(
    await realpath(new URL("../node_modules", import.meta.url)),
    join(fixture, "node_modules"),
    "junction",
  );
  execFileSync(process.execPath, ["scripts/generate-assets.mjs"], {
    cwd: fixture,
    stdio: "pipe",
  });
  const { APP_HTML, BROWSER_ASSETS } = await import(
    pathToFileURL(join(fixture, "src/generated.ts")).href
  );
  const urls = [...APP_HTML.matchAll(/\/assets\/[A-Za-z0-9_.-]+/g)].map((match) => match[0]);
  assert.ok(
    urls.some((url) => url.includes("audio-worklet")),
    "browser audio must retain its worklet",
  );
  for (const url of urls) {
    const asset = BROWSER_ASSETS[url];
    assert.ok(asset, `missing generated asset: ${url}`);
    assert.equal(asset.contentType, "text/javascript; charset=utf-8");
    assert.match(Buffer.from(asset.base64, "base64").toString(), /registerProcessor/);
  }
  assert.match(APP_HTML, /Your computers/);
  assert.doesNotMatch(APP_HTML, /Ghostty|New crabbox|api\/terminal/);
});

test("browser assets reject a hash in the checkout path before invoking Vite", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "crabfleet build #"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  await mkdir(join(fixture, "scripts"));
  await cp(
    new URL("../scripts/generate-assets.mjs", import.meta.url),
    join(fixture, "scripts/generate-assets.mjs"),
  );
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/generate-assets.mjs"], {
        cwd: fixture,
        stdio: "pipe",
      }),
    /Vite cannot package audio worklets from a checkout path containing '#'. Rename or move the checkout/,
  );
});
