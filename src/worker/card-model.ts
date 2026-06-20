import type { RunStatus } from "./models.ts";
import type { RuntimeCapabilities } from "./session-model.ts";
import type { CardSchedule } from "./card-schedule.ts";

export const cardOwnerSubject = Symbol("cardOwnerSubject");

export type WorkflowConfig = {
  runtime?: string;
  policy?: string;
  stallMs?: number;
  cap?: number;
  promptPrefix?: string;
};

export type Card = {
  [cardOwnerSubject]: string;
  id: string;
  title: string;
  prompt: string;
  repo: string;
  source: string;
  runtime: string;
  policy: string;
  lane: string;
  owner: string;
  startedAt: number | null;
  createdAt: number;
  schedule: CardSchedule | null;
  nextRunAt: number | null;
  lastScheduledRunAt: number | null;
  logs: string[];
  changes: CardChanges;
  run: RunAttempt | null;
};

export type DueRecurringCard = {
  id: string;
  scheduleJson: string;
  dueAt: number;
};

export type RecurringSchedulerTickResult = {
  status: "ok";
  now: number;
  scanned: number;
  claimed: number;
  queued: number;
  skipped: number;
  invalid: number;
};

export type RunAttempt = {
  id: string;
  cardId: string;
  attempt: number;
  runtime: string;
  status: RunStatus;
  controlIntent: string | null;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  ptyAvailable: boolean;
  selectionReason: string | null;
  capabilities: RuntimeCapabilities;
  operator: string | null;
  lastHeartbeatAt: number;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
};

export type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

export type ChangedFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
};

export type CardChanges = {
  files: ChangedFile[];
  patch: string;
  totals: {
    additions: number;
    deletions: number;
    files: number;
  };
};

export const activeRunStatuses: readonly RunStatus[] = ["queued", "leasing", "running"];
export const cardLanes = ["Todo", "Running", "Human Review", "Done"] as const;
export const cardRuntimeOptions = ["auto", "container", "crabbox"] as const;
export const mergePolicyOptions = [
  "open_pr",
  "merge_when_green",
  "fix_until_green_and_merge",
] as const;
