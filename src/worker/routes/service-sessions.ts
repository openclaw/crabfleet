import { json } from "../http.ts";
import type { User } from "../models.ts";
import type { InteractiveSession } from "../session-model.ts";
import type { InteractiveSessionSummaryInput } from "../session-metadata.ts";
import { handleInteractiveSessionResourceRoute } from "./interactive-session-resources.ts";

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
  readFreshSession(user: User, sessionId: string): Promise<InteractiveSession | null>;
  presentSession(session: InteractiveSession, user: User): Promise<InteractiveSession | null>;
  mutateSession(request: Request, user: User, sessionId: string, action: string): Promise<unknown>;
  listCheckpoints(user: User, sessionId: string): Promise<unknown>;
  createCheckpoint(user: User, sessionId: string): Promise<unknown>;
  restoreCheckpoint(user: User, sessionId: string, checkpointId: string): Promise<unknown>;
  readLogs(user: User, sessionId: string): Promise<unknown>;
  readTranscript(user: User, sessionId: string): Promise<Response>;
  updateSummary(
    user: User,
    sessionId: string,
    input: InteractiveSessionSummaryInput,
  ): Promise<unknown>;
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

  return handleInteractiveSessionResourceRoute(request, url, {
    basePath: `/api/${principal}/interactive-sessions`,
    requireUser:
      principal === "ssh" ? dependencies.requireSshViewer : dependencies.requireAgentUser,
    readFreshSession: dependencies.readFreshSession,
    presentSession: dependencies.presentSession,
    readLogs: dependencies.readLogs,
    readTranscript: dependencies.readTranscript,
    updateSummary: dependencies.updateSummary,
    ...(principal === "ssh"
      ? {
          mutateSession: dependencies.mutateSession,
          listCheckpoints: dependencies.listCheckpoints,
          createCheckpoint: dependencies.createCheckpoint,
          restoreCheckpoint: dependencies.restoreCheckpoint,
        }
      : {}),
  });
}

function decoded(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
