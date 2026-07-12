import {
  gitHubActionsSessionStatus,
  gitHubActionsWorkEvent,
  githubActionsRuntime,
  isTerminalGitHubActionsWorkState,
  parseGitHubActionsWorkState,
  type GitHubActionsWorkState,
} from "../github-actions-runtime.ts";
import type { InteractiveSessionRow } from "./database.ts";
import { badRequest, notFound } from "./http.ts";
import type { InteractiveSessionStatus } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export type GitHubActionsWorkStateInput = {
  state?: string;
  phase?: string;
  summary?: string;
  codexThreadId?: string | null;
  codexTurnId?: string | null;
  completionReason?: string | null;
};

export type GitHubActionsWorkStateUpdate = {
  status: InteractiveSessionStatus;
  summary: string;
  work_state: GitHubActionsWorkState;
  work_phase: string;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  last_heartbeat_at: number;
  completion_reason: string | null;
  last_event: string;
  last_seen_at: number;
  updated_at: number;
  stopped_at: number | null;
};

export type GitHubActionsWorkStateStore = {
  now(): number;
  readRow(id: string): Promise<InteractiveSessionRow | null>;
  persist(
    id: string,
    values: GitHubActionsWorkStateUpdate,
    expectedTerminalStatus?: InteractiveSessionStatus,
  ): Promise<void>;
  appendEvent(id: string, message: string, now: number): Promise<void>;
  disconnectRunner(id: string): Promise<void>;
  readSession(id: string): Promise<InteractiveSession | null>;
};

export class GitHubActionsWorkStateService {
  private readonly store: GitHubActionsWorkStateStore;

  constructor(store: GitHubActionsWorkStateStore) {
    this.store = store;
  }

  async update(
    session: InteractiveSession,
    input: GitHubActionsWorkStateInput,
  ): Promise<InteractiveSession> {
    if (session.runtime !== githubActionsRuntime || !session.workKey) {
      throw badRequest("session is not a GitHub Actions work session");
    }
    const state = parseGitHubActionsWorkState(input.state);
    if (!state) throw badRequest("invalid work state");

    const row = await this.store.readRow(session.id);
    if (!row) throw notFound("interactive session not found");
    const phase = input.phase === undefined ? row.work_phase : boundedValue(input.phase, 160);
    const summary = input.summary === undefined ? row.summary : boundedValue(input.summary, 500);
    const codexThreadId =
      input.codexThreadId === undefined
        ? row.codex_thread_id
        : boundedValue(input.codexThreadId, 240) || null;
    const codexTurnId =
      input.codexTurnId === undefined
        ? row.codex_turn_id
        : boundedValue(input.codexTurnId, 240) || null;
    const terminal = isTerminalGitHubActionsWorkState(state);
    const completionReason =
      input.completionReason === undefined
        ? terminal
          ? row.completion_reason
          : null
        : boundedValue(input.completionReason, 500) || null;
    const status = terminal ? gitHubActionsSessionStatus(state) : activeSessionStatus(row.status);
    const lastEvent = gitHubActionsWorkEvent(state, phase);
    const changed =
      row.work_state !== state ||
      row.work_phase !== phase ||
      row.summary !== summary ||
      row.codex_thread_id !== codexThreadId ||
      row.codex_turn_id !== codexTurnId ||
      row.completion_reason !== completionReason;
    const now = this.store.now();

    await this.store.persist(
      session.id,
      {
        status,
        summary,
        work_state: state,
        work_phase: phase,
        codex_thread_id: codexThreadId,
        codex_turn_id: codexTurnId,
        last_heartbeat_at: now,
        completion_reason: completionReason,
        last_event: lastEvent,
        last_seen_at: now,
        updated_at: now,
        stopped_at: terminal ? now : null,
      },
      terminal ? row.status : undefined,
    );
    if (changed) {
      await this.store.appendEvent(session.id, lastEvent, now);
    }
    if (terminal) {
      await this.store.disconnectRunner(session.id).catch(() => undefined);
    }
    const current = await this.store.readSession(session.id);
    if (!current) throw notFound("interactive session not found");
    return current;
  }
}

function activeSessionStatus(status: InteractiveSessionStatus): InteractiveSessionStatus {
  return status === "ready" || status === "attached" || status === "detached" ? status : "ready";
}

function boundedValue(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
