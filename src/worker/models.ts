export type Role = "viewer" | "maintainer" | "owner";

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
