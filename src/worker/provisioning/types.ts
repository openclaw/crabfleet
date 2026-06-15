import type { InteractiveSessionStatus } from "../models.ts";
import type { SandboxCurrentLeaseFence, SandboxLease } from "../sandbox-lease.ts";
import type { RuntimeCapabilities } from "../session-model.ts";

export type InteractiveProvisionResult = {
  status: InteractiveSessionStatus;
  leaseId: string | null;
  attachUrl: string | null;
  attachUrlPresent?: boolean;
  vncUrl: string | null;
  message: string;
  adapter?: string | null;
  profile?: string;
  adapterWorkspaceId?: string | null;
  providerResourceId?: string | null;
  capabilities?: RuntimeCapabilities | null;
  capabilitiesPresent?: boolean;
  expiresAt?: number | null;
  expiresAtPresent?: boolean;
  reconciledAt?: number | null;
  reconcileError?: string | null;
  terminalStatus?: "failed" | null;
  createPending?: boolean;
};

export type InteractiveProvisionPersistence = {
  updated: boolean;
  terminalStatus: "stopped" | "expired" | "failed" | null;
  terminalAt: number;
};

export type InteractiveProvisionPersistenceInput = {
  sessionId: string;
  insertedAt: number;
  profile: string;
  requestedCapabilities: RuntimeCapabilities;
  initialLeaseId: string | null;
  initialAgentTokenHash: string;
  adapterName: string;
};

export type InteractiveProvisionRuntime = "container" | "crabbox";

export type InteractiveProvisionRequest = {
  id: string;
  adapterWorkspaceId?: string | null;
  adapterControlPlane?: string | null;
  adapterTtlSeconds?: number | null;
  adapterIdleTimeoutSeconds?: number | null;
  adapterRequestedCapabilities?: RuntimeCapabilities | null;
  adapterCreatePayloadJson?: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
  repo: string;
  branch: string;
  runtime: InteractiveProvisionRuntime;
  profile: string;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  githubToken?: string;
};

export type SandboxProvisionOwnership = {
  lease: SandboxLease;
  ownership: SandboxCurrentLeaseFence;
};
