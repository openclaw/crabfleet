import { normalizedSecureWebSocketUrl } from "./url-security.ts";
import { fleetSessionAttentionReason } from "./fleet-attention.ts";

export type FleetStatus =
  | "provisioning"
  | "pending_adapter"
  | "ready"
  | "attached"
  | "detached"
  | "stopping"
  | "stopped"
  | "expired"
  | "failed";

export type FleetRuntime = "crabbox" | "container" | "github_actions";

export type FleetSessionInput = {
  id: string;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  repo: string;
  branch: string;
  runtime: FleetRuntime;
  adapter?: string | null;
  owner: string;
  createdBy?: string;
  purpose?: string;
  summary?: string;
  workKey?: string | null;
  workKind?: string | null;
  workState?: string | null;
  workPhase?: string;
  sourceUrl?: string | null;
  githubRunUrl?: string | null;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  lastHeartbeatAt?: number | null;
  completionReason?: string | null;
  status: FleetStatus;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  capabilities?: { vnc?: boolean; desktop?: boolean; terminal?: boolean };
  canControl?: boolean;
  ptyAvailable?: boolean;
  expiresAt?: number | null;
  reconcileError?: string | null;
  reconciliationNeedsAttention?: boolean;
  lastEvent: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  stoppedAt: number | null;
  logs?: string[];
  logArchive?: { eventCount: number } | null;
};

export type FleetSandboxPolicySummary = {
  allowedHostCount: number;
  allowedHosts?: string[];
  githubCredentialSource: "none" | "session" | "worker";
  githubRepo: string;
  hasGithubRepoNodeId: boolean;
  hasGithubToken: boolean;
  openAIBaseUrlHost: string | null;
  openAIOrgConfigured: boolean;
  owner: string;
  sandboxId: string;
  sessionId: string;
};

export type FleetStateOptions = {
  canonicalUrl: string;
  defaultEgressHosts: readonly string[];
  generatedAt: number;
  productUrl: string;
  registryAvailable?: boolean;
  sandboxAvailable?: boolean | undefined;
  desktopHosts?: FleetDesktopHostSummary[];
};

export type FleetDesktopHostSummary = {
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  createdAt: number;
  updatedAt: number;
};

export type FleetSessionSummary = {
  id: string;
  parentSessionId: string | null;
  rootSessionId: string | null;
  repo: string;
  branch: string;
  runtime: FleetRuntime;
  owner: string;
  createdBy: string;
  purpose: string;
  summary: string;
  workKey: string | null;
  workKind: string | null;
  workState: string | null;
  workPhase: string;
  sourceUrl: string | null;
  githubRunUrl: string | null;
  codexThreadId: string | null;
  codexTurnId: string | null;
  lastHeartbeatAt: number | null;
  completionReason: string | null;
  status: FleetStatus;
  active: boolean;
  attention: boolean;
  attentionReason: string | null;
  attachable: boolean;
  vnc: boolean;
  archived: boolean;
  logEvents: number;
  leaseId: string | null;
  sandboxId: string | null;
  lastEvent: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  stoppedAt: number | null;
  policy: {
    allowedHostCount: number;
    githubCredentialSource: "none" | "session" | "worker";
    githubRepo: string | null;
    hasGithubToken: boolean;
    openAIBaseUrlHost: string | null;
    present: boolean;
  };
};

export type FleetState = {
  canonicalUrl: string;
  productUrl: string;
  generatedAt: number;
  desktopHosts: FleetDesktopHostSummary[];
  registryAvailable: boolean;
  egress: {
    defaultHostCount: number;
    policyCount: number;
    sessionsWithPolicy: number;
  };
  totals: {
    active: number;
    archived: number;
    attachable: number;
    byRuntime: Record<FleetRuntime, number>;
    byStatus: Record<FleetStatus, number>;
    attention: number;
    failed: number;
    provisioning: number;
    ready: number;
    sessions: number;
    stopped: number;
    vnc: number;
  };
  sessions: FleetSessionSummary[];
};

export type PtyRouteKind = "sandbox" | "attach";

export type PtyRouteSession = {
  adapter?: string | null;
  leaseId: string | null;
  attachUrl: string | null;
};

export type PtyRouteConfig = {
  sandboxAvailable?: boolean | undefined;
};

const allStatuses: FleetStatus[] = [
  "provisioning",
  "pending_adapter",
  "ready",
  "attached",
  "detached",
  "stopping",
  "stopped",
  "expired",
  "failed",
];

const inactiveStatuses = new Set<FleetStatus>(["stopping", "stopped", "expired", "failed"]);
const ptyReadyStatuses = new Set<FleetStatus>(["ready", "attached", "detached"]);

