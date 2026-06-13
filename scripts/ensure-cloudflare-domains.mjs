const token = process.env.CLOUDFLARE_DNS_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
const productOnly = process.argv.includes("--product-only");
const appHost = "crabfleet.openclaw.ai";
const cloudflareAccountId = "91b59577e757131d68d55a471fe32aca";
const productWorkerScript = "crabfleet-canonical-router";
// OpenClaw app hosts are Worker Custom Domains in wrangler.jsonc; this script
// only removes stale classic routes for them and keeps other aliases tidy.
const openClawCustomDomainHosts = new Set([
  appHost,
  "clawfleet.openclaw.ai",
  "crabyard.openclaw.ai",
]);

if (!token) {
  throw new Error("CLOUDFLARE_DNS_API_TOKEN or CLOUDFLARE_API_TOKEN is required");
}

async function request(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const message =
      body.errors?.map((error) => `${error.code}: ${error.message}`).join("; ") ||
      response.statusText;
    throw new Error(`${init.method || "GET"} ${path}: ${response.status} ${message}`);
  }
  return body.result;
}

async function zone(name) {
  const zones = await request(`/zones?name=${encodeURIComponent(name)}`);
  const selected = zones[0];
  if (!selected) {
    throw new Error(`Cloudflare zone not found: ${name}`);
  }
  return selected;
}

async function ensureProductHosts(zoneName, hosts) {
  const targetZone = await zone(zoneName);
  await request(
    `/accounts/${cloudflareAccountId}/workers/scripts/${productWorkerScript}/domains/records`,
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

async function removeOpenClawClassicRoutes() {
  const openclaw = await zone("openclaw.ai");
  const routes = await request(`/zones/${openclaw.id}/workers/routes`);
  for (const route of routes.filter((entry) =>
    openClawCustomDomainHosts.has(entry.pattern.replace(/\/\*$/, "")),
  )) {
    await request(`/zones/${openclaw.id}/workers/routes/${route.id}`, { method: "DELETE" });
    console.log(`deleted stale ${route.pattern} classic route ${route.id}`);
  }
}

async function ensureCrabdSshRecord() {
  const crabd = await zone("crabd.sh");
  const records = await request(
    `/zones/${crabd.id}/dns_records?name=${encodeURIComponent("crabd.sh")}`,
  );

  const target = "87.99.128.60";
  for (const record of records.filter((entry) => entry.type === "AAAA" || entry.type === "CNAME")) {
    await request(`/zones/${crabd.id}/dns_records/${record.id}`, { method: "DELETE" });
    console.log(`deleted conflicting crabd.sh ${record.type} record ${record.id}`);
  }

  const refreshed = await request(
    `/zones/${crabd.id}/dns_records?name=${encodeURIComponent("crabd.sh")}`,
  );
  const [primaryA, ...extraARecords] = refreshed.filter((record) => record.type === "A");
  if (primaryA) {
    await request(`/zones/${crabd.id}/dns_records/${primaryA.id}`, {
      method: "PUT",
      body: JSON.stringify({
        type: "A",
        name: "crabd.sh",
        content: target,
        proxied: false,
        ttl: 1,
      }),
    });
    console.log("set crabd.sh A record to SSH gateway");
  } else {
    await request(`/zones/${crabd.id}/dns_records`, {
      method: "POST",
      body: JSON.stringify({
        type: "A",
        name: "crabd.sh",
        content: target,
        proxied: false,
        ttl: 1,
      }),
    });
    console.log("created crabd.sh SSH A record");
  }

  for (const record of extraARecords) {
    await request(`/zones/${crabd.id}/dns_records/${record.id}`, { method: "DELETE" });
    console.log(`deleted extra crabd.sh A record ${record.id}`);
  }
}

if (!productOnly) {
  await removeOpenClawClassicRoutes();
}
await ensureProductHosts("crabfleet.ai", ["crabfleet.ai", "www.crabfleet.ai"]);
if (!productOnly) {
  await ensureCrabfleetDocsRecord();
  await ensureCrabdSshRecord();
}
