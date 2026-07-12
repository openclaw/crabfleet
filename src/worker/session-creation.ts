import type { InteractiveSession } from "./session-model.ts";
import type {
  InteractiveSessionCreateRequest,
  ResolvedInteractiveSessionCreateRequest,
} from "./session-create-request.ts";
import type { InteractiveSessionLineage } from "./session-lineage.ts";
import type { InteractiveSessionReservationContext } from "./session-reservation-context.ts";
import type {
  InteractiveSessionReplayReservation,
  InteractiveSessionReservationBuildInput,
} from "./session-repository.ts";
import type {
  InteractiveProvisionPersistence,
  InteractiveProvisionPersistenceInput,
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
  SandboxProvisionOwnership,
} from "./provisioning/types.ts";
import type { RuntimeAdapterWorkspaceRegistration } from "./provisioning/runtime-adapter-release-service.ts";

export type InteractiveSessionCreateOptions = {
  createdBy?: string;
  owner?: string;
  ownerSubject?: string;
  parentSessionId?: string | null;
  rootSessionId?: string | null;
  openClawRequestId?: string | null;
  openClawRequestHash?: string | null;
  afterReserve?: () => Promise<void>;
};

export type InteractiveSessionCreationConfiguration = {
  adapterName: string;
  sandboxLeasePrefix: string;
  maximumAttempts: number;
};

export type InteractiveSessionCreationReservation = {
  id: string;
  insertedAt: number;
  supervisedRootSessionId: string | null;
  requiresActivation: boolean;
  adapterWorkspaceId: string | null;
};

export type InteractiveSessionProvisionRecoveryInput = {
  sessionId: string;
  adapterName: string;
  adapterRegistration: RuntimeAdapterWorkspaceRegistration | null;
  sandboxLeasePrefix: string;
  now: number;
};

export type InteractiveSessionCreationStore = {
  now(): number;
  defaultIdentity(): { owner: string; ownerSubject: string; createdBy: string };
  resolveRequest(
    body: InteractiveSessionCreateRequest,
    identity: { owner: string; createdBy: string },
  ): ResolvedInteractiveSessionCreateRequest;
  requireRepo(repo: string): Promise<void>;
  resolveLineage(
    parentSessionId: string | null,
    rootSessionId: string | null,
  ): Promise<InteractiveSessionLineage>;
  supervisedRootForCreate(
    createdBy: string,
    lineage: InteractiveSessionLineage,
  ): Promise<string | null>;
  nextSessionId(): Promise<string>;
  createReservationContext(
    request: ResolvedInteractiveSessionCreateRequest,
    session: {
      id: string;
      parentSessionId: string | null;
      rootSessionId: string;
    },
  ): Promise<InteractiveSessionReservationContext>;
  insertReservation(
    input: InteractiveSessionReservationBuildInput,
    replay: InteractiveSessionReplayReservation | null,
  ): Promise<void>;
  provisionManaged(
    request: InteractiveProvisionRequest,
    agentToken: string,
    ownership?: SandboxProvisionOwnership,
  ): Promise<InteractiveProvisionResult | null>;
  auditCreated(
    sessionId: string,
    request: ResolvedInteractiveSessionCreateRequest,
    now: number,
  ): Promise<void>;
  decorateSession(session: InteractiveSession): InteractiveSession;
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
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  stopSupersededAdapter(
    sessionId: string,
    adapterWorkspaceId: string,
    registration: RuntimeAdapterWorkspaceRegistration | null,
    createPending: boolean,
    now: number,
  ): Promise<void>;
  cleanupSupersededSandbox(sessionId: string, leaseId: string): Promise<void>;
};

export class InteractiveSessionCreationService {
  private readonly store: InteractiveSessionCreationStore;
  private readonly configuration: InteractiveSessionCreationConfiguration;

  constructor(
    store: InteractiveSessionCreationStore,
    configuration: InteractiveSessionCreationConfiguration,
  ) {
    this.store = store;
    this.configuration = configuration;
  }

