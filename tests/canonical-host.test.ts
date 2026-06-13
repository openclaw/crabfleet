import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  canonicalAppRedirect,
  productHostResponse,
  routeProductRequest,
} from "../src/canonical-host.ts";

test("product apex redirects to the canonical docs host", () => {
  const response = productHostResponse(new Request("https://crabfleet.ai/quickstart?mode=full"));

  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://docs.crabfleet.ai/quickstart?mode=full");
});

test("product www host redirects to the canonical docs host", () => {
  const response = productHostResponse(new Request("https://www.crabfleet.ai/docs?mode=full"));

  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://docs.crabfleet.ai/?mode=full");
});

test("legacy product docs paths map to generated docs routes", () => {
  const response = productHostResponse(new Request("https://crabfleet.ai/docs/spec-v2?mode=full"));

  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://docs.crabfleet.ai/spec-v2?mode=full");
});

test("legacy Markdown docs paths map to existing HTML routes", () => {
  const spec = productHostResponse(new Request("https://crabfleet.ai/docs/spec.md"));
  const specV2 = routeProductRequest(new Request("https://crabfleet.app/docs/spec-v2.md"));

  assert.equal(spec?.headers.get("location"), "https://docs.crabfleet.ai/spec");
  assert.equal(specV2.headers.get("location"), "https://docs.crabfleet.ai/spec-v2");
});

test("product hosts reject methods whose bodies a 308 would replay", () => {
  const response = productHostResponse(
    new Request("https://crabfleet.ai/webhook", { method: "POST", body: "private" }),
  );

  assert.equal(response?.status, 405);
  assert.equal(response?.headers.get("allow"), "GET, HEAD");
});

test("product aliases redirect to the canonical docs host", () => {
  const response = routeProductRequest(new Request("https://crabfleet.app/docs?mode=full"));

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://docs.crabfleet.ai/?mode=full");
});

test("product aliases reject methods whose bodies a 308 would replay", () => {
  const response = routeProductRequest(
    new Request("https://crabfleet.app/webhook", { method: "POST", body: "private" }),
  );

  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("product redirects never forward credentials to GitHub Pages", () => {
  for (const header of ["authorization", "proxy-authorization", "cookie"]) {
    const response = routeProductRequest(
      new Request("https://crabfleet.ai/docs", { headers: { [header]: "private" } }),
    );

    assert.equal(response.status, 400);
    assert.equal(response.headers.has("location"), false);
  }
});

test("product deployment converges its hosts as Worker Custom Domains", async () => {
  const config = await readFile(new URL("../wrangler.product.jsonc", import.meta.url), "utf8");
  const convergence = await readFile(
    new URL("../scripts/ensure-cloudflare-domains.mjs", import.meta.url),
    "utf8",
  );
  const productStart = convergence.indexOf("async function ensureProductHosts");
  const productEnd = convergence.indexOf("async function ensureCrabfleetDocsRecord", productStart);
  const productSource = convergence.slice(productStart, productEnd);

  assert.doesNotMatch(config, /"routes"/);
  assert.match(
    productSource,
    /\/accounts\/\$\{cloudflareAccountId\}\/workers\/scripts\/\$\{productWorkerScript\}\/domains\/records/,
  );
  assert.match(productSource, /method: "PUT"/);
  assert.match(productSource, /override_existing_origin: true/);
  assert.match(productSource, /override_existing_dns_record: true/);
  assert.match(productSource, /origins: hosts\.map/);
  assert.ok(
    productSource.indexOf('console.log(`set ${hosts.join(", ")} Worker Custom Domains`)') <
      productSource.indexOf("workers/routes"),
  );
  assert.match(productSource, /workers\/routes\/\$\{route\.id\}/);
  assert.doesNotMatch(productSource, /192\.0\.2\.1|method: "POST"/);
  assert.match(convergence, /await ensureCrabfleetDocsRecord\(\);\nif \(!productOnly\)/);
});

test("legacy app pages redirect to the canonical host", () => {
  const response = canonicalAppRedirect(
    new URL("https://clawfleet.openclaw.ai/app/sessions/IS-1?view=grid"),
  );

  assert.equal(response?.status, 308);
  assert.equal(
    response?.headers.get("location"),
    "https://crabfleet.openclaw.ai/app/sessions/IS-1?view=grid",
  );
});

test("legacy API requests stay on-host so authorization survives", () => {
  assert.equal(
    canonicalAppRedirect(new URL("https://clawfleet.openclaw.ai/api/ssh/sessions")),
    null,
  );
  assert.equal(
    canonicalAppRedirect(new URL("https://clawfleet.openclaw.ai/api/terminal/ws")),
    null,
  );
});
