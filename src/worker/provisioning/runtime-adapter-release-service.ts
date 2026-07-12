import type { RuntimeAdapterWorkspaceStopResult } from "../session-runtime-adapter-stop.ts";

export type RuntimeAdapterWorkspaceRegistration = {
  profile: string;
  controlPlane: string;
};

export type RuntimeAdapterWorkspaceCleanup = {
  sessionId: string;
  adapterWorkspaceId: string;
  registration: RuntimeAdapterWorkspaceRegistration | null;
  createPending: boolean;
  deletionObserved: boolean;
  claim: string;
};

export type RuntimeAdapterReleaseServiceDependencies = {
  stageCleanup(input: {
    sessionId: string;
    adapterWorkspaceId: string;
    registration: RuntimeAdapterWorkspaceRegistration | null;
    createPending: boolean;
    now: number;
  }): Promise<void>;
  claimCleanup(
    sessionId: string,
    adapterWorkspaceId: string,
    now: number,
  ): Promise<RuntimeAdapterWorkspaceCleanup | null>;
  claimPendingCleanups(now: number): Promise<RuntimeAdapterWorkspaceCleanup[]>;
  persistCleanupEvidence(
    cleanup: RuntimeAdapterWorkspaceCleanup,
    message: string,
    now: number,
    reconcileError: string | null,
  ): Promise<void>;
  markCleanupDeletionObserved(cleanup: RuntimeAdapterWorkspaceCleanup, now: number): Promise<void>;
  completeCleanup(cleanup: RuntimeAdapterWorkspaceCleanup): Promise<void>;
  clearCreatePending(sessionId: string, adapterWorkspaceId: string): Promise<void>;
  stopWorkspace(
    sessionId: string,
    adapterWorkspaceId: string,
    registration: RuntimeAdapterWorkspaceRegistration | null,
    retryMissing: boolean,
  ): Promise<RuntimeAdapterWorkspaceStopResult>;
  confirmRelease(
    sessionId: string,
    adapterWorkspaceId: string,
    now: number,
    message: string,
  ): Promise<"stopping" | "stopped" | "failed" | null>;
  persistStopEvidence(
    sessionId: string,
    adapterWorkspaceId: string,
    message: string,
    now: number,
    reconcileError?: string | null,
  ): Promise<void>;
  providerError(error: unknown, adapterWorkspaceId: string): string;
};

export class RuntimeAdapterReleaseService {
  private readonly dependencies: RuntimeAdapterReleaseServiceDependencies;

  constructor(dependencies: RuntimeAdapterReleaseServiceDependencies) {
    this.dependencies = dependencies;
  }

  async stopSuperseded(input: {
    sessionId: string;
    adapterWorkspaceId: string;
    registration: RuntimeAdapterWorkspaceRegistration | null;
    createPending: boolean;
    now: number;
  }): Promise<void> {
    await this.dependencies.stageCleanup(input);
    const cleanup = await this.dependencies.claimCleanup(
      input.sessionId,
      input.adapterWorkspaceId,
      input.now,
    );
    if (!cleanup) return;
    await this.releaseCleanup(cleanup, input.now);
  }

  async retryPending(now: number): Promise<void> {
    const cleanups = await this.dependencies.claimPendingCleanups(now);
    for (const cleanup of cleanups) {
      await this.releaseCleanup(cleanup, now);
    }
  }

  private async releaseCleanup(
    cleanup: RuntimeAdapterWorkspaceCleanup,
    now: number,
  ): Promise<void> {
    const { sessionId, adapterWorkspaceId, registration, createPending, deletionObserved } =
      cleanup;
    try {
      if (!createPending) {
        await this.dependencies.clearCreatePending(sessionId, adapterWorkspaceId);
      }
      const release = await this.dependencies.stopWorkspace(
        sessionId,
        adapterWorkspaceId,
        registration,
        createPending && !deletionObserved,
      );
      if (release.status === "stopped") {
        await this.dependencies.markCleanupDeletionObserved(cleanup, now);
        await this.dependencies.confirmRelease(sessionId, adapterWorkspaceId, now, release.message);
        await this.dependencies.completeCleanup(cleanup);
        return;
      }
      await this.persistEvidence(cleanup, release.message, now, null);
    } catch (error) {
      const message = this.dependencies.providerError(error, adapterWorkspaceId);
      await this.persistEvidence(
        cleanup,
        `superseded runtime adapter stop pending: ${message}`,
        now,
        message,
      );
    }
  }

  private async persistEvidence(
    cleanup: RuntimeAdapterWorkspaceCleanup,
    message: string,
    now: number,
    reconcileError: string | null,
  ): Promise<void> {
    await this.dependencies.persistCleanupEvidence(cleanup, message, now, reconcileError);
    await this.dependencies
      .persistStopEvidence(
        cleanup.sessionId,
        cleanup.adapterWorkspaceId,
        message,
        now,
        reconcileError,
      )
      .catch(() => undefined);
  }
}
