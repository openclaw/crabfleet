import { conflict, forbidden, notFound } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import type { RuntimeAdapterStopServiceResult } from "./session-runtime-adapter-stop.ts";
import type { InteractiveSession } from "./session-model.ts";

export type InteractiveSessionTerminalStatus = "stopped" | "expired" | "failed";

export type InteractiveSessionStopStore = {
  isSandbox(session: InteractiveSession): boolean;
  stageTerminalCleanup(
    sessionId: string,
    status: InteractiveSessionTerminalStatus,
    message: string,
    now: number,
  ): Promise<boolean>;
  reconcileCleanup(sessionId: string, now: number): Promise<void>;
  readTerminalCleanupIntent(sessionId: string): Promise<boolean>;
  recordEvent(sessionId: string, message: string, now: number): Promise<void>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  finalizeTerminal(
    sessionId: string,
    status: InteractiveSessionTerminalStatus,
    now: number,
  ): Promise<void>;
  stopGitHubActions(session: InteractiveSession, actor: string, now: number): Promise<boolean>;
  stopRuntimeAdapter(
    session: InteractiveSession,
    actor: string,
    now: number,
  ): Promise<RuntimeAdapterStopServiceResult>;
  stopLegacy(session: InteractiveSession, actor: string, now: number): Promise<boolean>;
  audit(message: string, now: number): Promise<void>;
};

export class InteractiveSessionStopService {
  private readonly store: InteractiveSessionStopStore;
  private readonly runtimeAdapterName: string;

  constructor(store: InteractiveSessionStopStore, runtimeAdapterName: string) {
    this.store = store;
    this.runtimeAdapterName = runtimeAdapterName;
  }

  async stop(input: {
    session: InteractiveSession;
    actor: string;
    canManage: boolean;
    now: number;
  }): Promise<InteractiveSession> {
    const { actor, canManage, now, session } = input;
    if (!canManage) throw forbidden("only the session owner or maintainer can stop");

    const terminalStatus = interactiveSessionTerminalStatus(session);
    if (terminalStatus) {
      if (this.store.isSandbox(session)) {
        const staged = await this.store.stageTerminalCleanup(
          session.id,
          terminalStatus,
          "sandbox credential cleanup pending",
          now,
        );
        if (!staged) throw conflict("interactive session lifecycle changed; retry stop");
        await this.store.reconcileCleanup(session.id, now);
        const current = await this.store.readSession(session.id);
        if (current) return current;
      }
      await this.store
        .finalizeTerminal(session.id, terminalStatus, session.stoppedAt ?? now)
        .catch(() => undefined);
      return session;
    }

    if (session.runtime === "github_actions") {
      if (!(await this.store.stopGitHubActions(session, actor, now))) {
        const current = await this.readSession(session.id);
        if (!deadInteractiveSessionStatuses.includes(current.status)) {
          throw conflict("interactive session lifecycle changed; retry stop");
        }
        return current;
      }
      await this.store.audit(`GitHub Actions session stopped ${session.id}`, now);
      return this.readSession(session.id);
    }

    if (session.adapter === this.runtimeAdapterName) {
      const result = await this.store.stopRuntimeAdapter(session, actor, now);
      if (result.auditAt !== null) {
        await this.store.audit(`interactive session stopped ${session.id}`, result.auditAt);
      }
      return result.session;
    }

    if (this.store.isSandbox(session)) {
      return this.stopSandbox(session, now);
    }

    if (!(await this.store.stopLegacy(session, actor, now))) {
      const current = await this.readSession(session.id);
      if (!deadInteractiveSessionStatuses.includes(current.status)) {
        throw conflict("interactive session lifecycle changed; retry stop");
      }
      return current;
    }
    await this.store.audit(`interactive session stopped ${session.id}`, now);
    return this.readSession(session.id);
  }

  private async stopSandbox(session: InteractiveSession, now: number): Promise<InteractiveSession> {
    const staged = await this.store.stageTerminalCleanup(
      session.id,
      "stopped",
      "interactive workspace stop waiting for credential cleanup",
      now,
    );
    if (!staged) {
      const current = await this.readSession(session.id);
      if (await this.store.readTerminalCleanupIntent(session.id)) return current;
      if (deadInteractiveSessionStatuses.includes(current.status)) return current;
      throw conflict("interactive session lifecycle changed; retry stop");
    }
    await this.store.recordEvent(session.id, "interactive workspace stop requested", now);
    await this.store.reconcileCleanup(session.id, now);
    return this.readSession(session.id);
  }

  private async readSession(sessionId: string): Promise<InteractiveSession> {
    const session = await this.store.readSession(sessionId);
    if (!session) throw notFound("interactive session not found");
    return session;
  }
}

export function interactiveSessionTerminalStatus(
  session: Pick<InteractiveSession, "status">,
): InteractiveSessionTerminalStatus | null {
  return deadInteractiveSessionStatuses.includes(session.status)
    ? (session.status as InteractiveSessionTerminalStatus)
    : null;
}
