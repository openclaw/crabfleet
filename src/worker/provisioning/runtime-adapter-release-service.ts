import type { RuntimeAdapterWorkspaceStopResult } from "../session-runtime-adapter-stop.ts";

export type RuntimeAdapterWorkspaceRegistration = {
  profile: string;
  controlPlane: string;
};

export type RuntimeAdapterReleaseServiceDependencies = {
  clearCreatePending(sessionId: string, adapterWorkspaceId: string): Promise<void>;
  stopWorkspace(
    sessionId: string,
    adapterWorkspaceId: string,
    registration: RuntimeAdapterWorkspaceRegistration | null,
    createPending: boolean,
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
    const { sessionId, adapterWorkspaceId, registration, createPending, now } = input;
    if (!createPending) {
      await this.dependencies.clearCreatePending(sessionId, adapterWorkspaceId);
    }
    try {
      const release = await this.dependencies.stopWorkspace(
        sessionId,
        adapterWorkspaceId,
        registration,
        createPending,
      );
      if (release.status === "stopped") {
        await this.dependencies.confirmRelease(sessionId, adapterWorkspaceId, now, release.message);
        return;
      }
      await this.dependencies.persistStopEvidence(
        sessionId,
        adapterWorkspaceId,
        release.message,
        now,
        null,
      );
    } catch (error) {
      const message = this.dependencies.providerError(error, adapterWorkspaceId);
      await this.dependencies.persistStopEvidence(
        sessionId,
        adapterWorkspaceId,
        `superseded runtime adapter stop pending: ${message}`,
        now,
        message,
      );
    }
  }
}
