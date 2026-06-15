import {
  adapterFailureReleaseState,
  adapterWorkspaceIdMatches,
  definitiveRuntimeAdapterCreateFailure,
  effectiveAdapterCapabilities,
  namespacedAdapterWorkspaceId,
  normalizeAdapterNamespace,
  normalizeAdapterWorkspaceId,
  parseAdapterWorkspaceResult,
  redactedAdapterMessage,
  redactedAdapterResponseMessage,
  runtimeAdapterCollectionUrl,
  runtimeAdapterCreatePayload,
  runtimeAdapterName,
  runtimeAdapterWorkspaceIdConflict,
  validatedRuntimeAdapterCreatePayloadJson,
  type AdapterWorkspaceResult,
} from "../../runtime-adapter.ts";
import { conflict } from "../http.ts";
import type { InteractiveSessionStatus } from "../models.ts";
import {
  containerCapabilities,
  crabboxCapabilities,
  runtimeCapabilities,
  type RuntimeCapabilities,
} from "../session-model.ts";
import type { RuntimeAdapterWorkspaceStopResult } from "../session-runtime-adapter-stop.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export type RuntimeAdapterCreateAttemptFence = {
  status: InteractiveSessionStatus;
  updatedAt: number;
  lastReconciledAt: number | null;
  terminalStatus: "failed" | null;
};

export type RuntimeAdapterProvisionStageInput = {
  session: Pick<InteractiveProvisionRequest, "id" | "profile">;
  now: number;
  adapterControlPlane: string;
  adapterWorkspaceId: string;
  capabilities: RuntimeCapabilities;
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  createPayloadJson: string;
  reconciliationOwner?: RuntimeAdapterCreateAttemptFence;
};

export type RuntimeAdapterWorkspaceConflictInput = {
  session: Pick<InteractiveProvisionRequest, "id" | "profile">;
  now: number;
  adapterControlPlane: string;
  adapterWorkspaceId: string;
  createPayloadJson: string;
  capabilities: RuntimeCapabilities;
  createAttempt: RuntimeAdapterCreateAttemptFence;
  message: string;
};

export type RuntimeAdapterCreateTransportInput = {
  url: string;
  adapterWorkspaceId: string;
  createPayloadJson: string;
};

export type RuntimeAdapterCreateTransportResult = {
  ok: boolean;
  status: number;
  body: unknown;
};

export type RuntimeAdapterProvisioningDependencies = {
  namespace: string;
  now(): number;
  resolveControlPlane(profile: string, registeredControlPlane: string | null | undefined): string;
  stageProvision(
    input: RuntimeAdapterProvisionStageInput,
  ): Promise<RuntimeAdapterCreateAttemptFence | null>;
  createWorkspace(
    input: RuntimeAdapterCreateTransportInput,
  ): Promise<RuntimeAdapterCreateTransportResult>;
  failWorkspaceIdConflict(
    input: RuntimeAdapterWorkspaceConflictInput,
  ): Promise<InteractiveProvisionResult | null>;
  stageFailedRelease(
    sessionId: string,
    adapterWorkspaceId: string,
    message: string,
    now: number,
  ): Promise<void>;
  stopWorkspaceForSession(
    sessionId: string,
    adapterWorkspaceId: string,
  ): Promise<RuntimeAdapterWorkspaceStopResult>;
  recordConfirmedRelease(
    sessionId: string,
    adapterWorkspaceId: string,
    now: number,
    message: string,
  ): Promise<void>;
  persistStopEvidence(
    sessionId: string,
    adapterWorkspaceId: string,
    message: string,
    now: number,
  ): Promise<void>;
};

export class RuntimeAdapterProvisioningService {
  private readonly dependencies: RuntimeAdapterProvisioningDependencies;

  constructor(dependencies: RuntimeAdapterProvisioningDependencies) {
    this.dependencies = dependencies;
  }