export function buildFleetState(
  sessions: FleetSessionInput[],
  policies: FleetSandboxPolicySummary[],
  options: FleetStateOptions,
): FleetState {
  const visibleSessionIds = new Set(sessions.map((session) => session.id));
  const visiblePolicies = policies.filter((policy) => visibleSessionIds.has(policy.sessionId));
  const policiesBySession = new Map<string, FleetSandboxPolicySummary>();
  for (const policy of visiblePolicies) {
    if (!policiesBySession.has(policy.sessionId)) policiesBySession.set(policy.sessionId, policy);
  }
  const sessionSummaries = sessions
    .map((session) =>
      fleetSessionSummary(session, policiesBySession.get(session.id) ?? null, options),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

  const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<
    FleetStatus,
    number
  >;
  const byRuntime: Record<FleetRuntime, number> = {
    crabbox: 0,
    container: 0,
    github_actions: 0,
  };
  for (const session of sessionSummaries) {
    byStatus[session.status] += 1;
    byRuntime[session.runtime] += 1;
  }

  return {
    canonicalUrl: options.canonicalUrl,
    productUrl: options.productUrl,
    generatedAt: options.generatedAt,
    desktopHosts: [...(options.desktopHosts ?? [])].sort(
      (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id),
    ),
    registryAvailable: options.registryAvailable ?? true,
    egress: {
      defaultHostCount: options.defaultEgressHosts.length,
      policyCount: visiblePolicies.length,
      sessionsWithPolicy: sessionSummaries.filter((session) => session.policy.present).length,
    },
    totals: {
      active: sessionSummaries.filter((session) => session.active).length,
      archived: sessionSummaries.filter((session) => session.archived).length,
      attachable: sessionSummaries.filter((session) => session.attachable).length,
      byRuntime,
      byStatus,
      attention: sessionSummaries.filter((session) => session.attention).length,
      failed: byStatus.failed,
      provisioning: sessionSummaries.filter(
        (session) => session.status === "provisioning" && !session.attention,
      ).length,
      ready: byStatus.ready + byStatus.attached + byStatus.detached,
      sessions: sessionSummaries.length,
      stopped: byStatus.stopped + byStatus.expired,
      vnc: sessionSummaries.filter((session) => session.vnc).length,
    },
    sessions: sessionSummaries,
  };
}

export function fleetSessionSummary(
  session: FleetSessionInput,
  policy: FleetSandboxPolicySummary | null,
  options: Pick<FleetStateOptions, "generatedAt" | "sandboxAvailable">,
): FleetSessionSummary {
  const sandboxId = sandboxIdFromLeaseId(session.leaseId);
  const archived = Boolean(session.logArchive?.eventCount);
  const attentionReason = fleetSessionAttentionReason(session, options.generatedAt);
  const terminalCapable =
    session.capabilities?.terminal === true ||
    (session.adapter !== "runtime-v1" && session.capabilities?.terminal !== false);
  return {
    id: session.id,
    parentSessionId: session.parentSessionId ?? null,
    rootSessionId: session.rootSessionId ?? session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    owner: session.owner,
    createdBy: session.createdBy ?? session.owner,
    purpose: session.purpose ?? "",
    summary: session.summary ?? session.purpose ?? session.lastEvent,
    workKey: session.workKey ?? null,
    workKind: session.workKind ?? null,
    workState: session.workState ?? null,
    workPhase: session.workPhase ?? "",
    sourceUrl: session.sourceUrl ?? null,
    githubRunUrl: session.githubRunUrl ?? null,
    codexThreadId: session.codexThreadId ?? null,
    codexTurnId: session.codexTurnId ?? null,
    lastHeartbeatAt: session.lastHeartbeatAt ?? null,
    completionReason: session.completionReason ?? null,
    status: session.status,
    active: !inactiveStatuses.has(session.status),
    attention: attentionReason !== null,
    attentionReason,
    attachable:
      terminalCapable &&
      (session.ptyAvailable === true ||
        (session.canControl !== false &&
          (session.runtime === "github_actions" ||
            (session.ptyAvailable ??
              Boolean(
                ptyRouteKind(session, {
                  sandboxAvailable: options.sandboxAvailable,
                }),
              ))))) &&
      ptyReadyStatuses.has(session.status),
    vnc:
      !inactiveStatuses.has(session.status) &&
      session.adapter === "runtime-v1" &&
      Boolean(session.capabilities?.vnc || session.capabilities?.desktop),
    archived,
    logEvents: session.logArchive?.eventCount ?? session.logs?.length ?? 0,
    leaseId: session.leaseId,
    sandboxId,
    lastEvent: session.lastEvent,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    lastSeenAt: session.lastSeenAt,
    stoppedAt: session.stoppedAt,
    policy: {
      allowedHostCount: policy?.allowedHostCount ?? 0,
      githubCredentialSource: policy?.githubCredentialSource ?? "none",
      githubRepo: policy?.githubRepo ?? null,
      hasGithubToken: policy?.hasGithubToken ?? false,
      openAIBaseUrlHost: policy?.openAIBaseUrlHost ?? null,
      present: Boolean(policy),
    },
  };
}

export function sandboxIdFromLeaseId(leaseId: string | null | undefined): string | null {
  if (!leaseId?.startsWith("sandbox:")) return null;
  const [sandboxId] = leaseId.slice("sandbox:".length).split(":");
  return sandboxId || null;
}

export function ptyRouteKind(
  session: PtyRouteSession,
  config: PtyRouteConfig,
): PtyRouteKind | null {
  const leaseId = session.adapter === "runtime-v1" ? null : session.leaseId;
  if (config.sandboxAvailable && leaseId?.startsWith("sandbox:")) return "sandbox";
  if (safePtyWebSocketUrl(session.attachUrl)) return "attach";
  return null;
}

function safePtyWebSocketUrl(value: string | null | undefined): string | null {
  return normalizedSecureWebSocketUrl(value);
}
