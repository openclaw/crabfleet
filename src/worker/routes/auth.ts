import type { TrustedProxyAuthResult } from "../../trusted-proxy-auth.ts";

export type PublicAuthRouteDependencies = {
  githubLogin(request: Request): Promise<Response>;
  githubCallback(request: Request): Promise<Response>;
  nativeLink(
    request: Request,
    code: string,
    requestAuth: TrustedProxyAuthResult,
  ): Promise<Response>;
  tokenLogin(request: Request): Promise<Response>;
  devIdentityLogin(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  authState(request: Request): Response;
};

export async function handlePublicAuthRoute(
  request: Request,
  url: URL,
  requestAuth: TrustedProxyAuthResult,
  dependencies: PublicAuthRouteDependencies,
): Promise<Response | null> {
  if (url.pathname === "/login/github") {
    return dependencies.githubLogin(request);
  }
  if (url.pathname === "/auth/github/callback") {
    return dependencies.githubCallback(request);
  }
  const nativeLinkMatch = url.pathname.match(/^\/native\/link\/([^/]+)$/);
  if (nativeLinkMatch && (request.method === "GET" || request.method === "POST")) {
    return dependencies.nativeLink(
      request,
      decodeURIComponent(nativeLinkMatch[1] ?? ""),
      requestAuth,
    );
  }
  if (request.method === "POST" && url.pathname === "/api/login/token") {
    return dependencies.tokenLogin(request);
  }
  if (request.method === "POST" && url.pathname === "/api/login/dev") {
    return dependencies.devIdentityLogin(request);
  }
  if (request.method === "POST" && url.pathname === "/api/logout") {
    return dependencies.logout(request);
  }
  if (request.method === "GET" && url.pathname === "/api/auth") {
    return dependencies.authState(request);
  }
  return null;
}
