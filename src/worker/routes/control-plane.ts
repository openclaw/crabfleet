import { requireRole } from "../auth.ts";
import type {
  AdminAllowEntryInput,
  AdminPolicyInput,
  AdminRepoInput,
  AdminWorkflowInput,
} from "../admin-service.ts";
import {
  desktopHostOwnershipHeader,
  desktopHostOwnershipModeHeader,
  desktopHostPublicationHeader,
  desktopHostTokenOwnershipMode,
  type DesktopHostInput,
  type DesktopHostOwnershipMode,
  type DesktopHostRegistration,
} from "../desktop-host-service.ts";
import { json, notFound, readJson } from "../http.ts";
import type { User } from "../models.ts";

export type ControlPlaneRouteDependencies = {
  readState(request: Request, user: User): Promise<unknown>;
  readFleet(user: User): Promise<unknown>;
  registerDesktopHost(
    user: User,
    id: string,
    input: DesktopHostInput,
    ownershipMode: DesktopHostOwnershipMode,
    publicationID: string | null,
  ): Promise<DesktopHostRegistration>;
  recoverDesktopHost(
    user: User,
    id: string,
    publicationID: unknown,
  ): Promise<{ ownershipToken: string | null }>;
  removeDesktopHost(user: User, id: string, ownershipToken: string | null): Promise<void>;
  searchGitHubRefs(number: unknown): Promise<unknown>;
  createCard(request: Request, user: User): Promise<unknown>;
  readCardRuns(user: User, cardId: string): Promise<unknown[] | null>;
  mutateCard(user: User, cardId: string, action: string): Promise<unknown>;
  runRecurringCardScheduler(): Promise<unknown>;
  updatePolicy(input: AdminPolicyInput, user: User): Promise<void>;
  evaluateWorkflow(input: AdminWorkflowInput, user: User): Promise<void>;
  addAllowEntry(input: AdminAllowEntryInput, user: User): Promise<void>;
  removeAllowEntry(user: User, entry: string): Promise<void>;
  addRepo(input: AdminRepoInput, user: User): Promise<void>;
  removeRepo(user: User, repo: string): Promise<void>;
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

  const desktopHostMatch = url.pathname.match(/^\/api\/desktop-hosts\/([^/]+)$/);
  if (request.method === "PUT" && desktopHostMatch) {
    requireRole(user, "viewer");
    const registration = await dependencies.registerDesktopHost(
      user,
      decoded(desktopHostMatch[1]),
      await readJson<DesktopHostInput>(request),
      request.headers.get(desktopHostOwnershipModeHeader) === desktopHostTokenOwnershipMode
        ? desktopHostTokenOwnershipMode
        : "legacy",
      request.headers.get(desktopHostPublicationHeader),
    );
    return json(registration);
  }
  if (request.method === "POST" && desktopHostMatch && url.searchParams.get("recover") === "1") {
    requireRole(user, "viewer");
    const body = await readJson<{ publicationID?: unknown }>(request);
    return json(
      await dependencies.recoverDesktopHost(user, decoded(desktopHostMatch[1]), body.publicationID),
    );
  }
  if (request.method === "DELETE" && desktopHostMatch) {
    requireRole(user, "viewer");
    const ownershipToken = request.headers.get(desktopHostOwnershipHeader);
    await dependencies.removeDesktopHost(user, decoded(desktopHostMatch[1]), ownershipToken);
    return json({ ok: true });
  }
  if (request.method === "GET" && url.pathname === "/api/github/refs") {
    requireRole(user, "maintainer");
    return json(await dependencies.searchGitHubRefs(url.searchParams.get("number")));
  }
  if (request.method === "POST" && url.pathname === "/api/cards") {
    requireRole(user, "maintainer");
    return json(await dependencies.createCard(request, user), { status: 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/admin/scheduler/tick") {
    requireRole(user, "owner");
    return json(await dependencies.runRecurringCardScheduler());
  }

  const runsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/runs$/);
  if (request.method === "GET" && runsMatch) {
    const runs = await dependencies.readCardRuns(user, decoded(runsMatch[1]));
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
    await dependencies.updatePolicy(await readJson<AdminPolicyInput>(request), user);
    return json(await dependencies.readState(request, user));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/workflows/evaluate") {
    requireRole(user, "owner");
    await dependencies.evaluateWorkflow(await readJson<AdminWorkflowInput>(request), user);
    return json(await dependencies.readState(request, user));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/allow") {
    requireRole(user, "owner");
    await dependencies.addAllowEntry(await readJson<AdminAllowEntryInput>(request), user);
    return json(await dependencies.readState(request, user), { status: 201 });
  }

  const allowMatch = url.pathname.match(/^\/api\/admin\/allow\/(.+)$/);
  if (request.method === "DELETE" && allowMatch) {
    requireRole(user, "owner");
    await dependencies.removeAllowEntry(user, decoded(allowMatch[1]));
    return json(await dependencies.readState(request, user));
  }
  if (request.method === "POST" && url.pathname === "/api/admin/repos") {
    requireRole(user, "owner");
    await dependencies.addRepo(await readJson<AdminRepoInput>(request), user);
    return json(await dependencies.readState(request, user), { status: 201 });
  }

  const repoMatch = url.pathname.match(/^\/api\/admin\/repos\/(.+)$/);
  if (request.method === "DELETE" && repoMatch) {
    requireRole(user, "owner");
    await dependencies.removeRepo(user, decoded(repoMatch[1]));
    return json(await dependencies.readState(request, user));
  }

  return null;
}

function decoded(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
