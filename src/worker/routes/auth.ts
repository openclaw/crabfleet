import type { TrustedProxyAuthResult } from "../../trusted-proxy-auth.ts";
import type { User } from "../models.ts";

export type PublicAuthRouteDependencies = {
  githubLogin(request: Request): Promise<Response>;
  githubCallback(request: Request): Promise<Response>;
  sshLink(request: Request, code: string, requestAuth: TrustedProxyAuthResult): Promise<Response>;
  tokenLogin(request: Request): Promise<Response>;
  devIdentityLogin(request: Request): Promise<Response>;
  logout(request: Request): Promise<Response>;
  authState(request: Request): Response;
};

export type SessionAuthRouteDependencies = {
  sessionState(request: Request, user: User): Response;
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
  const sshLinkMatch = url.pathname.match(/^\/ssh\/link\/([^/]+)$/);
  if (sshLinkMatch && (request.method === "GET" || request.method === "POST")) {
    return dependencies.sshLink(request, decodeURIComponent(sshLinkMatch[1] ?? ""), requestAuth);
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

export function handleSessionAuthRoute(
  request: Request,
  url: URL,
  user: User,
  dependencies: SessionAuthRouteDependencies,
): Response | null {
  return request.method === "GET" && url.pathname === "/api/session"
    ? dependencies.sessionState(request, user)
    : null;
}
