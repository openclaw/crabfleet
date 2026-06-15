import { conflict, notFound, serviceUnavailable } from "./http.ts";
import { deadInteractiveSessionStatuses } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export type RuntimeAdapterWorkspaceStopResult = {
  status: "stopping" | "stopped";
  message: string;
};

export type RuntimeAdapterStopServiceResult = {
  session: InteractiveSession;
  auditAt: number | null;
};

export type RuntimeAdapterStopStore = {
  claimStop(session: InteractiveSession, actor: string, now: number): Promise<boolean>;
  archive(sessionId: string, now: number): Promise<void>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  stopWorkspace(
    sessionId: string,
    adapterWorkspaceId: string,
  ): Promise<RuntimeAdapterWorkspaceStopResult>;
  providerError(error: unknown, adapterWorkspaceId: string): string;
  persistEvidence(
    sessionId: string,
    adapterWorkspaceId: string,
    message: string,
    now: number,
    reconcileError: string | null,
    actor: string,
  ): Promise<void>;
  readCreatePending(sessionId: string, adapterWorkspaceId: string): Promise<boolean>;
  confirmRelease(
    sessionId: string,
    adapterWorkspaceId: string,
    now: number,
    message: string,
  ): Promise<"stopping" | "stopped" | "failed" | null>;
  now(): number;
};

export class RuntimeAdapterStopService {
  private readonly store: RuntimeAdapterStopStore;
  private readonly adapterName: string;

  constructor(store: RuntimeAdapterStopStore, adapterName: string) {
    this.store = store;
    this.adapterName = adapterName;
  }

  async stop(input: {
    session: InteractiveSession;
    actor: string;
    now: number;
  }): Promise<RuntimeAdapterStopServiceResult> {
    const { actor, now, session } = input;
    const adapterWorkspaceId = session.adapterWorkspaceId;
    if (!adapterWorkspaceId) {
      throw serviceUnavailable("runtime adapter workspace reference is incomplete");
    }

    if (!(await this.store.claimStop(session, actor, now))) {
      const current = await this.store.readSession(session.id);
      if (
        !current ||
        current.adapter !== this.adapterName ||
        current.adapterWorkspaceId !== adapterWorkspaceId ||
        (current.status !== "stopping" && !deadInteractiveSessionStatuses.includes(current.status))
      ) {
        throw conflict("interactive session lifecycle changed; retry stop");
      }
      return { session: current, auditAt: null };
    }
    await this.store.archive(session.id, now).catch(() => undefined);

    let stop: RuntimeAdapterWorkspaceStopResult;
    try {
      stop = await this.store.stopWorkspace(session.id, adapterWorkspaceId);
    } catch (error) {
      const message = this.store.providerError(error, adapterWorkspaceId);
      await this.store.persistEvidence(
        session.id,
        adapterWorkspaceId,
        `runtime adapter stop pending: ${message}`,
        now,
        message,
        actor,
      );
      throw serviceUnavailable(`runtime adapter stop failed: ${message}`);
    }

    if (stop.status === "stopping") {
      const createPending = await this.store.readCreatePending(session.id, adapterWorkspaceId);
      await this.store.persistEvidence(
        session.id,
        adapterWorkspaceId,
        createPending
          ? `${stop.message}; runtime adapter stop waiting for create resolution`
          : stop.message,
        now,
        null,
        actor,
      );
      return { session: await this.readSession(session.id), auditAt: null };
    }

    const resolvedAt = this.store.now();
    const resolved = await this.store.confirmRelease(
      session.id,
      adapterWorkspaceId,
      resolvedAt,
      stop.message,
    );
    return {
      session: await this.readSession(session.id),
      auditAt: resolved === "failed" || resolved === "stopped" ? this.store.now() : null,
    };
  }

  private async readSession(sessionId: string): Promise<InteractiveSession> {
    const session = await this.store.readSession(sessionId);
    if (!session) throw notFound("interactive session not found");
    return session;
  }
}
