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
  if (ingress.trustedProxy.kind === "missing" && !ingress.independentServiceAuth) {
    throw unauthorized();
  }
}

export function usesIndependentServiceAuth(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/terminal/ws") {
    const headers = request.headers;
    const hasAuthorization = Boolean(headers.get("authorization"));
    const hasSshIdentity = Boolean(
      headers.get("x-crabfleet-ssh-fingerprint") || headers.get("x-crabbox-ssh-fingerprint"),
    );
    const hasAgentIdentity = Boolean(headers.get("x-crabfleet-session-id"));
    return hasAuthorization && (hasSshIdentity || hasAgentIdentity);
  }
  return ["/api/ssh/", "/api/agent/", "/api/openclaw/", "/api/provision/"].some((prefix) =>
    pathname.startsWith(prefix),
  );
}
