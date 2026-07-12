import { type Insertable } from "kysely";

import { githubActionsCapabilities, githubActionsRuntime } from "../github-actions-runtime.ts";
import type { InteractiveSessionRow, InteractiveSessionTable } from "./database.ts";
import { badRequest } from "./http.ts";
import { normalizeRepo } from "./repositories.ts";
import type { ResolvedGrantPrincipal } from "./session-grant-repository.ts";
import type { InteractiveSession } from "./session-model.ts";

export type GitHubActionsSessionRegistrationInput = {
  workKey?: string;
  workKind?: string;
  repo?: string;
  branch?: string;
  sourceUrl?: string;
  runUrl?: string;
  owner?: string;
  purpose?: string;
  summary?: string;
};

export type GitHubActionsSessionRegistrationUpdate = {
  owner: string;
  owner_subject: string;
  repo: string;
  branch: string;
  purpose: string;
  summary: string;
  prompt: string;
  status: "ready";
  lease_id: null;
  stopped_at: null;
  terminal_status: null;
  terminal_failure_reason: null;
  terminal_finalize_pending: 0;
  credential_cleanup_terminal_status: null;
  updated_at: number;
  last_seen_at: number;
  last_event: string;
  agent_token_hash: string;
  work_kind: string;
  work_state: "registered";
  work_phase: "waiting_for_runner";
  source_url: string | null;
  github_run_url: string | null;
  last_heartbeat_at: null;
  completion_reason: null;
};

export type GitHubActionsSessionRegistrationExpectation = Pick<
  InteractiveSessionRow,
  "updated_at" | "status" | "work_state" | "work_phase"
>;

export type GitHubActionsSessionRegistrationStore = {
  now(): number;
  newAgentToken(): string;
  hashToken(token: string): Promise<string>;
  requireRepo(repo: string): Promise<void>;
  resolvePrincipal(value: string): Promise<ResolvedGrantPrincipal | null>;
  readByWorkKey(workKey: string): Promise<InteractiveSessionRow | null>;
  nextSessionId(): Promise<string>;
  insertSession(values: Insertable<InteractiveSessionTable>): Promise<void>;
  readById(id: string): Promise<InteractiveSessionRow | null>;
  updateSession(
    id: string,
    values: GitHubActionsSessionRegistrationUpdate,
    expected: GitHubActionsSessionRegistrationExpectation,
  ): Promise<void>;
  isConstraintError(error: unknown): boolean;
  disconnectRunner(id: string): Promise<void>;
  appendEvent(id: string, message: string, now: number): Promise<void>;
  audit(message: string, now: number): Promise<void>;
  readSession(id: string): Promise<InteractiveSession | null>;
};

export type GitHubActionsSessionRegistration = {
  session: InteractiveSession;
  agentToken: string;
  resumed: boolean;
  workKey: string;
};

export class GitHubActionsSessionRegistrationService {
  private readonly store: GitHubActionsSessionRegistrationStore;

  constructor(store: GitHubActionsSessionRegistrationStore) {
    this.store = store;
  }

  async register(
    input: GitHubActionsSessionRegistrationInput,
  ): Promise<GitHubActionsSessionRegistration> {
    const workKey = actionWorkIdentifier(input.workKey, "workKey", 300);
    const workKind = actionWorkIdentifier(input.workKind, "workKind", 80);
    const repo = normalizeRepo(input.repo);
    if (!repo) throw badRequest("repo is required");
    await this.store.requireRepo(repo);

    const requestedOwner = boundedValue(input.owner, 320);
    const resolvedOwner = requestedOwner ? await this.store.resolvePrincipal(requestedOwner) : null;
    if (requestedOwner && !resolvedOwner) {
      throw badRequest("owner must identify one active Crabfleet user");
    }

    const branch = boundedValue(input.branch, 120) || "main";
    const sourceUrl = optionalHttpUrl(input.sourceUrl, "sourceUrl");
    const runUrl = optionalHttpUrl(input.runUrl, "runUrl");
    const agentToken = this.store.newAgentToken();
    const agentTokenHash = await this.store.hashToken(agentToken);
    const now = this.store.now();
    let existing = await this.store.readByWorkKey(workKey);
    if (!resolvedOwner) {
      throw badRequest("owner is required for GitHub Actions work");
    }
    const purpose =
      boundedValue(input.purpose, 500) ||
      existing?.purpose ||
      `${workKind.replaceAll("_", " ")} in ${repo}@${branch}`;
    const summary = boundedValue(input.summary, 500) || existing?.summary || purpose;

    if (!existing) {
      existing = await this.insertOrReadConcurrent({
        workKey,
        workKind,
        repo,
        branch,
        sourceUrl,
        runUrl,
        purpose,
        summary,
        owner: resolvedOwner.actor,
        ownerSubject: resolvedOwner.subject,
        agentTokenHash,
        now,
      });
    }
    if (!existing) throw new Error("failed to register GitHub Actions session");
    if (existing.runtime !== githubActionsRuntime) {
      throw badRequest("workKey is already registered to a different runtime");
    }
    if (resolvedOwner && !existing.owner_subject) {
      throw badRequest("workKey is missing a stable owner; use a new workKey");
    }
    if (
      resolvedOwner &&
      existing.owner_subject &&
      existing.owner_subject !== resolvedOwner.subject
    ) {
      throw badRequest("workKey is already registered to a different owner");
    }
    const owner = resolvedOwner?.actor ?? existing.owner;
    const ownerSubject = resolvedOwner?.subject ?? existing.owner_subject;
    if (!ownerSubject) {
      throw badRequest("workKey is missing a stable owner; use a new workKey");
    }

    const resumed = existing.work_state !== "registered" || existing.status !== "ready";
    const message = resumed ? "GitHub Actions work resumed" : "GitHub Actions work registered";
    await this.store.updateSession(
      existing.id,
      {
        owner,
        owner_subject: ownerSubject,
        repo,
        branch,
        purpose,
        summary,
        prompt: purpose,
        status: "ready",
        lease_id: null,
        stopped_at: null,
        terminal_status: null,
        terminal_failure_reason: null,
        terminal_finalize_pending: 0,
        credential_cleanup_terminal_status: null,
        updated_at: now,
        last_seen_at: now,
        last_event: message,
        agent_token_hash: agentTokenHash,
        work_kind: workKind,
        work_state: "registered",
        work_phase: "waiting_for_runner",
        source_url: input.sourceUrl === undefined ? existing.source_url : sourceUrl,
        github_run_url: input.runUrl === undefined ? existing.github_run_url : runUrl,
        last_heartbeat_at: null,
        completion_reason: null,
      },
      {
        updated_at: existing.updated_at,
        status: existing.status,
        work_state: existing.work_state,
        work_phase: existing.work_phase,
      },
    );
    await this.store.disconnectRunner(existing.id).catch(() => undefined);
    await this.store.appendEvent(existing.id, message, now);
    await this.store.audit(
      `openclaw action session ${resumed ? "resumed" : "registered"} ${existing.id} work=${workKey}`,
      now,
    );
    const session = await this.store.readSession(existing.id);
    if (!session) throw new Error("registered GitHub Actions session is unavailable");
    return { session, agentToken, resumed, workKey };
  }

