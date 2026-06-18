import type { InteractiveSession } from "./session-model.ts";

export type GitHubActionsSessionStopStore = {
  persist(session: InteractiveSession, actor: string, now: number): Promise<boolean>;
  disconnect(sessionId: string): Promise<void>;
  archive(sessionId: string, now: number): Promise<void>;
  finalize(sessionId: string, now: number): Promise<void>;
};

export class GitHubActionsSessionStopService {
  private readonly store: GitHubActionsSessionStopStore;

  constructor(store: GitHubActionsSessionStopStore) {
    this.store = store;
  }

  async stop(session: InteractiveSession, actor: string, now: number): Promise<boolean> {
    if (!(await this.store.persist(session, actor, now))) return false;
    await this.store.disconnect(session.id).catch(() => undefined);
    await this.store.archive(session.id, now).catch(() => undefined);
    await this.store.finalize(session.id, now).catch(() => undefined);
    return true;
  }
}
