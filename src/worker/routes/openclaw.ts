import { openClawServiceAuthorized } from "../../openclaw-service.ts";
import type { GitHubActionsSessionRegistrationInput } from "../github-actions-session-registration.ts";
import { badRequest, json, readJson, serviceUnavailable, unauthorized } from "../http.ts";
import type { OpenClawController, OpenClawMessageInput } from "../openclaw-controller.ts";
import type { OpenClawCreateInput } from "../openclaw-create.ts";

export type OpenClawRouteDependencies = {
  controller: OpenClawController;
  automationTokens: Array<string | null | undefined>;
  roomTokens: Array<string | null | undefined>;
};

export async function handleOpenClawRoute(
  request: Request,
  url: URL,
  dependencies: OpenClawRouteDependencies,
): Promise<Response | null> {
  if (request.method === "POST" && url.pathname === "/api/openclaw/action-sessions") {
    requireServiceToken(request, dependencies.automationTokens);
    const body = await readJson<GitHubActionsSessionRegistrationInput>(request);
    return json(await dependencies.controller.registerActionSession(body), { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/openclaw/crabboxes") {
    requireServiceToken(request, dependencies.roomTokens);
    const body = await readJson<OpenClawCreateInput>(request);
    return json(await dependencies.controller.createCrabbox(body), { status: 201 });
  }

  const sessionRootMatch = url.pathname.match(/^\/api\/openclaw\/session-roots\/([^/]+)$/);
  if (request.method === "GET" && sessionRootMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    return json(
      await dependencies.controller.readSessionRoot(decodedIdentifier(sessionRootMatch[1])),
    );
  }

  const sessionRootActionMatch = url.pathname.match(
    /^\/api\/openclaw\/session-roots\/([^/]+)\/actions$/,
  );
  if (request.method === "POST" && sessionRootActionMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    const body = await readJson<{ action?: unknown }>(request);
    requireStopAction(body.action);
    return json(
      await dependencies.controller.stopSessionRoot(
        request,
        decodedIdentifier(sessionRootActionMatch[1]),
      ),
    );
  }

  const crabboxTranscriptMatch = url.pathname.match(
    /^\/api\/openclaw\/crabboxes\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && crabboxTranscriptMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    return json(
      await dependencies.controller.readCrabboxTranscript(
        decodedIdentifier(crabboxTranscriptMatch[1]),
        requiredRootSessionId(request),
      ),
    );
  }

  const crabboxMessageMatch = url.pathname.match(/^\/api\/openclaw\/crabboxes\/([^/]+)\/message$/);
  if (request.method === "POST" && crabboxMessageMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    const body = await readJson<
      OpenClawMessageInput & {
        rootSessionId?: unknown;
      }
    >(request);
    return json(
      await dependencies.controller.messageCrabbox(
        request,
        decodedIdentifier(crabboxMessageMatch[1]),
        requiredRootSessionId(request, body.rootSessionId),
        body,
      ),
    );
  }

  const crabboxActionMatch = url.pathname.match(/^\/api\/openclaw\/crabboxes\/([^/]+)\/actions$/);
  if (request.method === "POST" && crabboxActionMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    const body = await readJson<{ rootSessionId?: unknown; action?: unknown }>(request);
    requireStopAction(body.action);
    return json(
      await dependencies.controller.stopCrabbox(
        request,
        decodedIdentifier(crabboxActionMatch[1]),
        requiredRootSessionId(request, body.rootSessionId),
      ),
    );
  }

  const crabboxReadMatch = url.pathname.match(/^\/api\/openclaw\/crabboxes\/([^/]+)$/);
  if (request.method === "GET" && crabboxReadMatch) {
    requireServiceToken(request, dependencies.roomTokens);
    return json(
      await dependencies.controller.readCrabbox(
        decodedIdentifier(crabboxReadMatch[1]),
        requiredRootSessionId(request),
      ),
    );
  }

  return null;
}

function requireServiceToken(request: Request, tokens: Array<string | null | undefined>): void {
  if (!tokens.some(Boolean)) {
    throw serviceUnavailable("OpenClaw service token is not configured");
  }
  if (!openClawServiceAuthorized(request.headers.get("authorization"), tokens)) {
    throw unauthorized();
  }
}

function requiredRootSessionId(request: Request, bodyValue?: unknown): string {
  const rootSessionId = String(
    bodyValue ?? request.headers.get("x-crabfleet-root-session-id") ?? "",
  )
    .trim()
    .slice(0, 120);
  if (!rootSessionId) throw badRequest("root session id is required");
  return rootSessionId;
}

function requireStopAction(action: unknown): void {
  if (action !== "stop") throw badRequest("only stop is supported");
}

function decodedIdentifier(value: string | undefined): string {
  return decodeURIComponent(value ?? "");
}
