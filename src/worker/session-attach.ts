import { badRequest, conflict, forbidden, notFound } from "./http.ts";
import { deadInteractiveSessionStatuses, type InteractiveSessionStatus } from "./models.ts";
import type { InteractiveSession } from "./session-model.ts";

export type InteractiveSessionAttachTransition = {
  status: InteractiveSessionStatus;
  lastSeenAt: number;
  message: string;
};

export type InteractiveSessionAttachStore = {
  persist(
    session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
    actor: string,
    transition: InteractiveSessionAttachTransition,
    now: number,
  ): Promise<boolean>;
  archive(sessionId: string, now: number): Promise<void>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
};

export class InteractiveSessionAttachService {
  private readonly store: InteractiveSessionAttachStore;

  constructor(store: InteractiveSessionAttachStore) {
    this.store = store;
  }

  async attach(input: {
    session: InteractiveSession;
    actor: string;
    canControl: boolean;
    now: number;
  }): Promise<InteractiveSession> {
    const { actor, canControl, now, session } = input;
    if (!session.capabilities.terminal) {
      throw badRequest("session does not advertise terminal access");
    }
    if (!canControl) throw forbidden("terminal control has not been granted");
    if (session.status === "stopping" || deadInteractiveSessionStatuses.includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }

    const transition = interactiveSessionAttachTransition(session, now);
    if (!(await this.store.persist(session, actor, transition, now))) {
      throw conflict("interactive session lifecycle changed; retry attach");
    }
    await this.store.archive(session.id, now).catch(() => undefined);
    const current = await this.store.readSession(session.id);
    if (!current) throw notFound("interactive session not found");
    return current;
  }
}

export function interactiveSessionAttachTransition(
  session: Pick<InteractiveSession, "status">,
  now: number,
): InteractiveSessionAttachTransition {
  return {
    status:
      session.status === "ready" || session.status === "detached" ? "attached" : session.status,
    lastSeenAt: now,
    message:
      session.status === "pending_adapter"
        ? "attach requested; runtime adapter pending"
        : session.status === "provisioning"
          ? "attach requested; workspace provisioning"
          : "interactive terminal attached",
  };
}
