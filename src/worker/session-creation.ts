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
}
