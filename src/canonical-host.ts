export const appCanonicalHost = "crabfleet.openclaw.ai";
export const appCanonicalOrigin = `https://${appCanonicalHost}`;
const productCanonicalHost = "crabfleet.ai";
const docsCanonicalOrigin = "https://docs.crabfleet.ai";
const productHosts = new Set([productCanonicalHost, `www.${productCanonicalHost}`]);
export const appRedirectHosts = new Set([
  "clawfleet.openclaw.ai",
  "crabyard.openclaw.ai",
  "crabbox-ai.services-91b.workers.dev",
]);

function docsRedirect(request: Request): Response {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (
    request.headers.has("authorization") ||
    request.headers.has("proxy-authorization") ||
    request.headers.has("cookie")
  ) {
    return new Response("Credentials are not accepted on public product hosts\n", {
      status: 400,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  const source = new URL(request.url);
  const target = new URL(docsCanonicalOrigin);
  if (source.pathname === "/docs" || source.pathname === "/docs/") {
    target.pathname = "/";
  } else if (source.pathname === "/docs/spec.md") {
    target.pathname = "/spec";
  } else if (source.pathname === "/docs/spec-v2.md") {
    target.pathname = "/spec-v2";
  } else if (source.pathname.startsWith("/docs/")) {
    target.pathname = source.pathname.slice("/docs".length);
  } else {
    target.pathname = source.pathname;
  }
  target.search = source.search;
  return Response.redirect(target.toString(), 308);
}

export function productHostResponse(request: Request): Response | null {
  const url = new URL(request.url);
  if (!productHosts.has(url.hostname)) return null;

  return docsRedirect(request);
}

export function routeProductRequest(request: Request): Response {
  const productResponse = productHostResponse(request);
  if (productResponse) return productResponse;

  return docsRedirect(request);
}

export function canonicalAppRedirect(url: URL): Response | null {
  if (!appRedirectHosts.has(url.hostname)) return null;
  // Existing CLI, agent, and terminal clients may attach Authorization headers.
  // Cross-host redirects commonly strip them, so legacy API hosts stay usable.
  if (url.pathname === "/api" || url.pathname.startsWith("/api/")) return null;
  const target = new URL(appCanonicalOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  return Response.redirect(target.toString(), 308);
}
