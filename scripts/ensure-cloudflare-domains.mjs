const token = process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const productOnly = process.argv.includes("--product-only");
const cloudflareAccountId = "91b59577e757131d68d55a471fe32aca";
const appWorkerScript = "crabbox-ai";
const productWorkerScript = "crabfleet-canonical-router";

if (!token) {
  throw new Error("CLOUDFLARE_DNS_API_TOKEN or CLOUDFLARE_API_TOKEN is required");
}

async function request(path, init = {}) {
  const signal = AbortSignal.timeout(30_000);
  try {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
      ...init,
      signal,
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...init.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    signal.throwIfAborted();
    if (!response.ok || body.success === false) {
      const message =
        body.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ||
        response.statusText;
      throw new Error(`${init.method || "GET"} ${path}: ${response.status} ${message}`);
    }
    return body.result;
  } catch (error) {
    if (signal.aborted) {
      throw new Error(
        `${init.method || "GET"} ${path}: Cloudflare request timed out after 30 seconds`,
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}

async function zone(name) {
  const zones = await request(`/zones?name=${encodeURIComponent(name)}`);
  const selected = zones[0];
  if (!selected) {
    throw new Error(`Cloudflare zone not found: ${name}`);
  }
  return selected;
}

async function ensureWorkerHosts(workerScript, zoneName, hosts) {
  const targetZone = await zone(zoneName);
  await request(
    `/accounts/${cloudflareAccountId}/workers/scripts/${workerScript}/domains/records`,
    {
      method: "PUT",
      body: JSON.stringify({
        override_scope: true,
        override_existing_origin: true,
        override_existing_dns_record: true,
        origins: hosts.map((hostname) => ({ hostname, zone_id: targetZone.id })),
      }),
    },
  );
  console.log(`set ${hosts.join(", ")} Worker Custom Domains`);

  const routes = await request(`/zones/${targetZone.id}/workers/routes`);
  for (const route of routes.filter((entry) =>
    hosts.some((host) => entry.pattern === `${host}/*`),
  )) {
    await request(`/zones/${targetZone.id}/workers/routes/${route.id}`, { method: "DELETE" });
    console.log(`deleted stale ${route.pattern} classic route ${route.id}`);
  }
}

async function ensureCrabfleetDocsRecord() {
  const crabfleet = await zone("crabfleet.ai");
  const name = "docs.crabfleet.ai";
  const records = await request(
    `/zones/${crabfleet.id}/dns_records?name=${encodeURIComponent(name)}`,
  );

  for (const record of records.filter(
    (entry) =>
      ["A", "AAAA", "CNAME"].includes(entry.type) &&
      !(entry.type === "CNAME" && entry.content === "openclaw.github.io"),
  )) {
    await request(`/zones/${crabfleet.id}/dns_records/${record.id}`, { method: "DELETE" });
    console.log(`deleted conflicting ${name} ${record.type} record ${record.id}`);
  }

  const refreshed = await request(
    `/zones/${crabfleet.id}/dns_records?name=${encodeURIComponent(name)}`,
  );
  const docsCname = refreshed.find(
    (record) => record.type === "CNAME" && record.content === "openclaw.github.io",
  );
  const body = {
    type: "CNAME",
    name: "docs",
    content: "openclaw.github.io",
    proxied: false,
    ttl: 1,
  };
  if (docsCname) {
    await request(`/zones/${crabfleet.id}/dns_records/${docsCname.id}`, {
      method: "PUT",
      body: JSON.stringify(body),
    });
    console.log("set docs.crabfleet.ai CNAME to GitHub Pages");
  } else {
    await request(`/zones/${crabfleet.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    console.log("created docs.crabfleet.ai CNAME to GitHub Pages");
  }
}

if (!productOnly) {
  await ensureWorkerHosts(appWorkerScript, "openclaw.ai", ["crabfleet.openclaw.ai"]);
}
await ensureWorkerHosts(productWorkerScript, "crabfleet.ai", ["crabfleet.ai"]);
await ensureCrabfleetDocsRecord();
