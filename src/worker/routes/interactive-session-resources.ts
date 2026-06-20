import { json, notFound, readJson } from "../http.ts";
import type { User } from "../models.ts";
import type { InteractiveSession } from "../session-model.ts";
import type { InteractiveSessionSummaryInput } from "../session-metadata.ts";
import type { InteractiveSessionGrantInput } from "../session-grant-service.ts";

export type InteractiveSessionResourceRouteDependencies = {
  basePath: string;
  requireUser(request: Request): Promise<User>;
  readFreshSession(user: User, sessionId: string): Promise<InteractiveSession | null>;
  presentSession(session: InteractiveSession, user: User): Promise<InteractiveSession | null>;
  readLogs(user: User, sessionId: string): Promise<unknown>;
  readTranscript(user: User, sessionId: string): Promise<Response>;
  updateSummary(
    user: User,
    sessionId: string,
    input: InteractiveSessionSummaryInput,
  ): Promise<unknown>;
  mutateSession?(request: Request, user: User, sessionId: string, action: string): Promise<unknown>;
  listCheckpoints?(user: User, sessionId: string): Promise<unknown>;
  createCheckpoint?(user: User, sessionId: string): Promise<unknown>;
  restoreCheckpoint?(user: User, sessionId: string, checkpointId: string): Promise<unknown>;
  readDiagnostics?(user: User, sessionId: string): Promise<unknown>;
  openVnc?(user: User, sessionId: string): Promise<Response>;
  uploadClipboard?(request: Request, user: User, sessionId: string): Promise<unknown>;
  listGrants?(user: User, sessionId: string): Promise<unknown>;
  grantAccess?(
    user: User,
    sessionId: string,
    input: InteractiveSessionGrantInput,
  ): Promise<unknown>;
  revokeAccess?(user: User, sessionId: string, subject: string): Promise<unknown>;
};

export async function handleInteractiveSessionResourceRoute(
  request: Request,
  url: URL,
  dependencies: InteractiveSessionResourceRouteDependencies,
): Promise<Response | null> {
  const match = url.pathname.match(
    new RegExp(`^${escapedPattern(dependencies.basePath)}/([^/]+)(?:/(.+))?$`),
  );
  if (!match) return null;
  const sessionId = decoded(match[1]);
  const resource = match[2] ?? "";

  if (request.method === "GET" && !resource) {
    const user = await dependencies.requireUser(request);
    const session = await dependencies.readFreshSession(user, sessionId);
    if (!session) throw notFound("interactive session not found");
    const presented = await dependencies.presentSession(session, user);
    if (!presented) throw notFound("interactive session not found");
    return json({ session: presented });
  }
  if (request.method === "GET" && resource === "logs") {
    const user = await dependencies.requireUser(request);
    return json(await dependencies.readLogs(user, sessionId));
  }
  if (request.method === "GET" && resource === "transcript") {
    const user = await dependencies.requireUser(request);
    return dependencies.readTranscript(user, sessionId);
  }
  if (request.method === "POST" && resource === "summary") {
    const user = await dependencies.requireUser(request);
    return json(
      await dependencies.updateSummary(
        user,
        sessionId,
        await readJson<InteractiveSessionSummaryInput>(request),
      ),
    );
  }
  if (request.method === "POST" && resource === "actions" && dependencies.mutateSession) {
    const user = await dependencies.requireUser(request);
    const body = await readJson<{ action?: string }>(request);
    return json(await dependencies.mutateSession(request, user, sessionId, body.action ?? ""));
  }

  if (resource === "checkpoints" && dependencies.listCheckpoints && dependencies.createCheckpoint) {
    const user = await dependencies.requireUser(request);
    if (request.method === "GET") {
      return json(await dependencies.listCheckpoints(user, sessionId));
    }
    if (request.method === "POST") {
      return json(await dependencies.createCheckpoint(user, sessionId), { status: 201 });
    }
    return null;
  }

  const restoreMatch = dependencies.restoreCheckpoint
    ? resource.match(/^checkpoints\/([^/]+)\/restore$/)
    : null;
  if (request.method === "POST" && restoreMatch && dependencies.restoreCheckpoint) {
    const user = await dependencies.requireUser(request);
    return json(await dependencies.restoreCheckpoint(user, sessionId, decoded(restoreMatch[1])));
  }
  if (request.method === "GET" && resource === "diagnostics" && dependencies.readDiagnostics) {
    const user = await dependencies.requireUser(request);
    return json(await dependencies.readDiagnostics(user, sessionId));
  }
  if (request.method === "GET" && resource === "vnc" && dependencies.openVnc) {
    const user = await dependencies.requireUser(request);
    return dependencies.openVnc(user, sessionId);
  }
  if (request.method === "POST" && resource === "clipboard" && dependencies.uploadClipboard) {
    const user = await dependencies.requireUser(request);
    return json(await dependencies.uploadClipboard(request, user, sessionId), {
      status: 201,
    });
  }

  if (resource === "grants" && dependencies.listGrants && dependencies.grantAccess) {
    const user = await dependencies.requireUser(request);
    if (request.method === "GET") return json(await dependencies.listGrants(user, sessionId));
    if (request.method === "POST") {
      return json(
        await dependencies.grantAccess(
          user,
          sessionId,
          await readJson<InteractiveSessionGrantInput>(request),
        ),
        { status: 201 },
      );
    }
    return null;
  }

  const grantMatch = dependencies.revokeAccess ? resource.match(/^grants\/(.+)$/) : null;
  if (request.method === "DELETE" && grantMatch && dependencies.revokeAccess) {
    const user = await dependencies.requireUser(request);
    return json(await dependencies.revokeAccess(user, sessionId, decoded(grantMatch[1])));
  }

  return null;
}

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decoded(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
