import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

function runDomains(scenario: string) {
  const preload = `
    import assert from 'node:assert/strict';
    const scenario = ${JSON.stringify(scenario)};
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (milliseconds) => {
      assert.equal(milliseconds, 30_000);
      return timeout(scenario.endsWith('timeout') ? 100 : milliseconds);
    };
    function stall(signal) {
      return new Promise((resolve, reject) => {
        const keepAlive = setInterval(() => {}, 1000);
        signal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          reject(signal.reason);
        }, { once: true });
      });
    }
    globalThis.fetch = async (input, init) => {
      assert.ok(init.signal instanceof AbortSignal);
      assert.equal(init.headers.authorization, 'Bearer synthetic-cloudflare-token');
      const url = new URL(input);
      assert.equal(url.origin, 'https://api.cloudflare.com');
      const method = init.method || 'GET';
      console.log('request', method, url.pathname);
      if (scenario === 'fetch-timeout') return stall(init.signal);
      if (scenario === 'body-timeout' && method === 'PUT') {
        return { ok: true, json: () => stall(init.signal) };
      }
      if (scenario === 'http-error') return new Response('Unavailable', { status: 503, statusText: 'Service Unavailable' });
      let result;
      if (url.pathname === '/client/v4/zones') result = [{ id: 'synthetic-zone' }];
      else if (method === 'PUT' && url.pathname.endsWith('/domains/records')) {
        assert.deepEqual(JSON.parse(init.body).origins, [{ hostname: 'crabfleet.ai', zone_id: 'synthetic-zone' }]);
        result = {};
      } else if (url.pathname.endsWith('/workers/routes')) result = [];
      else if (method === 'GET' && url.pathname.endsWith('/dns_records')) result = [];
      else if (method === 'POST' && url.pathname.endsWith('/dns_records')) {
        assert.equal(JSON.parse(init.body).content, 'openclaw.github.io');
        result = {};
      } else throw new Error('Unexpected synthetic request: ' + method + ' ' + url.pathname);
      return new Response(JSON.stringify({ success: true, result }));
    };
  `;
  return spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(preload)}`,
      fileURLToPath(new URL("../scripts/ensure-cloudflare-domains.mjs", import.meta.url)),
      "--product-only",
    ],
    {
      encoding: "utf8",
      env: { CLOUDFLARE_API_TOKEN: "synthetic-cloudflare-token" },
      timeout: 5000,
    },
  );
}

test("domain convergence retains its product and docs requests with bounded fetches", () => {
  const result = runDomains("success");
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((result.stdout.match(/^request /gm) || []).length, 7);
  assert.match(result.stdout, /set crabfleet.ai Worker Custom Domains/);
  assert.match(result.stdout, /created docs.crabfleet.ai CNAME to GitHub Pages/);
});

for (const scenario of ["fetch-timeout", "body-timeout"]) {
  test(`domain convergence fails promptly on ${scenario}`, () => {
    const result = runDomains(scenario);
    assert.ifError(result.error);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Cloudflare request timed out after 30 seconds/);
    assert.equal(
      (result.stdout.match(/^request /gm) || []).length,
      scenario === "fetch-timeout" ? 1 : 2,
    );
    assert.doesNotMatch(result.stdout, /set .* Worker Custom Domains|created .* CNAME/);
  });
}

test("domain convergence retains useful errors for non-JSON Cloudflare failures", () => {
  const result = runDomains("http-error");
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /GET \/zones\?name=crabfleet.ai: 503 Service Unavailable/);
});
