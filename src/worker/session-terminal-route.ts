import { ptyRouteKind, type PtyRouteKind } from "../fleet-state.ts";
import { githubActionsRuntime } from "../github-actions-runtime.ts";
import {
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
  });
}

export function interactiveTerminalRouteAvailable(
  env: RuntimeEnv,
  session: InteractiveSession,
): boolean {
  if (session.runtime === githubActionsRuntime) return true;
  const routeKind = interactivePtyRouteKind(env, session);
  return routeKind === "sandbox"
    ? Boolean(env.SANDBOX)
    : Boolean(interactiveTerminalTarget(env, session, routeKind));
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