  async provision(
    session: InteractiveProvisionRequest,
    reconciliationOwner?: RuntimeAdapterCreateAttemptFence,
  ): Promise<InteractiveProvisionResult> {
    const replayingPendingCreate = reconciliationOwner !== undefined;
    const namespace = normalizeAdapterNamespace(this.dependencies.namespace);
    const adapterWorkspaceId = session.adapterWorkspaceId
      ? normalizeAdapterWorkspaceId(session.adapterWorkspaceId) === session.adapterWorkspaceId
        ? session.adapterWorkspaceId
        : null
      : namespace
        ? namespacedAdapterWorkspaceId(namespace, session.id)
        : null;
    if (!adapterWorkspaceId) {
      if (replayingPendingCreate) {
        throw new Error("runtime adapter create replay blocked: persisted workspace id is invalid");
      }
      return failedProvision(
        "runtime adapter provision failed: persisted workspace id or valid namespace is required",
      );
    }

    const fallbackCapabilities =
      session.runtime === "crabbox" ? crabboxCapabilities : containerCapabilities;
    let adapterControlPlane: string;
    try {
      adapterControlPlane = this.dependencies.resolveControlPlane(
        session.profile,
        session.adapterControlPlane,
      );
    } catch (error) {
      return unresolvedRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        fallbackCapabilities,
        clean(error instanceof Error ? error.message : String(error), 240),
        this.dependencies.now(),
      );
    }

    const requestedCapabilities = session.adapterRequestedCapabilities;
    const ttlSeconds = persistedRuntimeAdapterSeconds(session.adapterTtlSeconds);
    const idleTimeoutSeconds = persistedRuntimeAdapterSeconds(session.adapterIdleTimeoutSeconds);
    if (!requestedCapabilities || !ttlSeconds || !idleTimeoutSeconds) {
      if (replayingPendingCreate) {
        return ambiguousRuntimeAdapterProvision(
          session,
          adapterWorkspaceId,
          requestedCapabilities ?? fallbackCapabilities,
          "runtime adapter create replay blocked: persisted create settings are incomplete",
          this.dependencies.now(),
        );
      }
      return this.releaseFailed(
        session.id,
        runtimeAdapterFailureProvision(
          session,
          adapterWorkspaceId,
          requestedCapabilities ?? fallbackCapabilities,
          "runtime adapter provision failed: persisted create settings are incomplete",
          this.dependencies.now(),
        ),
      );
    }

    const generatedPayload = session.adapterCreatePayloadJson
      ? null
      : runtimeAdapterCreatePayload(
          {
            namespace: namespace ?? "",
            id: session.id,
            parentSessionId: session.parentSessionId,
            rootSessionId: session.rootSessionId,
            repo: session.repo,
            branch: session.branch,
            runtime: session.runtime,
            profile: session.profile,
            command: session.command,
            prompt: session.prompt,
            purpose: session.purpose,
            summary: session.summary,
            owner: session.owner,
            createdBy: session.createdBy,
            ttlSeconds,
            idleTimeoutSeconds,
            desktop: requestedCapabilities.desktop,
          },
          adapterWorkspaceId,
        );
    const createPayloadJson = validatedRuntimeAdapterCreatePayloadJson(
      session.adapterCreatePayloadJson ??
        (generatedPayload ? JSON.stringify(generatedPayload) : ""),
      {
        workspaceId: adapterWorkspaceId,
        ttlSeconds,
        idleTimeoutSeconds,
        desktop: requestedCapabilities.desktop,
      },
    );
    if (!createPayloadJson) {
      if (replayingPendingCreate) {
        return ambiguousRuntimeAdapterProvision(
          session,
          adapterWorkspaceId,
          requestedCapabilities,
          "runtime adapter create replay blocked: persisted create payload is invalid",
          this.dependencies.now(),
        );
      }
      return this.releaseFailed(
        session.id,
        runtimeAdapterFailureProvision(
          session,
          adapterWorkspaceId,
          requestedCapabilities,
          "runtime adapter provision failed: persisted create payload is invalid",
          this.dependencies.now(),
        ),
      );
    }

