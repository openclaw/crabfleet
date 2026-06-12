export const appCanonicalHost = "crabfleet.openclaw.ai";
export const appCanonicalOrigin = `https://${appCanonicalHost}`;
const productCanonicalHost = "crabfleet.ai";
const productOriginHost = "crabbox.sh";
const productHosts = new Set([productCanonicalHost, `www.${productCanonicalHost}`]);
export const appRedirectHosts = new Set([
  "clawfleet.openclaw.ai",
  "crabyard.openclaw.ai",
  "crabbox-ai.services-91b.workers.dev",
]);

export async function productHostResponse(
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (!productHosts.has(url.hostname)) return null;

  if (url.hostname !== productCanonicalHost) {
    url.hostname = productCanonicalHost;
    return Response.redirect(url.toString(), 308);
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed\n", {
      status: 405,
      headers: { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" },
    });
  }

  const upstreamUrl = new URL(url);
  upstreamUrl.hostname = productOriginHost;
  const upstreamHeaders = new Headers();
  for (const name of [
    "accept",
    "accept-encoding",
    "accept-language",
    "if-modified-since",
    "if-none-match",
    "range",
  ]) {
    const value = request.headers.get(name);
    if (value) upstreamHeaders.set(name, value);
  }
  const upstream = await fetcher(upstreamUrl, {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual",
  });
  const headers = new Headers(upstream.headers);
  const location = headers.get("location");
  if (location) {
    const redirect = new URL(location, upstreamUrl);
    if (redirect.hostname === productOriginHost) {
      redirect.hostname = productCanonicalHost;
      headers.set("location", redirect.toString());
    }
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
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
