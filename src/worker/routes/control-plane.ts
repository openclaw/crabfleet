import { requireRole } from "../auth.ts";
import { json, notFound, readJson } from "../http.ts";
import type { User } from "../models.ts";

export type ControlPlaneRouteDependencies = {
  readState(request: Request, user: User): Promise<unknown>;
  readFleet(user: User): Promise<unknown>;
  searchGitHubRefs(request: Request): Promise<unknown>;
  createCard(request: Request, user: User): Promise<unknown>;
  readCardRuns(cardId: string): Promise<unknown[] | null>;
  mutateCard(user: User, cardId: string, action: string): Promise<unknown>;
  updatePolicy(request: Request, user: User): Promise<unknown>;
  evaluateWorkflow(request: Request, user: User): Promise<unknown>;
  addAllowEntry(request: Request, user: User): Promise<unknown>;
  removeAllowEntry(request: Request, user: User, entry: string): Promise<unknown>;
  addRepo(request: Request, user: User): Promise<unknown>;
  removeRepo(request: Request, user: User, repo: string): Promise<unknown>;
};

export async function handleControlPlaneRoute(
  request: Request,
  url: URL,
  user: User,
  dependencies: ControlPlaneRouteDependencies,
): Promise<Response | null> {
  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(await dependencies.readState(request, user));
  }
  if (request.method === "GET" && url.pathname === "/api/fleet") {
    requireRole(user, "viewer");
    return json({ fleet: await dependencies.readFleet(user) });
  }
  if (request.method === "GET" && url.pathname === "/api/github/refs") {
    requireRole(user, "maintainer");
    return json(await dependencies.searchGitHubRefs(request));
  }
  if (request.method === "POST" && url.pathname === "/api/cards") {
    requireRole(user, "maintainer");
    return json(await dependencies.createCard(request, user), { status: 201 });
  }

  const runsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/runs$/);
  if (request.method === "GET" && runsMatch) {
    const runs = await dependencies.readCardRuns(decoded(runsMatch[1]));
    if (!runs) throw notFound("card not found");
    return json({ runs });
  }

  const actionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    const body = await readJson<{ action?: string }>(request);
    const action = body.action ?? "";
    requireRole(user, action === "attach" || action === "watch" ? "viewer" : "maintainer");
    return json(await dependencies.mutateCard(user, decoded(actionMatch[1]), action));
  }

  if (request.method === "PUT" && url.pathname === "/api/admin/policy") {
    requireRole(user, "owner");
    return json(await dependencies.updatePolicy(request, user));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/workflows/evaluate") {
    requireRole(user, "owner");
    return json(await dependencies.evaluateWorkflow(request, user));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/allow") {
    requireRole(user, "owner");
    return json(await dependencies.addAllowEntry(request, user), { status: 201 });
  }

  const allowMatch = url.pathname.match(/^\/api\/admin\/allow\/(.+)$/);
  if (request.method === "DELETE" && allowMatch) {
    requireRole(user, "owner");
    return json(await dependencies.removeAllowEntry(request, user, decoded(allowMatch[1])));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/repos") {
    requireRole(user, "owner");
    return json(await dependencies.addRepo(request, user), { status: 201 });
  }

  const repoMatch = url.pathname.match(/^\/api\/admin\/repos\/(.+)$/);
  if (request.method === "DELETE" && repoMatch) {
    requireRole(user, "owner");
    return json(await dependencies.removeRepo(request, user, decoded(repoMatch[1])));
  }

  return null;
}

function decoded(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
