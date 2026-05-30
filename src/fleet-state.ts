export type FleetStatus =
  | "provisioning"
  | "pending_adapter"
  | "ready"
  | "attached"
  | "detached"
  | "stopped"
  | "expired"
  | "failed";

export type FleetRuntime = "crabbox" | "container";

export type FleetSessionInput = {
  id: string;
  repo: string;
  branch: string;
  runtime: FleetRuntime;
  owner: string;
  status: FleetStatus;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
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
};

export type FleetSessionSummary = {
  id: string;
  repo: string;
  branch: string;
  runtime: FleetRuntime;
  owner: string;
  status: FleetStatus;
  active: boolean;
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
    failed: number;
    provisioning: number;
    ready: number;
    sessions: number;
    stopped: number;
    vnc: number;
  };
  sessions: FleetSessionSummary[];
};

const allStatuses: FleetStatus[] = [
  "provisioning",
  "pending_adapter",
  "ready",
  "attached",
  "detached",
  "stopped",
  "expired",
  "failed",
];

const inactiveStatuses = new Set<FleetStatus>(["stopped", "expired", "failed"]);

export function buildFleetState(
  sessions: FleetSessionInput[],
  policies: FleetSandboxPolicySummary[],
  options: FleetStateOptions,
): FleetState {
  const policiesBySession = new Map<string, FleetSandboxPolicySummary>();
  for (const policy of policies) {
    if (!policiesBySession.has(policy.sessionId)) policiesBySession.set(policy.sessionId, policy);
  }
  const sessionSummaries = sessions
    .map((session) => fleetSessionSummary(session, policiesBySession.get(session.id) ?? null))
    .sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));

  const byStatus = Object.fromEntries(allStatuses.map((status) => [status, 0])) as Record<
    FleetStatus,
    number
  >;
  const byRuntime: Record<FleetRuntime, number> = { crabbox: 0, container: 0 };
  for (const session of sessionSummaries) {
    byStatus[session.status] += 1;
    byRuntime[session.runtime] += 1;
  }

  return {
    canonicalUrl: options.canonicalUrl,
    productUrl: options.productUrl,
    generatedAt: options.generatedAt,
    registryAvailable: options.registryAvailable ?? true,
    egress: {
      defaultHostCount: options.defaultEgressHosts.length,
      policyCount: policies.length,
      sessionsWithPolicy: sessionSummaries.filter((session) => session.policy.present).length,
    },
    totals: {
      active: sessionSummaries.filter((session) => session.active).length,
      archived: sessionSummaries.filter((session) => session.archived).length,
      attachable: sessionSummaries.filter((session) => session.attachable).length,
      byRuntime,
      byStatus,
      failed: byStatus.failed,
      provisioning: byStatus.provisioning + byStatus.pending_adapter,
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
): FleetSessionSummary {
  const sandboxId = sandboxIdFromLeaseId(session.leaseId);
  const archived = Boolean(session.logArchive?.eventCount);
  return {
    id: session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    owner: session.owner,
    status: session.status,
    active: !inactiveStatuses.has(session.status),
    attachable: Boolean(session.attachUrl) && !inactiveStatuses.has(session.status),
    vnc: Boolean(session.vncUrl),
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
