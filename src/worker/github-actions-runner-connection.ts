import { githubActionsRuntime, type GitHubActionsWorkState } from "../github-actions-runtime.ts";
import { badRequest } from "./http.ts";
import type { InteractiveSessionStatus } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export const githubActionsRunnerConnectedEvent = "GitHub Actions runner connected";

export type GitHubActionsRunnerConnectionUpdate = {
  status: InteractiveSessionStatus;
  work_state: GitHubActionsWorkState;
  work_phase: string;
  last_heartbeat_at: number;
  last_seen_at: number;
  updated_at: number;
  last_event: typeof githubActionsRunnerConnectedEvent;
};

export type GitHubActionsRunnerConnectionStore = {
  now(): number;
  persist(
    id: string,
    values: GitHubActionsRunnerConnectionUpdate,
    expectedRevision: number,
  ): Promise<void>;
  appendEvent(id: string, message: string, now: number): Promise<void>;
};

export class GitHubActionsRunnerConnectionService {
  private readonly store: GitHubActionsRunnerConnectionStore;

  constructor(store: GitHubActionsRunnerConnectionStore) {
    this.store = store;
  }

  async connect(session: InteractiveSession): Promise<void> {
    if (session.runtime !== githubActionsRuntime || !session.workKey) {
      throw badRequest("session is not a GitHub Actions work session");
    }
    const now = this.store.now();
    const state =
      session.workState === "registered" || !session.workState ? "running" : session.workState;
    const phase =
      !session.workPhase || session.workPhase === "waiting_for_runner"
        ? "runner_connected"
        : session.workPhase;
    const status =
      session.status === "attached" || session.status === "detached" ? session.status : "ready";
    await this.store.persist(
      session.id,
      {
        status,
        work_state: state,
        work_phase: phase,
        last_heartbeat_at: now,
        last_seen_at: now,
        updated_at: now,
        last_event: githubActionsRunnerConnectedEvent,
      },
      session.updatedAt,
    );
    await this.store.appendEvent(session.id, githubActionsRunnerConnectedEvent, now);
  }
}
