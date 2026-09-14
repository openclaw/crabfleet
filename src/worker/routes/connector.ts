import type { TrustedProxyAuthResult } from "../../trusted-proxy-auth.ts";
import { requireRole } from "../auth.ts";
import {
  desktopHostOwnershipHeader,
  desktopHostPublicationHeader,
  type DesktopHostInput,
  type DesktopHostService,
} from "../desktop-host-service.ts";
import { connectorAccessScope, type NativeAuthService } from "../native-auth.ts";
import { badRequest, json, unauthorized } from "../http.ts";
import { readNativeJson } from "./native.ts";

export async function handleConnectorRoute(
  request: Request,
  url: URL,
  requestAuth: TrustedProxyAuthResult,
  auth: NativeAuthService,
  hosts: DesktopHostService,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/connector/v1/")) return null;
  if (requestAuth.kind === "authenticated" && request.headers.has("authorization"))
    throw unauthorized();
  if (request.method === "POST" && url.pathname === "/api/connector/v1/auth/renew") {
    return json(await auth.renewConnector(request), { headers: { "cache-control": "no-store" } });
  }
  const user = await auth.authenticate(request, connectorAccessScope);
  requireRole(user, "viewer");
  if (request.method === "GET" && url.pathname === "/api/connector/v1/session") {
    return json({ user }, { headers: { "cache-control": "no-store" } });
  }
  const match = url.pathname.match(
    /^\/api\/connector\/v1\/desktop-hosts\/([a-z0-9._-]+)(\/recover)?$/u,
  );
  if (!match) throw badRequest("unknown connector route");
  const id = match[1]!;
  if (request.method === "POST" && match[2]) {
    return json(await hosts.recover(user, id, request.headers.get(desktopHostPublicationHeader)), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (match[2]) throw badRequest("unsupported connector method");
  if (request.method === "PUT") {
    const input = await readNativeJson<DesktopHostInput>(request);
    return json(
      await hosts.register(
        user,
        id,
        input,
        "token-v1",
        request.headers.get(desktopHostPublicationHeader),
      ),
      { headers: { "cache-control": "no-store" } },
    );
  }
  if (request.method === "DELETE") {
    const token = request.headers.get(desktopHostOwnershipHeader);
    if (!token) throw badRequest("ownership token is required");
    await hosts.remove(user, id, token);
    return json({ ok: true });
  }
  throw badRequest("unsupported connector method");
}
