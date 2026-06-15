import { json } from "../http.ts";

export type SessionIngressRouteDependencies = {
  readSharedSession(sessionId: string, token: string): Promise<unknown>;
  openTerminal(request: Request): Promise<Response>;
};

export async function handleSessionIngressRoute(
  request: Request,
  url: URL,
  dependencies: SessionIngressRouteDependencies,
): Promise<Response | null> {
  const sharedSessionMatch = url.pathname.match(/^\/api\/shared-sessions\/([^/]+)$/);
  if (request.method === "GET" && sharedSessionMatch) {
    return json(
      await dependencies.readSharedSession(
        decodeURIComponent(sharedSessionMatch[1] ?? ""),
        url.searchParams.get("token") ?? "",
      ),
    );
  }
  if (request.method === "GET" && url.pathname === "/api/terminal/ws") {
    return dependencies.openTerminal(request);
  }
  return null;
}
