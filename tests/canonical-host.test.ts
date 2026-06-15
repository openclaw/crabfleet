import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { routeProductRequest } from "../src/canonical-host.ts";

test("product apex redirects the exact path to the canonical docs host", () => {
  const response = routeProductRequest(new Request("https://crabfleet.ai/quickstart?mode=full"));

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://docs.crabfleet.ai/quickstart?mode=full");
});

test("product routing does not translate obsolete docs paths", () => {
  const response = routeProductRequest(new Request("https://crabfleet.ai/docs/spec.md"));

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://docs.crabfleet.ai/docs/spec.md");
});

test("product routing rejects noncanonical hosts", () => {
  for (const host of ["www.crabfleet.ai", "crabfleet.app"]) {
    const response = routeProductRequest(new Request(`https://${host}/`));
    assert.equal(response.status, 404);
    assert.equal(response.headers.has("location"), false);
  }
});

test("product routing rejects methods whose bodies a redirect would replay", () => {
  const response = routeProductRequest(
    new Request("https://crabfleet.ai/webhook", { method: "POST", body: "private" }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("product routing never forwards credentials to the docs host", () => {
  for (const header of ["authorization", "proxy-authorization", "cookie"]) {
    const response = routeProductRequest(
      new Request("https://crabfleet.ai/docs", { headers: { [header]: "private" } }),
    );

    assert.equal(response.status, 400);
    assert.equal(response.headers.has("location"), false);
  }
});

test("deployment exposes only canonical app and product hosts", async () => {
  const appConfig = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const productConfig = await readFile(
    new URL("../wrangler.product.jsonc", import.meta.url),
    "utf8",
  );
  const convergence = await readFile(
    new URL("../scripts/ensure-cloudflare-domains.mjs", import.meta.url),
    "utf8",
  );
  const productStart = convergence.indexOf("async function ensureProductHosts");
  const productEnd = convergence.indexOf("async function ensureCrabfleetDocsRecord", productStart);
  const productSource = convergence.slice(productStart, productEnd);

  assert.match(appConfig, /"workers_dev": false/);
  assert.match(appConfig, /"pattern": "crabfleet\.openclaw\.ai"/);
  assert.doesNotMatch(appConfig, /clawfleet\.openclaw\.ai|crabyard\.openclaw\.ai/);
  assert.doesNotMatch(productConfig, /"routes"/);
  assert.match(
    productSource,
    /\/accounts\/\$\{cloudflareAccountId\}\/workers\/scripts\/\$\{productWorkerScript\}\/domains\/records/,
  );
  assert.match(productSource, /method: "PUT"/);
  assert.match(productSource, /override_existing_origin: true/);
  assert.match(productSource, /override_existing_dns_record: true/);
  assert.match(productSource, /origins: hosts\.map/);
  assert.match(convergence, /ensureProductHosts\("crabfleet\.ai", \["crabfleet\.ai"\]\)/);
  assert.doesNotMatch(
    convergence,
    /www\.crabfleet\.ai|clawfleet\.openclaw\.ai|crabyard\.openclaw\.ai/,
  );
});
