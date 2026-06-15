import { json, notFound, readJson } from "../http.ts";
import type { User } from "../models.ts";
import type { InteractiveSession } from "../session-model.ts";

type ServiceSessionPrincipal = "ssh" | "agent";

export type ServiceSessionRouteDependencies = {
  sshAuth(request: Request): Promise<unknown>;
  sshState(request: Request): Promise<unknown>;
  agentState(request: Request): Promise<unknown>;
  createSshSession(request: Request): Promise<unknown>;
  createAgentSession(request: Request): Promise<unknown>;
  updateAgentWorkState(request: Request, sessionId: string): Promise<unknown>;
  openAgentRunnerPty(request: Request, sessionId: string): Promise<Response>;
  requireSshViewer(request: Request): Promise<User>;
  requireAgentUser(request: Request): Promise<User>;
  readFreshSession(sessionId: string): Promise<InteractiveSession | null>;
  presentSession(session: InteractiveSession, user: User): InteractiveSession;
  mutateSession(request: Request, user: User, sessionId: string, action: string): Promise<unknown>;
  listCheckpoints(user: User, sessionId: string): Promise<unknown>;
  createCheckpoint(user: User, sessionId: string): Promise<unknown>;
  restoreCheckpoint(user: User, sessionId: string, checkpointId: string): Promise<unknown>;
  readLogs(user: User, sessionId: string): Promise<unknown>;
  readTranscript(user: User, sessionId: string): Promise<Response>;
  updateSummary(request: Request, user: User, sessionId: string): Promise<unknown>;
};

export async function handleServiceSessionRoute(
  request: Request,
  url: URL,
  dependencies: ServiceSessionRouteDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/ssh/auth") {
    return json(await dependencies.sshAuth(request));
  }
  if (request.method === "GET" && url.pathname === "/api/ssh/state") {
    return json(await dependencies.sshState(request));
  }
  if (request.method === "GET" && url.pathname === "/api/agent/state") {
    return json(await dependencies.agentState(request));
  }
  if (request.method === "POST" && url.pathname === "/api/ssh/interactive-sessions") {
    return json(await dependencies.createSshSession(request), { status: 201 });
  }
  if (request.method === "POST" && url.pathname === "/api/agent/interactive-sessions") {
    return json(await dependencies.createAgentSession(request), { status: 201 });
  }

  const match = url.pathname.match(
    /^\/api\/(ssh|agent)\/interactive-sessions\/([^/]+)(?:\/(.+))?$/,
  );
  if (!match) return null;
  const principal = match[1] as ServiceSessionPrincipal;
  const sessionId = decoded(match[2]);
  const resource = match[3] ?? "";

  if (principal === "agent" && request.method === "POST" && resource === "work-state") {
    return json(await dependencies.updateAgentWorkState(request, sessionId));
  }
  if (principal === "agent" && request.method === "GET" && resource === "runner-pty") {
    return dependencies.openAgentRunnerPty(request, sessionId);
  }

  if (request.method === "GET" && !resource) {
    const user = await requirePrincipal(request, principal, dependencies);
    const session = await dependencies.readFreshSession(sessionId);
    if (!session) throw notFound("interactive session not found");
    return json({ session: dependencies.presentSession(session, user) });
  }

  if (principal === "ssh" && request.method === "POST" && resource === "actions") {
    const user = await dependencies.requireSshViewer(request);
    const body = await readJson<{ action?: string }>(request);
    return json(await dependencies.mutateSession(request, user, sessionId, body.action ?? ""));
  }

  if (principal === "ssh" && resource === "checkpoints") {
    const user = await dependencies.requireSshViewer(request);
    if (request.method === "GET") {
      return json(await dependencies.listCheckpoints(user, sessionId));
    }
    if (request.method === "POST") {
      return json(await dependencies.createCheckpoint(user, sessionId), { status: 201 });
    }
    return null;
  }

  const restoreMatch =
    principal === "ssh" ? resource.match(/^checkpoints\/([^/]+)\/restore$/) : null;
  if (request.method === "POST" && restoreMatch) {
    const user = await dependencies.requireSshViewer(request);
    return json(await dependencies.restoreCheckpoint(user, sessionId, decoded(restoreMatch[1])));
  }

  if (request.method === "GET" && resource === "logs") {
    const user = await requirePrincipal(request, principal, dependencies);
    return json(await dependencies.readLogs(user, sessionId));
  }
  if (request.method === "GET" && resource === "transcript") {
    const user = await requirePrincipal(request, principal, dependencies);
    return dependencies.readTranscript(user, sessionId);
  }
  if (request.method === "POST" && resource === "summary") {
    const user = await requirePrincipal(request, principal, dependencies);
    return json(await dependencies.updateSummary(request, user, sessionId));
  }

  return null;
}

function requirePrincipal(
  request: Request,
  principal: ServiceSessionPrincipal,
  dependencies: ServiceSessionRouteDependencies,
): Promise<User> {
  return principal === "ssh"
    ? dependencies.requireSshViewer(request)
    : dependencies.requireAgentUser(request);
}

function decoded(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
