import type { InteractiveSession } from "./session-model.ts";
import type {
  InteractiveProvisionPersistence,
  InteractiveProvisionPersistenceInput,
  InteractiveProvisionResult,
} from "./session-provisioning.ts";

export type InteractiveSessionCreationReservation = {
  id: string;
  insertedAt: number;
  supervisedRootSessionId: string | null;
  requiresActivation: boolean;
  adapterWorkspaceId: string | null;
};

export type InteractiveSessionCreationStore = {
  enforceSupervision(
    rootSessionId: string,
    insertedSessionId: string,
    insertedAt: number,
  ): Promise<void>;
  rollbackReservation(insertedSessionId: string, insertedAt: number): Promise<void>;
  activateReservation(
    insertedSessionId: string,
    insertedAt: number,
    adapterWorkspaceId: string | null,
  ): Promise<void>;
  recordRequest(insertedSessionId: string, insertedAt: number): Promise<void>;
  isConstraintError(error: unknown): boolean;
  readRequestReplay(requestId: string, requestHash: string): Promise<InteractiveSession | null>;
  persistProvisionResult(
    input: InteractiveProvisionPersistenceInput,
    result: InteractiveProvisionResult,
  ): Promise<InteractiveProvisionPersistence>;
  markPendingAdapter(
    input: Pick<
      InteractiveProvisionPersistenceInput,
      "sessionId" | "insertedAt" | "initialLeaseId" | "initialAgentTokenHash"
    >,
  ): Promise<void>;
  recordProvisionEvent(sessionId: string, message: string, now: number): Promise<void>;
  finalizeTerminal(
    sessionId: string,
    status: "stopped" | "expired" | "failed",
    now: number,
  ): Promise<void>;
};

export class InteractiveSessionCreationService {
  private readonly store: InteractiveSessionCreationStore;

  constructor(store: InteractiveSessionCreationStore) {
    this.store = store;
  }

  async provision<T>(
    reservation: InteractiveSessionCreationReservation,
    prepare: (() => Promise<void>) | undefined,
    provision: () => Promise<T>,
  ): Promise<T> {
    if (reservation.supervisedRootSessionId) {
      await this.store.enforceSupervision(
        reservation.supervisedRootSessionId,
        reservation.id,
        reservation.insertedAt,
      );
    }
    try {
      await prepare?.();
    } catch (error) {
      await this.store.rollbackReservation(reservation.id, reservation.insertedAt);
      throw error;
    }
    if (reservation.requiresActivation) {
      await this.store.activateReservation(
        reservation.id,
        reservation.insertedAt,
        reservation.adapterWorkspaceId,
      );
    }
    await this.store.recordRequest(reservation.id, reservation.insertedAt);
    return provision();
  }

  async recoverReservationFailure(
    error: unknown,
    context: {
      reservationInserted: boolean;
      attempt: number;
      maximumAttempts: number;
      requestId: string | null;
      requestHash: string | null;
    },
  ): Promise<InteractiveSession | null> {
    const constraintError = this.store.isConstraintError(error);
    if (
      !context.reservationInserted &&
      constraintError &&
      context.requestId &&
      context.requestHash
    ) {
      const existing = await this.store.readRequestReplay(context.requestId, context.requestHash);
      if (existing) return existing;
    }
    if (
      context.reservationInserted ||
      !constraintError ||
      context.attempt === context.maximumAttempts - 1
    ) {
      throw error;
    }
    return null;
  }

  async completeProvision(
    input: InteractiveProvisionPersistenceInput,
    result: InteractiveProvisionResult | null,
  ): Promise<InteractiveProvisionPersistence> {
    if (!result) {
      await this.store.markPendingAdapter(input);
      await this.store.recordProvisionEvent(
        input.sessionId,
        "waiting for interactive runtime adapter",
        input.insertedAt + 1,
      );
      return {
        updated: true,
        terminalStatus: null,
        terminalAt: input.insertedAt + 1,
      };
    }

    const persisted = await this.store.persistProvisionResult(input, result);
    if (!persisted.updated) return persisted;
    await this.store.recordProvisionEvent(input.sessionId, result.message, input.insertedAt + 1);
    if (persisted.terminalStatus) {
      await this.store
        .finalizeTerminal(input.sessionId, persisted.terminalStatus, persisted.terminalAt)
        .catch(() => undefined);
    }
    return persisted;
  }
}
