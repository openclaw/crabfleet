import {
  githubActionsCapabilities,
  githubActionsRuntime,
  parseGitHubActionsWorkState,
  type GitHubActionsWorkState,
} from "../github-actions-runtime.ts";
import type { ResolvedRuntimeProfileCodexSsh } from "../runtime-profiles.ts";
import type { InteractiveSessionLogArchiveTable, InteractiveSessionRow } from "./database.ts";
import type { InteractiveRuntime, InteractiveSessionStatus } from "./models.ts";

export type RuntimeCapabilities = {
  terminal: boolean;
  takeover: boolean;
  vnc: boolean;
  desktop: boolean;
  logs: boolean;
  artifacts: boolean;
};

export const containerCapabilities: RuntimeCapabilities = {
  terminal: true,
  takeover: false,
  vnc: false,
  desktop: false,
  logs: true,
  artifacts: true,
};

export const crabboxCapabilities: RuntimeCapabilities = {
  terminal: true,
  takeover: true,
  vnc: true,
  desktop: true,
  logs: true,
  artifacts: true,
};

export const interactiveSessionAdapterControlPlane = Symbol(
  "interactiveSessionAdapterControlPlane",
);

export type InteractiveSession = {
  [interactiveSessionAdapterControlPlane]: string | null;
  id: string;
  parentSessionId: string | null;
  rootSessionId: string | null;
  repo: string;
  branch: string;
  runtime: InteractiveRuntime;
  adapter: string | null;
  profile: string;
  adapterWorkspaceId: string | null;
  providerResourceId: string | null;
  capabilities: RuntimeCapabilities;
  expiresAt: number | null;
  lastReconciledAt: number | null;
  reconcileError: string | null;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  status: InteractiveSessionStatus;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  lastEvent: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  stoppedAt: number | null;
  shareMode: "private" | "link_read";
  shareTokenPreview: string | null;
  controlRequestedBy: string | null;
  controlRequestedAt: number | null;
  controller: string | null;
  controlGrantedAt: number | null;
  controlExpiresAt: number | null;
  multiplayerMode: boolean;
  workKey: string | null;
  workKind: string | null;
  workState: GitHubActionsWorkState | null;
  workPhase: string;
  sourceUrl: string | null;
  githubRunUrl: string | null;
  codexThreadId: string | null;
  codexTurnId: string | null;
  lastHeartbeatAt: number | null;
  completionReason: string | null;
  canControl?: boolean;
  canManage?: boolean;
  canChangeMultiplayer?: boolean;
  canRequestControl?: boolean;
  sharedReadOnly?: boolean;
  ptyAvailable?: boolean;
  codexSsh?: ResolvedRuntimeProfileCodexSsh | null;
  logs: string[];
  logArchive: InteractiveSessionLogArchive | null;
};

export type InteractiveSessionLogArchive = {
  sessionId: string;
  eventCount: number;
  eventsKey: string | null;
  transcriptKey: string | null;
  summaryKey: string | null;
  archivedAt: number;
  updatedAt: number;
};

export type InteractiveSessionEvent = {
  actor: string;
  message: string;
  createdAt: number;
};

export type InteractiveSessionEventRow = {
  id: number;
  session_id: string;
  actor: string;
  message: string;
  created_at: number;
};

export function interactiveSession(
  row: InteractiveSessionRow,
  logs: string[],
  logArchive: InteractiveSessionLogArchive | null = null,
): InteractiveSession {
  const capabilities = runtimeCapabilities(row.runtime, row.capabilities_json);
  return {
    [interactiveSessionAdapterControlPlane]: row.adapter_control_plane,
    id: row.id,
    parentSessionId: row.parent_session_id,
    rootSessionId: row.root_session_id ?? row.id,
    repo: row.repo,
    branch: row.branch,
    runtime: row.runtime,
    adapter: row.adapter,
    profile: row.profile,
    adapterWorkspaceId: row.adapter_workspace_id,
    providerResourceId: row.provider_resource_id,
    capabilities,
    expiresAt: row.expires_at,
    lastReconciledAt: row.last_reconciled_at,
    reconcileError: row.reconcile_error,
    command: row.command,
    prompt: row.prompt,
    purpose: row.purpose,
    summary: row.summary,
    owner: row.owner,
    createdBy: row.created_by,
    status: row.status,
    leaseId: row.lease_id,
    attachUrl: capabilities.terminal ? row.attach_url : null,
    vncUrl: row.vnc_url,
    lastEvent: row.last_event,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    stoppedAt: row.stopped_at,
    shareMode: row.share_mode,
    shareTokenPreview: row.share_token_preview,
    controlRequestedBy: row.control_requested_by,
    controlRequestedAt: row.control_requested_at,
    controller: row.controller,
    controlGrantedAt: row.control_granted_at,
    controlExpiresAt: row.control_expires_at,
    multiplayerMode: row.multiplayer_mode === 1,
    workKey: row.work_key,
    workKind: row.work_kind,
    workState: parseGitHubActionsWorkState(row.work_state),
    workPhase: row.work_phase,
    sourceUrl: row.source_url,
    githubRunUrl: row.github_run_url,
    codexThreadId: row.codex_thread_id,
    codexTurnId: row.codex_turn_id,
    lastHeartbeatAt: row.last_heartbeat_at,
    completionReason: row.completion_reason,
    logs,
    logArchive,
  };
}

export function interactiveSessionEvent(row: InteractiveSessionEventRow): InteractiveSessionEvent {
  return {
    actor: row.actor,
    message: row.message,
    createdAt: row.created_at,
  };
}

export function interactiveSessionLogArchive(
  row: InteractiveSessionLogArchiveTable,
): InteractiveSessionLogArchive {
  return {
    sessionId: row.session_id,
    eventCount: row.event_count,
    eventsKey: row.events_key,
    transcriptKey: row.transcript_key,
    summaryKey: row.summary_key,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

export function runtimeCapabilities(runtime: string, value: string): RuntimeCapabilities {
  const fallback =
    runtime === githubActionsRuntime
      ? githubActionsCapabilities
      : runtime === "crabbox"
        ? crabboxCapabilities
        : containerCapabilities;
  const parsed = parseJson<Partial<RuntimeCapabilities>>(value, fallback);
  return {
    terminal: booleanCapability(parsed.terminal, fallback.terminal),
    takeover: booleanCapability(parsed.takeover, fallback.takeover),
    vnc: booleanCapability(parsed.vnc, fallback.vnc),
    desktop: booleanCapability(parsed.desktop, fallback.desktop),
    logs: booleanCapability(parsed.logs, fallback.logs),
    artifacts: booleanCapability(parsed.artifacts, fallback.artifacts),
  };
}

function booleanCapability(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