    const createAttempt = await this.dependencies.stageProvision({
      session,
      now: this.dependencies.now(),
      adapterControlPlane,
      adapterWorkspaceId,
      capabilities: requestedCapabilities,
      ttlSeconds,
      idleTimeoutSeconds,
      createPayloadJson,
      ...(reconciliationOwner ? { reconciliationOwner } : {}),
    });
    if (!createAttempt) {
      return unresolvedRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        "runtime adapter control-plane registration changed before create",
        this.dependencies.now(),
      );
    }

    let response: RuntimeAdapterCreateTransportResult;
    try {
      response = await this.dependencies.createWorkspace({
        url: runtimeAdapterCollectionUrl(adapterControlPlane),
        adapterWorkspaceId,
        createPayloadJson,
      });
    } catch (error) {
      return ambiguousRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        `runtime adapter create outcome unknown: ${safeProviderError(error, [adapterWorkspaceId])}`,
        this.dependencies.now(),
      );
    }

    if (!response.ok) {
      const responseMessage = redactedAdapterResponseMessage(
        response.body,
        `HTTP ${response.status}`,
        [adapterWorkspaceId],
      );
      if (runtimeAdapterWorkspaceIdConflict(response.status, response.body)) {
        const conflictResult = await this.dependencies.failWorkspaceIdConflict({
          session,
          now: this.dependencies.now(),
          adapterControlPlane,
          adapterWorkspaceId,
          createPayloadJson,
          capabilities: requestedCapabilities,
          createAttempt,
          message: `runtime adapter provision failed: ${responseMessage}`,
        });
        if (conflictResult) return conflictResult;
        throw conflict("runtime adapter workspace conflict response is stale");
      }
      if (!replayingPendingCreate && definitiveRuntimeAdapterCreateFailure(response.status)) {
        return this.releaseFailed(
          session.id,
          runtimeAdapterFailureProvision(
            session,
            adapterWorkspaceId,
            requestedCapabilities,
            `runtime adapter provision failed: ${responseMessage}`,
            this.dependencies.now(),
          ),
        );
      }
      const messagePrefix = replayingPendingCreate
        ? "runtime adapter create replay pending"
        : "runtime adapter create outcome unknown";
      return ambiguousRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        `${messagePrefix}: ${responseMessage}`,
        this.dependencies.now(),
      );
    }

    const parsed = parseAdapterWorkspaceResult(response.body, {
      workspaceId: adapterWorkspaceId,
      profile: session.profile,
    });
    if (!parsed) {
      return ambiguousRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        "runtime adapter create outcome unknown: invalid workspace response",
        this.dependencies.now(),
      );
    }
    if (!adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
      return ambiguousRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        "runtime adapter create outcome unknown: workspace identity mismatch",
        this.dependencies.now(),
      );
    }
    if (parsed.profile !== session.profile) {
      return ambiguousRuntimeAdapterProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        "runtime adapter create outcome unknown: workspace profile mismatch",
        this.dependencies.now(),
      );
    }

    const result = runtimeAdapterProvisionResult(
      parsed,
      session,
      this.dependencies.now(),
      adapterWorkspaceId,
      true,
    );
    return result.status === "failed" ? this.releaseFailed(session.id, result) : result;
  }

  async releaseFailed(
    sessionId: string,
    result: InteractiveProvisionResult,
  ): Promise<InteractiveProvisionResult> {
    const adapterWorkspaceId = result.adapterWorkspaceId;
    if (!adapterWorkspaceId) return result;
    await this.dependencies.stageFailedRelease(
      sessionId,
      adapterWorkspaceId,
      result.message,
      this.dependencies.now(),
    );
    try {
      const release = await this.dependencies.stopWorkspaceForSession(
        sessionId,
        adapterWorkspaceId,
      );
      const releaseState = adapterFailureReleaseState(release.status);
      const now = this.dependencies.now();
      if (release.status === "stopped") {
        await this.dependencies.recordConfirmedRelease(
          sessionId,
          adapterWorkspaceId,
          now,
          release.message,
        );
      }
      const releaseMessage = `${result.message}; ${release.message}`;
      if (release.status === "stopping") {
        await this.dependencies.persistStopEvidence(
          sessionId,
          adapterWorkspaceId,
          releaseMessage,
          now,
        );
      }
      return {
        ...result,
        status: releaseState.status,
        attachUrl: null,
        vncUrl: null,
        message: releaseMessage,
        reconcileError: release.status === "stopping" ? releaseMessage : result.message,
        terminalStatus: releaseState.terminalStatus,
      };
    } catch (error) {
      const releaseError = safeProviderError(
        error,
        [adapterWorkspaceId, result.providerResourceId ?? null],
        [result.attachUrl],
      );
      const releaseState = adapterFailureReleaseState("stopping");
      const pendingMessage = `${result.message}; ${releaseState.message}: ${releaseError}`;
      await this.dependencies.persistStopEvidence(
        sessionId,
        adapterWorkspaceId,
        pendingMessage,
        this.dependencies.now(),
      );
      return {
        ...result,
        status: releaseState.status,
        attachUrl: null,
        vncUrl: null,
        message: pendingMessage,
        reconcileError: pendingMessage,
        terminalStatus: releaseState.terminalStatus,
      };
    }
  }
}

export function persistedRuntimeAdapterSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

export function runtimeAdapterProvisionResult(
  result: AdapterWorkspaceResult,
  session: Pick<InteractiveProvisionRequest, "runtime" | "profile"> & {
    adapterRequestedCapabilities?: RuntimeCapabilities | null;
    capabilities_json?: string;
  },
  reconciledAt: number,
  adapterWorkspaceId: string,
  initialCreate: boolean,
): InteractiveProvisionResult {
  const defaultCapabilities =
    session.adapterRequestedCapabilities ??
    (session.capabilities_json
      ? runtimeCapabilities(session.runtime, session.capabilities_json)
      : session.runtime === "crabbox"
        ? crabboxCapabilities
        : containerCapabilities);
  const capabilities = effectiveAdapterCapabilities(result, defaultCapabilities, initialCreate);
  return {
    status: result.status,
    leaseId: null,
    attachUrl: result.terminalUrl,
    attachUrlPresent: initialCreate || result.terminalUrlPresent,
    vncUrl: null,
    message: result.message,
    adapter: runtimeAdapterName,
    profile: session.profile,
    adapterWorkspaceId,
    providerResourceId: result.providerResourceId,
    ...(capabilities === undefined ? {} : { capabilities, capabilitiesPresent: true }),
    ...(initialCreate || result.expiresAtPresent
      ? { expiresAt: result.expiresAt, expiresAtPresent: true }
      : {}),
    reconciledAt,
    reconcileError: null,
    createPending: false,
  };
}

function ambiguousRuntimeAdapterProvision(
  session: Pick<InteractiveProvisionRequest, "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
  reconciledAt: number,
): InteractiveProvisionResult {
  return {
    status: "provisioning",
    leaseId: null,
    attachUrl: null,
    attachUrlPresent: true,
    vncUrl: null,
    message,
    adapter: runtimeAdapterName,
    profile: session.profile,
    adapterWorkspaceId,
    providerResourceId: null,
    capabilities,
    capabilitiesPresent: true,
    expiresAt: null,
    expiresAtPresent: false,
    reconciledAt,
    reconcileError: message,
    terminalStatus: null,
    createPending: true,
  };
}

function runtimeAdapterFailureProvision(
  session: Pick<InteractiveProvisionRequest, "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
  reconciledAt: number,
): InteractiveProvisionResult {
  return {
    ...ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      capabilities,
      message,
      reconciledAt,
    ),
    status: "failed",
    terminalStatus: null,
    createPending: false,
  };
}

function unresolvedRuntimeAdapterProvision(
  session: Pick<InteractiveProvisionRequest, "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
  reconciledAt: number,
): InteractiveProvisionResult {
  return {
    ...runtimeAdapterFailureProvision(
      session,
      adapterWorkspaceId,
      capabilities,
      message,
      reconciledAt,
    ),
    status: "stopping",
    message: `${message}; runtime workspace outcome unresolved`,
    reconcileError: message,
    terminalStatus: "failed",
    createPending: true,
  };
}

function failedProvision(message: string): InteractiveProvisionResult {
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    message,
  };
}

function safeProviderError(
  error: unknown,
  identifiers: Array<string | null> = [],
  connectionValues: Array<string | null> = [],
): string {
  return redactedAdapterMessage(
    clean(error instanceof Error ? error.message : String(error), 2000),
    "failed",
    identifiers,
    connectionValues,
  );
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