  private async insertOrReadConcurrent(input: {
    workKey: string;
    workKind: string;
    repo: string;
    branch: string;
    sourceUrl: string | null;
    runUrl: string | null;
    purpose: string;
    summary: string;
    owner: string;
    ownerSubject: string;
    agentTokenHash: string;
    now: number;
  }): Promise<InteractiveSessionRow | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = await this.store.nextSessionId();
      try {
        await this.store.insertSession(buildGitHubActionsSessionValues({ id, ...input }));
        return await this.store.readById(id);
      } catch (error) {
        if (!this.store.isConstraintError(error)) throw error;
        const concurrent = await this.store.readByWorkKey(input.workKey);
        if (concurrent) return concurrent;
        if (attempt === 2) throw error;
      }
    }
    return null;
  }
}

export function buildGitHubActionsSessionValues(input: {
  id: string;
  workKey: string;
  workKind: string;
  repo: string;
  branch: string;
  sourceUrl: string | null;
  runUrl: string | null;
  purpose: string;
  summary: string;
  owner: string;
  ownerSubject: string;
  agentTokenHash: string;
  now: number;
}): Insertable<InteractiveSessionTable> {
  return {
    id: input.id,
    parent_session_id: null,
    root_session_id: input.id,
    repo: input.repo,
    branch: input.branch,
    runtime: githubActionsRuntime,
    adapter: null,
    profile: "github-actions",
    adapter_workspace_id: null,
    adapter_control_plane: null,
    provider_resource_id: null,
    capabilities_json: JSON.stringify(githubActionsCapabilities),
    expires_at: null,
    last_reconciled_at: null,
    reconcile_error: null,
    terminal_status: null,
    adapter_ttl_seconds: null,
    adapter_idle_timeout_seconds: null,
    adapter_requested_capabilities_json: null,
    adapter_create_payload_json: null,
    adapter_create_pending: 0,
    command: "codex",
    prompt: input.purpose,
    purpose: input.purpose,
    summary: input.summary,
    owner: input.owner,
    owner_subject: input.ownerSubject,
    created_by: "service:openclaw",
    status: "ready",
    lease_id: null,
    attach_url: null,
    vnc_url: null,
    last_event: "GitHub Actions work registered",
    created_at: input.now,
    updated_at: input.now,
    last_seen_at: input.now,
    stopped_at: null,
    share_mode: "private",
    share_token_hash: null,
    share_token_preview: null,
    control_requested_by: null,
    control_requested_by_subject: null,
    control_requested_at: null,
    controller: null,
    controller_subject: null,
    control_granted_at: null,
    control_expires_at: null,
    multiplayer_mode: 0,
    agent_token_hash: input.agentTokenHash,
    work_key: input.workKey,
    work_kind: input.workKind,
    work_state: "registered",
    work_phase: "waiting_for_runner",
    source_url: input.sourceUrl,
    github_run_url: input.runUrl,
    codex_thread_id: null,
    codex_turn_id: null,
    last_heartbeat_at: null,
    completion_reason: null,
  };
}

export function actionWorkIdentifier(value: unknown, name: string, maximum: number): string {
  const identifier = String(value ?? "").trim();
  if (!identifier) throw badRequest(`${name} is required`);
  if (identifier.length > maximum) {
    throw badRequest(`${name} exceeds ${maximum} characters`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@+#=-]*$/.test(identifier)) {
    throw badRequest(`${name} contains unsupported characters`);
  }
  return identifier;
}

export function optionalHttpUrl(value: unknown, name: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 1000) throw badRequest(`${name} exceeds 1000 characters`);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw badRequest(`${name} must be an http(s) URL`);
  }
}

function boundedValue(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
