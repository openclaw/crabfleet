import {
  inspectTrustedProxyAssertion,
  sanitizeTrustedProxyRequest,
  type TrustedProxyAuthResult,
  type TrustedProxyEnv,
} from "../trusted-proxy-auth.ts";
import { unauthorized } from "./http.ts";

export type WorkerIngress = {
  request: Request;
  trustedProxy: TrustedProxyAuthResult;
  independentServiceAuth: boolean;
};

export function prepareWorkerIngress(request: Request, env: TrustedProxyEnv): WorkerIngress {
  const trustedProxy = inspectTrustedProxyAssertion(request, env);
  if (trustedProxy.kind === "rejected") throw unauthorized();
  request = sanitizeTrustedProxyRequest(request, env);
  const independentServiceAuth = usesIndependentServiceAuth(request);
  if (trustedProxy.kind === "authenticated") {
    const headers = new Headers(request.headers);
    if (!independentServiceAuth) headers.delete("authorization");
    headers.delete("cookie");
    request = new Request(request, { headers });
  }
  return { request, trustedProxy, independentServiceAuth };
}

export function enforceWorkerIngressAuth(ingress: WorkerIngress): void {
  if (ingress.trustedProxy.kind === "missing" && !ingress.independentServiceAuth)
    throw unauthorized();
}

export function usesIndependentServiceAuth(request: Request): boolean {
  const { pathname } = new URL(request.url);
  const method = request.method;
  return (
    (method === "POST" &&
      [
        "/api/native/v1/auth/device",
        "/api/native/v1/auth/token",
        "/api/connector/v1/auth/renew",
      ].includes(pathname)) ||
    (method === "DELETE" && pathname === "/api/native/v1/auth/token") ||
    (method === "GET" &&
      ["/api/native/v1/session", "/api/native/v1/fleet", "/api/connector/v1/session"].includes(
        pathname,
      )) ||
    (["PUT", "DELETE"].includes(method) &&
      /^\/api\/connector\/v1\/desktop-hosts\/[a-z0-9._-]+$/u.test(pathname)) ||
    (method === "POST" &&
      /^\/api\/connector\/v1\/desktop-hosts\/[a-z0-9._-]+\/recover$/u.test(pathname)) ||
    (method === "GET" && /^\/api\/desktop-hosts\/[^/]+\/relay\/host$/u.test(pathname))
  );
}
