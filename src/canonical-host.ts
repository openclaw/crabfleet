export const appCanonicalHost = "crabfleet.openclaw.ai";
export const appCanonicalOrigin = `https://${appCanonicalHost}`;
const productCanonicalHost = "crabfleet.ai";
const docsCanonicalOrigin = "https://docs.crabfleet.ai";

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
  target.pathname = source.pathname;
  target.search = source.search;
  return Response.redirect(target.toString(), 308);
}

export function routeProductRequest(request: Request): Response {
  const url = new URL(request.url);
  if (url.hostname !== productCanonicalHost) {
    return new Response("Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return docsRedirect(request);
}
