import type { WorkflowStatus } from "./models.ts";
import type { WorkflowConfig } from "./card-model.ts";

export type RepoWorkflow = {
  repo: string;
  status: WorkflowStatus;
  sourcePath: string;
  sourceSha: string | null;
  config: WorkflowConfig;
  prompt: string;
  error: string | null;
  evaluatedAt: number;
  updatedAt: number;
};
