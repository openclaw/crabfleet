import { json } from "../http.ts";

export type ProvisioningRouteDependencies = {
  provision(request: Request): Promise<unknown>;
  stop(request: Request, provisionId: string): Promise<unknown>;
  openPty(request: Request, provisionId: string): Promise<Response>;
};

export async function handleProvisioningRoute(
  request: Request,
  url: URL,
  dependencies: ProvisioningRouteDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/provision/interactive") {
    return json(await dependencies.provision(request));
  }

  const provisionMatch = url.pathname.match(/^\/api\/provision\/interactive\/([^/]+)\/(pty|stop)$/);
  if (!provisionMatch) return null;

  const provisionId = decodeURIComponent(provisionMatch[1] ?? "");
  const resource = provisionMatch[2];
  if (request.method === "GET" && resource === "pty") {
    return dependencies.openPty(request, provisionId);
  }
  if (request.method === "POST" && resource === "stop") {
    return json(await dependencies.stop(request, provisionId));
  }
  return null;
}
