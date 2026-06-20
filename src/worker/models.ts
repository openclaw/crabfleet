export type Role = "viewer" | "maintainer" | "owner";

export const userTenantSubject = Symbol("userTenantSubject");
export const userSessionOwnerSubject = Symbol("userSessionOwnerSubject");
export const userServiceSessionAuthority = Symbol("userServiceSessionAuthority");

export type User = {
  [userTenantSubject]?: string;
  [userSessionOwnerSubject]?: string;
  [userServiceSessionAuthority]?: string;
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  allowed: boolean;
  teams: string[];
};

export type InteractiveRuntime = "crabbox" | "container" | "github_actions";

export type WorkflowStatus = "ok" | "missing" | "invalid" | "error";

export type RunStatus =
  | "queued"
  | "leasing"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "stalled"
  | "canceled";

export type InteractiveSessionStatus =
  | "provisioning"
  | "pending_adapter"
  | "ready"
  | "attached"
  | "detached"
  | "stopping"
  | "stopped"
  | "expired"
  | "failed";

export const deadInteractiveSessionStatuses: readonly InteractiveSessionStatus[] = [
  "stopped",
  "expired",
  "failed",
];
