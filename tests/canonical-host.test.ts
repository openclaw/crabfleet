import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalAppRedirect,
  productHostResponse,
  routeProductRequest,
} from "../src/canonical-host.ts";

test("product hosts never fall through to the app worker", async () => {
  let upstreamRequest: Request | undefined;
  const response = await productHostResponse(
    new Request("https://crabfleet.ai/docs?mode=full", {
      headers: { accept: "text/html", authorization: "Bearer private" },
    }),
    async (input, init) => {
      upstreamRequest = new Request(input, init);
      return new Response("<title>CrabFleet</title>", {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    },
  );

  assert.equal(response?.status, 200);
  assert.equal(await response?.text(), "<title>CrabFleet</title>");
  assert.equal(upstreamRequest?.url, "https://crabbox.sh/docs?mode=full");
  assert.equal(upstreamRequest?.headers.get("accept"), "text/html");
  assert.equal(upstreamRequest?.headers.has("authorization"), false);
});

test("product www host redirects to the product apex", async () => {
  const response = await productHostResponse(
    new Request("https://www.crabfleet.ai/docs?mode=full"),
  );

  assert.equal(response?.status, 308);
  assert.equal(response?.headers.get("location"), "https://crabfleet.ai/docs?mode=full");
});

test("product aliases redirect to the product apex", async () => {
  const response = await routeProductRequest(new Request("https://crabfleet.app/docs?mode=full"));

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://crabfleet.ai/docs?mode=full");
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