  async create(
    body: InteractiveSessionCreateRequest,
    githubToken?: string,
    options: InteractiveSessionCreateOptions = {},
  ): Promise<InteractiveSession> {
    const defaultIdentity = this.store.defaultIdentity();
    const request = this.store.resolveRequest(body, {
      owner: options.owner || defaultIdentity.owner,
      createdBy: options.createdBy || defaultIdentity.createdBy,
    });
    const ownerSubject =
      options.ownerSubject !== undefined
        ? options.ownerSubject
        : options.owner
          ? ""
          : defaultIdentity.ownerSubject;
    await this.store.requireRepo(request.repo);
    const lineage = await this.store.resolveLineage(
      options.parentSessionId ?? boundedId(body.parentSessionId),
      options.rootSessionId ?? boundedId(body.rootSessionId),
    );
    const supervisedRootSessionId = await this.store.supervisedRootForCreate(
      request.createdBy,
      lineage,
    );
    // Keep the insert removable until request evidence is durable.
    const preparationReservation = true;
    const now = this.store.now();

    for (let attempt = 0; attempt < this.configuration.maximumAttempts; attempt += 1) {
      let reservationInserted = false;
      const id = await this.store.nextSessionId();
      const rootSessionId = lineage.rootSessionId ?? id;
      const context = await this.store.createReservationContext(request, {
        id,
        parentSessionId: lineage.parentSessionId,
        rootSessionId,
      });
      try {
        await this.store.insertReservation(
          reservationBuildInput({
            id,
            rootSessionId,
            lineage,
            request,
            context,
            preparationReservation,
            options,
            ownerSubject,
            now,
            adapterName: this.configuration.adapterName,
          }),
          options.openClawRequestId && options.openClawRequestHash
            ? {
                requestId: options.openClawRequestId,
                requestHash: options.openClawRequestHash,
                sessionId: id,
                createdAt: now,
              }
            : null,
        );
        reservationInserted = true;
        const provisioned = await this.provision(
          {
            id,
            insertedAt: now,
            supervisedRootSessionId,
            requiresActivation: preparationReservation,
            adapterWorkspaceId: context.adapterWorkspaceId,
          },
          options.afterReserve,
          () =>
            this.store.provisionManaged(
              provisionRequest(id, rootSessionId, lineage, request, context, githubToken),
              context.agentToken,
              context.initialSandboxLease && context.initialSandboxOwnership
                ? {
                    lease: context.initialSandboxLease,
                    ownership: context.initialSandboxOwnership,
                  }
                : undefined,
            ),
        );
        const persistence = await this.completeProvision(
          {
            sessionId: id,
            insertedAt: now,
            profile: request.profile,
            requestedCapabilities: request.requestedCapabilities,
            initialLeaseId: context.initialSandboxOwnership?.leaseId ?? null,
            initialAgentTokenHash: context.initialAgentTokenHash,
            adapterName: this.configuration.adapterName,
          },
          provisioned,
        );
        if (!persistence.updated && provisioned) {
          const current = await this.recoverSupersededProvision(
            {
              sessionId: id,
              adapterName: this.configuration.adapterName,
              adapterRegistration: context.adapterControlPlane
                ? {
                    profile: request.profile,
                    controlPlane: context.adapterControlPlane,
                  }
                : null,
              sandboxLeasePrefix: this.configuration.sandboxLeasePrefix,
              now: this.store.now(),
            },
            provisioned,
          );
          return this.store.decorateSession(current);
        }
        await this.store.auditCreated(id, request, now);
        const current = await this.store.readSession(id);
        if (!current) throw new Error("interactive session disappeared after creation");
        return this.store.decorateSession(current);
      } catch (error) {
        const replay = await this.recoverReservationFailure(error, {
          reservationInserted,
          attempt,
          maximumAttempts: this.configuration.maximumAttempts,
          requestId: options.openClawRequestId ?? null,
          requestHash: options.openClawRequestHash ?? null,
        });
        if (replay) return replay;
      }
    }
    throw new Error("failed to allocate interactive session id");
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
      await this.store.recordRequest(reservation.id, reservation.insertedAt);
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

  async recoverSupersededProvision(
    input: InteractiveSessionProvisionRecoveryInput,
    result: InteractiveProvisionResult,
  ): Promise<InteractiveSession> {
    let current = await this.store.readSession(input.sessionId);
    const currentAdapterProvision = Boolean(
      current &&
      current.adapter === input.adapterName &&
      current.adapterWorkspaceId === result.adapterWorkspaceId &&
      ["provisioning", "pending_adapter", "ready", "attached", "detached"].includes(current.status),
    );
    if (
      !currentAdapterProvision &&
      result.adapter === input.adapterName &&
      result.adapterWorkspaceId
    ) {
      await this.store.stopSupersededAdapter(
        input.sessionId,
        result.adapterWorkspaceId,
        input.adapterRegistration,
        result.createPending === true,
        input.now,
      );
    }
    if (
      result.adapter !== input.adapterName &&
      result.leaseId?.startsWith(input.sandboxLeasePrefix)
    ) {
      await this.store.cleanupSupersededSandbox(input.sessionId, result.leaseId);
      current = await this.store.readSession(input.sessionId);
    }
    if (!current) throw new Error("interactive session disappeared during provisioning");
    return current;
  }
}

function reservationBuildInput(input: {
  id: string;
  rootSessionId: string;
  lineage: InteractiveSessionLineage;
  request: ResolvedInteractiveSessionCreateRequest;
  context: InteractiveSessionReservationContext;
  preparationReservation: boolean;
  options: InteractiveSessionCreateOptions;
  ownerSubject: string;
  now: number;
  adapterName: string;
}): InteractiveSessionReservationBuildInput {
  const {
    id,
    rootSessionId,
    lineage,
    request,
    context,
    preparationReservation,
    options,
    ownerSubject,
    now,
  } = input;
  return {
    id,
    parentSessionId: lineage.parentSessionId,
    rootSessionId,
    repo: request.repo,
    branch: request.branch,
    runtime: request.runtime,
    adapterName: input.adapterName,
    profile: request.profile,
    adapterWorkspaceId: context.adapterWorkspaceId,
    adapterControlPlane: context.adapterControlPlane,
    requestedCapabilities: request.requestedCapabilities,
    adapterSettings: context.adapterSettings,
    adapterCreatePayloadJson: context.adapterCreatePayloadJson,
    preparationReservation,
    openClawRequestId: options.openClawRequestId ?? null,
    openClawRequestHash: options.openClawRequestHash ?? null,
    command: request.command,
    prompt: request.prompt,
    purpose: request.purpose,
    summary: request.summary,
    owner: request.owner,
    ownerSubject,
    createdBy: request.createdBy,
    initialLeaseId: context.initialSandboxOwnership?.leaseId ?? null,
    initialAgentTokenHash: context.initialAgentTokenHash,
    now,
  };
}

function provisionRequest(
  id: string,
  rootSessionId: string,
  lineage: InteractiveSessionLineage,
  request: ResolvedInteractiveSessionCreateRequest,
  context: InteractiveSessionReservationContext,
  githubToken?: string,
): InteractiveProvisionRequest {
  return {
    id,
    ...(context.adapterWorkspaceId ? { adapterWorkspaceId: context.adapterWorkspaceId } : {}),
    ...(context.adapterControlPlane ? { adapterControlPlane: context.adapterControlPlane } : {}),
    ...(context.adapterSettings
      ? {
          adapterTtlSeconds: context.adapterSettings.ttlSeconds,
          adapterIdleTimeoutSeconds: context.adapterSettings.idleTimeoutSeconds,
          adapterRequestedCapabilities: context.adapterSettings.capabilities,
          adapterCreatePayloadJson: context.adapterCreatePayloadJson,
        }
      : {}),
    parentSessionId: lineage.parentSessionId,
    rootSessionId,
    repo: request.repo,
    branch: request.branch,
    runtime: request.runtime,
    profile: request.profile,
    command: request.command,
    prompt: request.prompt,
    purpose: request.purpose,
    summary: request.summary,
    owner: request.owner,
    createdBy: request.createdBy,
    ...(githubToken ? { githubToken } : {}),
  };
}

function boundedId(value: unknown): string | null {
  return (
    String(value ?? "")
      .trim()
      .slice(0, 120) || null
  );
}
