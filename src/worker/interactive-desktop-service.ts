import { sql } from "kysely";

import {
  currentAdapterDesktopConnection,
  runtimeAdapterDesktopUrl,
  runtimeAdapterName,
} from "../runtime-adapter.ts";
import { database } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest, forbidden, notFound, serviceUnavailable } from "./http.ts";
import type { User } from "./models.ts";
import { requireRegisteredRuntimeAdapterControlPlane } from "./runtime-adapter-preflight.ts";
import {
  readRuntimeAdapterResponseBody,
  runtimeAdapterFetch,
} from "./runtime-adapter-transport.ts";
import {
  canControlInteractiveSession,
  canViewInteractiveSession,
  delegatedInteractiveSessionControlAvailable,
} from "./session-access.ts";
import { InteractiveSessionGrantRepository } from "./session-grant-repository.ts";
import { interactiveSession, type InteractiveSession } from "./session-model.ts";
import { tenancyMode, tenantSubject } from "./tenancy.ts";

type DesktopMintResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type InteractiveDesktopServiceDependencies = {
  now(): number;
  readFreshSession(user: User, sessionId: string): Promise<InteractiveSession | null>;
  delegatedControlAvailable(session: InteractiveSession): boolean;
  canView(user: User, session: InteractiveSession): Promise<boolean>;
  canControl(user: User, session: InteractiveSession): Promise<boolean>;
  resolveControlPlane(sessionId: string, adapterWorkspaceId: string): Promise<string>;
  mintConnection(session: InteractiveSession, controlPlane: string): Promise<DesktopMintResult>;
  hasCurrentAccess(
    user: User,
    expected: InteractiveSession,
    controlPlane: string,
  ): Promise<boolean>;
};

export type InteractiveDesktopServiceFactoryDependencies = {
  readFreshSession(user: User, sessionId: string): Promise<InteractiveSession | null>;
  delegatedControlAvailable(session: InteractiveSession): boolean;
};

export class InteractiveDesktopService {
  private readonly dependencies: InteractiveDesktopServiceDependencies;

  constructor(dependencies: InteractiveDesktopServiceDependencies) {
    this.dependencies = dependencies;
  }

  async open(user: User, sessionId: string): Promise<Response> {
    const session = await this.dependencies.readFreshSession(user, sessionId);
    if (!session) throw notFound("interactive session not found");
    if (!(await this.dependencies.canView(user, session))) {
      throw notFound("interactive session not found");
    }
    if (!(await this.dependencies.canControl(user, session))) {
      throw forbidden("terminal control has not been granted");
    }
    if (["stopping", "stopped", "expired", "failed"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    if (session.adapter !== runtimeAdapterName) {
      throw badRequest("desktop access requires a runtime adapter session");
    }
    if (!["ready", "attached", "detached"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    if (!session.capabilities.vnc && !session.capabilities.desktop) {
      throw badRequest("session does not advertise desktop access");
    }
    if (!session.adapterWorkspaceId) {
      throw serviceUnavailable("runtime adapter workspace reference is incomplete");
    }

    let controlPlane: string;
    try {
      controlPlane = await this.dependencies.resolveControlPlane(
        session.id,
        session.adapterWorkspaceId,
      );
    } catch (error) {
      throw serviceUnavailable(clean(error instanceof Error ? error.message : String(error), 240));
    }

    let result: DesktopMintResult;
    try {
      result = await this.dependencies.mintConnection(session, controlPlane);
    } catch (error) {
      throw serviceUnavailable(
        `runtime adapter desktop connection failed: ${clean(String(error), 240)}`,
      );
    }
    if (!result.ok) {
      throw serviceUnavailable(`runtime adapter desktop connection HTTP ${result.status}`);
    }

    const connection = currentAdapterDesktopConnection(result.body, this.dependencies.now());
    if (!connection) throw serviceUnavailable("desktop connection has an invalid expiry");
    if (!(await this.dependencies.hasCurrentAccess(user, session, controlPlane))) {
      throw forbidden("desktop authorization changed; retry");
    }

    return new Response(null, {
      status: 302,
      headers: {
        location: connection.url,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      },
    });
  }
}

export function createInteractiveDesktopService(
  env: RuntimeEnv,
  dependencies: InteractiveDesktopServiceFactoryDependencies,
): InteractiveDesktopService {
  return new InteractiveDesktopService({
    now: Date.now,
    readFreshSession: dependencies.readFreshSession,
    delegatedControlAvailable: dependencies.delegatedControlAvailable,
    canView: (user, session) => currentInteractiveSessionAccess(env, user, session, "view"),
    canControl: (user, session) => currentInteractiveSessionAccess(env, user, session, "control"),
    resolveControlPlane: (sessionId, adapterWorkspaceId) =>
      registeredRuntimeAdapterControlPlaneForSession(env, sessionId, adapterWorkspaceId),
    mintConnection: async (session, controlPlane) => {
      const response = await runtimeAdapterFetch(
        env,
        runtimeAdapterDesktopUrl(controlPlane, session.adapterWorkspaceId!),
        { method: "POST" },
      );
      return {
        ok: response.ok,
        status: response.status,
        body: await readRuntimeAdapterResponseBody(response),
      };
    },
    hasCurrentAccess: (user, expected, controlPlane) =>
      currentRuntimeAdapterDesktopAccess(
        env,
        user,
        expected,
        controlPlane,
        dependencies.delegatedControlAvailable,
      ),
  });
}

async function registeredRuntimeAdapterControlPlaneForSession(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
): Promise<string> {
  const registration = await database(env)
    .selectFrom("interactive_sessions")
    .select(["adapter_control_plane", "profile"])
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .executeTakeFirst();
  return requireRegisteredRuntimeAdapterControlPlane(
    env,
    registration?.profile ?? "",
    registration?.adapter_control_plane,
  );
}

async function currentRuntimeAdapterDesktopAccess(
  env: RuntimeEnv,
  user: User,
  expected: InteractiveSession,
  controlPlane: string,
  delegatedControlAvailable: (session: InteractiveSession) => boolean,
): Promise<boolean> {
  const currentRow = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", expected.id)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", expected.adapterWorkspaceId)
    .where("adapter_control_plane", "=", controlPlane)
    .where(sql<boolean>`provider_resource_id IS ${expected.providerResourceId}`)
    .where("runtime", "=", expected.runtime)
    .where("profile", "=", expected.profile)
    .where("adapter_create_pending", "=", 0)
    .where("status", "in", ["ready", "attached", "detached"])
    .executeTakeFirst();
  if (!currentRow) return false;
  const current = interactiveSession(currentRow, []);
  if (!current.capabilities.vnc && !current.capabilities.desktop) return false;
  const now = Date.now();
  const grant = await new InteractiveSessionGrantRepository(env).readActive(
    current.id,
    tenantSubject(user),
    now,
  );
  return canControlInteractiveSession(user, current, now, delegatedControlAvailable(current), {
    mode: tenancyMode(env),
    grant,
  });
}

async function currentInteractiveSessionAccess(
  env: RuntimeEnv,
  user: User,
  session: InteractiveSession,
  needed: "view" | "control",
): Promise<boolean> {
  const now = Date.now();
  const grant = await new InteractiveSessionGrantRepository(env).readActive(
    session.id,
    tenantSubject(user),
    now,
  );
  const context = { mode: tenancyMode(env), grant } as const;
  return needed === "control"
    ? canControlInteractiveSession(
        user,
        session,
        now,
        delegatedInteractiveSessionControlAvailable(Boolean(env.SANDBOX), session),
        context,
      )
    : canViewInteractiveSession(user, session, now, context);
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
