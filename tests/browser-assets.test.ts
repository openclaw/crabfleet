import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("the browser bundle includes its audio worklet and has no missing asset URLs", async () => {
  execFileSync(process.execPath, ["scripts/generate-assets.mjs"], { stdio: "pipe" });
  const { APP_HTML, BROWSER_ASSETS } = await import("../src/generated.ts");
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
