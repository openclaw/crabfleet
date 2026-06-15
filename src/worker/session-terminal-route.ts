import { ptyRouteKind, type PtyRouteKind } from "../fleet-state.ts";
import {
  legacyLeaseIdForAdapter,
  runtimeAdapterName,
  runtimeAdapterTerminalOriginMatches,
  safeWebSocketUrl,
} from "../runtime-adapter.ts";
import type { RuntimeEnv } from "./env.ts";
import { bearer } from "./http.ts";
import {
  requireRegisteredRuntimeAdapterControlPlane,
  runtimeAdapterToken,
} from "./runtime-adapter-preflight.ts";
import { interactiveSessionAdapterControlPlane, type InteractiveSession } from "./session-model.ts";

export type InteractiveTerminalTarget = {
  url: string;
  authorization: string | null;
};

export function interactiveTerminalTarget(
  env: RuntimeEnv,
  session: InteractiveSession,
  routeKind = interactivePtyRouteKind(env, session),
): InteractiveTerminalTarget | null {
  if (routeKind === "bridge" && env.CRABBOX_PTY_BRIDGE_URL) {
    const url = interactiveBridgeUrl(env.CRABBOX_PTY_BRIDGE_URL, session);
    if (!url) return null;
    return {
      url,
      authorization: bearer(env.CRABBOX_PTY_BRIDGE_TOKEN),
    };
  }

  const attachUrl = routeKind === "attach" ? safeWebSocketUrl(session.attachUrl) : null;
  if (attachUrl) {
    if (session.adapter === runtimeAdapterName) {
      const authorization = runtimeAdapterTerminalAuthorization(
        env,
        session.profile,
        session[interactiveSessionAdapterControlPlane],
        attachUrl,
      );
      return authorization ? { url: attachUrl, authorization } : null;
    }
    return {
      url: attachUrl,
      authorization: null,
    };
  }

  return null;
}

export function runtimeAdapterTerminalAuthorization(
  env: RuntimeEnv,
  profile: string,
  registeredControlPlane: string | null,
  attachUrl: string,
): string | null {
  try {
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      env,
      profile,
      registeredControlPlane,
    );
    if (!runtimeAdapterTerminalOriginMatches(controlPlane, attachUrl)) return null;
    return bearer(runtimeAdapterToken(env));
  } catch {
    return null;
  }
}

export function interactivePtyRouteKind(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "adapter" | "leaseId" | "attachUrl">,
): PtyRouteKind | null {
  return ptyRouteKind(session, {
    sandboxAvailable: Boolean(env.SANDBOX),
    bridgeUrl: env.CRABBOX_PTY_BRIDGE_URL,
  });
}

export function interactiveBridgeUrl(base: string, session: InteractiveSession): string {
  const leaseId = legacyLeaseIdForAdapter(session.adapter, session.leaseId) ?? "";
  const replacements: Record<string, string> = {
    id: session.id,
    leaseId,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
  };
  let url = base;
  for (const [key, value] of Object.entries(replacements)) {
    url = url.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return safeWebSocketUrl(addQuery(httpToWebSocketUrl(url), terminalQuery(session))) ?? "";
}

export function terminalQuery(session: InteractiveSession): Record<string, string> {
  return {
    sessionId: session.id,
    leaseId: legacyLeaseIdForAdapter(session.adapter, session.leaseId) ?? "",
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    profile: session.profile,
    command: session.command,
  };
}

export function interactiveTerminalHeaders(
  session: InteractiveSession,
  authorization: string | null,
): Headers {
  const headers = new Headers({
    upgrade: "websocket",
    "x-crabbox-session": session.id,
    "x-crabbox-repo": session.repo,
    "x-crabbox-runtime": session.runtime,
  });
  if (authorization) headers.set("authorization", authorization);
  return headers;
}

function addQuery(rawUrl: string, params: Record<string, string>): string {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function httpToWebSocketUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  } catch {
    return "";
  }
}
