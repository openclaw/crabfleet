import {
  openClawRoomMaxSessions,
  openClawRoomRootAllowed,
  openClawRoomSessionChainAllowed,
} from "../openclaw-service.ts";
import { badRequest, conflict, notFound, serviceUnavailable, tooManyRequests } from "./http.ts";
import type { InteractiveSession } from "./session-model.ts";

export type OpenClawSupervisionStore = {
  readSession(id: string): Promise<InteractiveSession | null>;
  refreshSession(id: string): Promise<InteractiveSession | null>;
  readLineageSession(id: string, preparationPending: 0 | 1): Promise<InteractiveSession | null>;
  rootAdmissionOpen(rootSessionId: string): Promise<boolean>;
  roomReservationPosition(
    rootSessionId: string,
    insertedSessionId: string,
    insertedAt: number,
  ): Promise<number>;
  removeReservation(insertedSessionId: string, insertedAt: number): Promise<boolean>;
  activateReservation(
    insertedSessionId: string,
    insertedAt: number,
    adapterWorkspaceId: string | null,
  ): Promise<boolean>;
};

export class OpenClawSupervisionService {
  private readonly store: OpenClawSupervisionStore;
  private readonly maximumSessions: number;

  constructor(store: OpenClawSupervisionStore, maximumSessions = openClawRoomMaxSessions) {
    this.store = store;
    this.maximumSessions = maximumSessions;
  }

  async requireRootScopedSession(
    sessionId: string,
    rootSessionId: string,
  ): Promise<InteractiveSession> {
    const session = await this.store.readSession(sessionId);
    const root = await this.store.readSession(rootSessionId);
    const chain =
      session && root
        ? await this.readSessionChain(session, root, rootSessionId, (id) =>
            this.store.readSession(id),
          )
        : [];
    if (!session || !root || !openClawRoomSessionChainAllowed(chain, session.id, rootSessionId)) {
      throw notFound("interactive session not found");
    }
    const refreshed = await this.store.refreshSession(sessionId);
    if (!refreshed) throw notFound("interactive session not found");
    return refreshed;
  }

  async supervisedRootForCreate(
    createdBy: string,
    lineage: { parentSessionId: string | null; rootSessionId: string | null },
  ): Promise<string | null> {
    if (!lineage.parentSessionId || !lineage.rootSessionId) return null;
    const [parent, root] = await Promise.all([
      this.store.readSession(lineage.parentSessionId),
      this.store.readSession(lineage.rootSessionId),
    ]);
    if (!parent || !root) throw badRequest("session lineage not found");
    if (createdBy === "service:openclaw" || createdBy === `session:${lineage.parentSessionId}`) {
      const chain = await this.readSessionChain(parent, root, lineage.rootSessionId, (id) =>
        this.store.readSession(id),
      );
      if (openClawRoomSessionChainAllowed(chain, parent.id, lineage.rootSessionId)) {
        if (!(await this.store.rootAdmissionOpen(lineage.rootSessionId))) {
          throw conflict("OpenClaw room root is stopping");
        }
        return lineage.rootSessionId;
      }
    }
    if (createdBy === "service:openclaw" || openClawRoomRootAllowed(root)) {
      throw badRequest("invalid OpenClaw room lineage");
    }
    return null;
  }

  async enforceRoomSessionLimitAfterInsert(
    rootSessionId: string,
    insertedSessionId: string,
    insertedAt: number,
  ): Promise<void> {
    if (!(await this.roomReservationLineageAllowed(insertedSessionId, rootSessionId))) {
      await this.rollbackReservation(insertedSessionId, insertedAt);
      throw badRequest("invalid OpenClaw room lineage");
    }
    const position = await this.store.roomReservationPosition(
      rootSessionId,
      insertedSessionId,
      insertedAt,
    );
    if (position > 0 && position <= this.maximumSessions) return;
    await this.rollbackReservation(insertedSessionId, insertedAt);
    if (!position) {
      if (!(await this.store.rootAdmissionOpen(rootSessionId))) {
        throw conflict("OpenClaw room root is stopping");
      }
      throw serviceUnavailable("session root reservation disappeared");
    }
    throw tooManyRequests("session root reached the supervision limit");
  }

  async rollbackReservation(insertedSessionId: string, insertedAt: number): Promise<void> {
    if (await this.store.removeReservation(insertedSessionId, insertedAt)) return;
    throw serviceUnavailable("interactive session reservation rollback failed");
  }

  async requireReservationActivation(
    insertedSessionId: string,
    insertedAt: number,
    adapterWorkspaceId: string | null,
  ): Promise<void> {
    if (await this.store.activateReservation(insertedSessionId, insertedAt, adapterWorkspaceId)) {
      return;
    }
    await this.rollbackReservation(insertedSessionId, insertedAt);
    throw serviceUnavailable("interactive session reservation activation failed");
  }

  private async roomReservationLineageAllowed(
    insertedSessionId: string,
    rootSessionId: string,
  ): Promise<boolean> {
    const [session, root] = await Promise.all([
      this.store.readLineageSession(insertedSessionId, 1),
      this.store.readLineageSession(rootSessionId, 0),
    ]);
    if (!session || !root) return false;
    const chain = await this.readSessionChain(session, root, rootSessionId, (id) =>
      this.store.readLineageSession(id, 0),
    );
    return openClawRoomSessionChainAllowed(chain, session.id, rootSessionId);
  }

  private async readSessionChain(
    session: InteractiveSession,
    root: InteractiveSession,
    rootSessionId: string,
    readParent: (id: string) => Promise<InteractiveSession | null>,
  ): Promise<InteractiveSession[]> {
    const chain = new Map<string, InteractiveSession>([[root.id, root]]);
    let current = session;
    for (let depth = 0; depth < this.maximumSessions && !chain.has(current.id); depth += 1) {
      chain.set(current.id, current);
      if (current.id === rootSessionId || !current.parentSessionId) break;
      if (chain.has(current.parentSessionId)) break;
      const parent = await readParent(current.parentSessionId);
      if (!parent) break;
      current = parent;
    }
    return [...chain.values()];
  }
}
