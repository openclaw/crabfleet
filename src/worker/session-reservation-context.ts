import {
  namespacedAdapterWorkspaceId,
  normalizeAdapterNamespace,
  runtimeAdapterCreatePayload,
} from "../runtime-adapter.ts";
import { sha256 } from "./crypto.ts";
import { clampedSeconds } from "./duration.ts";
import type { RuntimeEnv } from "./env.ts";
import { serviceUnavailable } from "./http.ts";
import {
  newSandboxLease,
  sandboxLeaseId,
  type SandboxCurrentLeaseFence,
  type SandboxLease,
} from "./sandbox-lease.ts";
import type { ResolvedInteractiveSessionCreateRequest } from "./session-create-request.ts";
import {
  configuredRuntimeAdapterControlPlane,
  runtimeAdapterConfigurationPresent,
} from "./runtime-adapter-preflight.ts";
import type { RuntimeCapabilities } from "./session-model.ts";

export type RuntimeAdapterReservationSettings = {
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  capabilities: RuntimeCapabilities;
};

export type InteractiveSessionReservationContext = {
  agentToken: string;
  initialAgentTokenHash: string;
  initialSandboxLease: SandboxLease | null;
  initialSandboxOwnership: SandboxCurrentLeaseFence | null;
  adapterWorkspaceId: string | null;
  adapterControlPlane: string | null;
  adapterSettings: RuntimeAdapterReservationSettings | null;
  adapterCreatePayloadJson: string | null;
};

export async function createInteractiveSessionReservationContext(
  env: RuntimeEnv,
  request: ResolvedInteractiveSessionCreateRequest,
  session: {
    id: string;
    parentSessionId: string | null;
    rootSessionId: string;
  },
): Promise<InteractiveSessionReservationContext> {
  const agentToken = newAgentToken();
  const initialAgentTokenHash = await sha256(agentToken);
  const initialSandboxLease =
    request.runtime === "container" && env.SANDBOX ? newSandboxLease(session.id) : null;
  const initialSandboxOwnership: SandboxCurrentLeaseFence | null = initialSandboxLease
    ? {
        leaseId: sandboxLeaseId(initialSandboxLease),
        sandboxId: initialSandboxLease.sandboxId,
      }
    : null;
  const adapterIdentity = initialRuntimeAdapterIdentity(env, request.runtime, session.id);
  const adapterWorkspaceId = adapterIdentity?.workspaceId ?? null;
  const adapterControlPlane = adapterWorkspaceId
    ? configuredRuntimeAdapterControlPlane(env, request.profile)
    : null;
  const adapterSettings = adapterWorkspaceId
    ? runtimeAdapterCreateSettings(env, request.requestedCapabilities)
    : null;
  const adapterCreatePayload =
    adapterIdentity && adapterSettings
      ? runtimeAdapterCreatePayload(
          {
            namespace: adapterIdentity.namespace,
            id: session.id,
            parentSessionId: session.parentSessionId,
            rootSessionId: session.rootSessionId,
            repo: request.repo,
            branch: request.branch,
            runtime: request.runtime,
            profile: request.profile,
            command: request.command,
            prompt: request.prompt,
            purpose: request.purpose,
            summary: request.summary,
            owner: request.owner,
            createdBy: request.createdBy,
            ttlSeconds: adapterSettings.ttlSeconds,
            idleTimeoutSeconds: adapterSettings.idleTimeoutSeconds,
            desktop: adapterSettings.capabilities.desktop,
          },
          adapterIdentity.workspaceId,
        )
      : null;
  return {
    agentToken,
    initialAgentTokenHash,
    initialSandboxLease,
    initialSandboxOwnership,
    adapterWorkspaceId,
    adapterControlPlane,
    adapterSettings,
    adapterCreatePayloadJson: adapterCreatePayload ? JSON.stringify(adapterCreatePayload) : null,
  };
}

export function newAgentToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
}

function initialRuntimeAdapterIdentity(
  env: RuntimeEnv,
  runtime: "crabbox" | "container",
  sessionId: string,
): { namespace: string; workspaceId: string } | null {
  if (!runtimeAdapterConfigurationPresent(env) || (runtime === "container" && env.SANDBOX)) {
    return null;
  }
  const namespace = normalizeAdapterNamespace(env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "");
  if (!namespace) {
    throw serviceUnavailable(
      "runtime adapter namespace is required and must be a DNS-safe label of at most 32 characters",
    );
  }
  const workspaceId = namespacedAdapterWorkspaceId(namespace, sessionId);
  if (!workspaceId) throw serviceUnavailable("runtime adapter workspace id is invalid");
  return { namespace, workspaceId };
}

function runtimeAdapterCreateSettings(
  env: RuntimeEnv,
  capabilities: RuntimeCapabilities,
): RuntimeAdapterReservationSettings {
  return {
    ttlSeconds: clampedSeconds(env.CRABBOX_RUNTIME_ADAPTER_TTL_SECONDS, 14_400),
    idleTimeoutSeconds: clampedSeconds(env.CRABBOX_RUNTIME_ADAPTER_IDLE_SECONDS, 1_800),
    capabilities,
  };
}
