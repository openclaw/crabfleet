import { requireRole } from "../auth.ts";
import { json } from "../http.ts";
import type { User } from "../models.ts";
import {
  handleInteractiveSessionResourceRoute,
  type InteractiveSessionResourceRouteDependencies,
} from "./interactive-session-resources.ts";

export type BrowserSessionRouteDependencies = Omit<
  InteractiveSessionResourceRouteDependencies,
  "basePath" | "requireUser"
> & {
  createSession(request: Request, user: User): Promise<unknown>;
  cleanupSessions(request: Request, user: User): Promise<unknown>;
};

export async function handleBrowserSessionRoute(
  request: Request,
  url: URL,
  user: User,
  dependencies: BrowserSessionRouteDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/interactive-sessions") {
    requireRole(user, "maintainer");
    return json(await dependencies.createSession(request, user), { status: 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/interactive-sessions/cleanup") {
    requireRole(user, "viewer");
    return json(await dependencies.cleanupSessions(request, user));
  }

  return handleInteractiveSessionResourceRoute(request, url, {
    ...dependencies,
    basePath: "/api/interactive-sessions",
    requireUser: async () => {
      requireRole(user, "viewer");
      return user;
    },
  });
}
