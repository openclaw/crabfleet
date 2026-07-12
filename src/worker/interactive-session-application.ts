import { githubActionsRuntime } from "../github-actions-runtime.ts";
import { runtimeAdapterBrowserVncUrl, runtimeAdapterName } from "../runtime-adapter.ts";
import { browserAppOrigin, browserSessionShareUrl, deploymentConfig } from "./deployment.ts";
import { AdminRepository } from "./admin-repository.ts";
import { actor } from "./auth.ts";
import { badRequest, notFound, readJson, securityHeaders, text } from "./http.ts";
import type { RuntimeEnv } from "./env.ts";
import type { User } from "./models.ts";
import type { OpenClawSupervisionService } from "./openclaw-supervision.ts";
import { readOpenClawRequestSession } from "./openclaw-request.ts";
import { safeProviderError } from "./provisioning/result.ts";
import {
  confirmRuntimeAdapterRelease,
  persistRuntimeAdapterStopEvidence,
} from "./provisioning/runtime-adapter-repository.ts";
import type { RuntimeApplication } from "./runtime-application.ts";
import { configuredRuntimeAdapterControlPlane } from "./runtime-adapter-preflight.ts";
import { queueSandboxCredentialPolicyCleanup } from "./sandbox-credential-policy-repository.ts";
import { stageTerminalCredentialPolicyCleanupById } from "./sandbox-credential-policy-cleanup.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "./sandbox-credential-policy-cleanup-service.ts";
import {
  isSandboxInteractiveSession,
  sandboxLeaseInfo,
  sandboxLeasePrefix,
} from "./sandbox-lease.ts";
import { ServiceRegistry } from "./service-registry.ts";
import {
  appendInteractiveSessionEventRecord,
  persistInteractiveSessionEventRecord,
} from "./session-events.ts";
import {
  canChangeInteractiveSessionMultiplayer,
  canControlInteractiveSession,
  canManageInteractiveSession,
  canViewInteractiveSession,
  delegatedInteractiveSessionControlAvailable,
  type InteractiveSessionAccessGrant,
} from "./session-access.ts";
import {
  InteractiveSessionAttachService,
  type InteractiveSessionAttachStore,
} from "./session-attach.ts";
import { createInteractiveSessionCleanupService } from "./session-cleanup.ts";
import {
  resolveInteractiveSessionCreateRequest,
  type InteractiveSessionCreateRequest,
} from "./session-create-request.ts";
import {
  InteractiveSessionCreationService,
  type InteractiveSessionCreateOptions,
  type InteractiveSessionCreationStore,
} from "./session-creation.ts";
import {
  InteractiveSessionLineageService,
  type InteractiveSessionLineageStore,
} from "./session-lineage.ts";
import { archiveInteractiveSessionLogs, sessionLogTranscript } from "./session-log-archive.ts";
import {
  InteractiveSessionGrantRepository,
  type InteractiveSessionGrant,
} from "./session-grant-repository.ts";
import {
  InteractiveSessionGrantService,
  type InteractiveSessionGrantInput,
  type InteractiveSessionGrantServiceStore,
} from "./session-grant-service.ts";
import {
  InteractiveSessionMetadataService,
  isInteractiveSessionMetadataAction,
  type InteractiveSessionMetadataStore,
  type InteractiveSessionSummaryInput,
} from "./session-metadata.ts";
import {
  interactiveSession,
  interactiveSessionEvent,
  type InteractiveSession,
  type InteractiveSessionEvent,
  type InteractiveSessionLogArchive,
} from "./session-model.ts";
import { presentInteractiveSession } from "./session-presentation.ts";
import {
  buildInteractiveSessionReservationValues,
  countInteractiveSessionEvents,
  insertInteractiveSessionReservation,
  markInteractiveSessionPendingAdapter,
  persistGitHubActionsSessionStop,
  persistInteractiveSessionEventMutation,
  persistInteractiveSessionProvisionResult,
  readInteractiveSessionEventRows,
  readInteractiveSessionLogArchives,
  readInteractiveSessionRecord,
  readInteractiveSessionRecordsForUser,
  readInteractiveSessionTerminalCleanupIntent,
  readRuntimeAdapterCreatePending,
} from "./session-repository.ts";
import { createInteractiveSessionReservationContext } from "./session-reservation-context.ts";
import { readAuthorizedFreshSession } from "./session-authorized-refresh.ts";
import {
  RuntimeAdapterStopService,
  type RuntimeAdapterStopStore,
} from "./session-runtime-adapter-stop.ts";
import { InteractiveSessionStopService, type InteractiveSessionStopStore } from "./session-stop.ts";
import { finalizeTerminalInteractiveSession } from "./session-terminal-finalization.ts";
import { interactiveTerminalRouteAvailable } from "./session-terminal-route.ts";
import {
  GitHubActionsSessionStopService,
  type GitHubActionsSessionStopStore,
} from "./github-actions-session-stop.ts";
import { nextInteractiveSessionId } from "./session-id-repository.ts";
import { tenancyMode, tenantSubject } from "./tenancy.ts";

const services = {
  adminRepository: Symbol("admin-repository"),
  attach: Symbol("attach"),
  cleanup: Symbol("cleanup"),
  githubActionsStop: Symbol("github-actions-stop"),
  grants: Symbol("grants"),
  grantRepository: Symbol("grant-repository"),
  lineage: Symbol("lineage"),
};

export type InteractiveSessionApplicationDependencies = {
  audit(user: User, message: string, now: number): Promise<void>;
  disconnectGitHubActionsRunner(sessionId: string): Promise<void>;
  supervision(): OpenClawSupervisionService;
};

export class InteractiveSessionApplication {
  private readonly env: RuntimeEnv;
  private readonly runtime: RuntimeApplication;
  private readonly dependencies: InteractiveSessionApplicationDependencies;
  private readonly registry = new ServiceRegistry();

  constructor(
    env: RuntimeEnv,
    runtime: RuntimeApplication,
    dependencies: InteractiveSessionApplicationDependencies,
  ) {
    this.env = env;
    this.runtime = runtime;
    this.dependencies = dependencies;
  }

  async create(
    user: User,
    body: InteractiveSessionCreateRequest,
    githubToken?: string,
    options: InteractiveSessionCreateOptions = {},
  ): Promise<{ session: InteractiveSession }> {
    return {
      session: await this.creation(user).create(body, githubToken, options),
    };
  }

  async cleanup(request: Request, user: User): Promise<string[]> {
    const body = await readJson<{ ids?: unknown }>(request);
    const ids = Array.isArray(body.ids)
      ? [...new Set(body.ids.map((id) => clean(String(id), 80)).filter(Boolean))]
      : [];
    const removedIds = await this.cleanupService().cleanup(ids, (row) =>
      canManageInteractiveSession(user, interactiveSession(row, []), {
        mode: tenancyMode(this.env),
      }),
    );
    if (removedIds.length) {
      await this.dependencies.audit(
        user,
        `interactive sessions cleaned ${removedIds.join(",")}`,
        Date.now(),
      );
    }
    return removedIds;
  }

  async readAll(user: User): Promise<InteractiveSession[]> {
    const sessions = await readInteractiveSessionRecordsForUser(this.env, user, 80, Date.now());
    const now = Date.now();
    const grants = await this.grantRepository().readActiveForSessions(
      sessions.map((session) => session.id),
      tenantSubject(user),
      now,
    );
    return sessions.flatMap((session) => {
      const grant = grants.get(session.id) ?? null;
      return this.canView(user, session, grant, now)
        ? [this.present(session, user, grant, now)]
        : [];
    });
  }

  async readFresh(id: string): Promise<InteractiveSession | null> {
    await this.runtime.reconcileById(id).catch((error) => {
      console.error("targeted runtime adapter reconciliation failed", error);
    });
    return readInteractiveSessionRecord(this.env, id);
  }

  read(id: string): Promise<InteractiveSession | null> {
    return readInteractiveSessionRecord(this.env, id);
  }

  readFreshForUser(user: User, id: string): Promise<InteractiveSession | null> {
    return readAuthorizedFreshSession({
      read: () => this.read(id),
      authorize: async (session) => {
        const now = Date.now();
        return this.canView(user, session, await this.grantFor(user, id, now), now);
      },
      refresh: async () => {
        await this.runtime.reconcileById(id).catch((error) => {
          console.error("targeted runtime adapter reconciliation failed", error);
        });
      },
    });
  }

  async readVisibleFresh(user: User, id: string): Promise<InteractiveSession | null> {
    const session = await this.readFreshForUser(user, id);
    if (!session) return null;
    const now = Date.now();
    const grant = await this.grantFor(user, session.id, now);
    if (!this.canView(user, session, grant, now)) return null;
    return this.present(session, user, grant, now);
  }

  async readLogBundle(
    user: User,
    id: string,
  ): Promise<{
    session: InteractiveSession;
    events: InteractiveSessionEvent[];
    archive: InteractiveSessionLogArchive | null;
    eventCount: number;
    truncated: boolean;
  }> {
    const session = await readInteractiveSessionRecord(this.env, id);
    if (!session) throw notFound("interactive session not found");
    const now = Date.now();
    const grant = await this.grantFor(user, id, now);
    if (!this.canView(user, session, grant, now)) throw notFound("interactive session not found");
    const [events, eventCount, archives] = await Promise.all([
      readInteractiveSessionEventRows(this.env, id, { limit: 5000, newest: true }),
      countInteractiveSessionEvents(this.env, id),
      readInteractiveSessionLogArchives(this.env, [id]),
    ]);
    return {
      session: this.present(session, user, grant, now),
      events: events.map(interactiveSessionEvent),
      archive: archives.get(id) ?? null,
      eventCount,
      truncated: eventCount > events.length,
    };
  }

  async transcript(user: User, id: string): Promise<Response> {
    const session = await readInteractiveSessionRecord(this.env, id);
    if (!session) throw notFound("interactive session not found");
    const now = Date.now();
    const grant = await this.grantFor(user, id, now);
    if (!this.canView(user, session, grant, now)) throw notFound("interactive session not found");

    if (this.env.SESSION_LOGS && session.logArchive?.transcriptKey) {
      const object = await this.env.SESSION_LOGS.get(session.logArchive.transcriptKey);
      if (object?.body) {
        return new Response(object.body, {
          headers: securityHeaders("text/markdown; charset=utf-8", false),
        });
      }
    }

    const events = await readInteractiveSessionEventRows(this.env, id, { limit: 10000 });
    return text(sessionLogTranscript(session, events), "text/markdown; charset=utf-8", {
      "cache-control": "no-store",
    });
  }

  async updateSummary(
    user: User,
    id: string,
    input: InteractiveSessionSummaryInput,
  ): Promise<{ session: InteractiveSession }> {
    const current = await readInteractiveSessionRecord(this.env, id);
    if (!current) throw notFound("interactive session not found");
    const grant = await this.grantFor(user, id);
    const accessContext = this.accessContext(grant);
    if (!canManageInteractiveSession(user, current, accessContext)) {
      throw notFound("interactive session not found");
    }
    return {
      session: this.present(
        await this.metadata(user).updateSummary({
          ...input,
          sessionId: id,
          actor: actor(user),
          now: Date.now(),
          canManage: (session) => canManageInteractiveSession(user, session, accessContext),
        }),
        user,
        grant,
      ),
    };
  }

  async mutate(
    request: Request,
    user: User,
    id: string,
    action: string,
  ): Promise<{ session: InteractiveSession; shareUrl?: string }> {
    const session = await this.readFreshForUser(user, id);
    if (!session) throw notFound("interactive session not found");
    const now = Date.now();
    const grant = await this.grantFor(user, id, now);
    const accessContext = this.accessContext(grant);
    if (!canViewInteractiveSession(user, session, now, accessContext)) {
      throw notFound("interactive session not found");
    }
    const userActor = actor(user);
    if (action === "attach") {
      const attached = await this.attach().attach({
        session,
        actor: userActor,
        canControl: canControlInteractiveSession(
          user,
          session,
          now,
          this.delegatedControlAvailable(session),
          accessContext,
        ),
        now,
      });
      return { session: this.present(attached, user, grant, now) };
    }

    const canManage = canManageInteractiveSession(user, session, accessContext);
    if (isInteractiveSessionMetadataAction(action)) {
      const delegatedControlAvailable = this.delegatedControlAvailable(session);
      const result = await this.metadata(user).mutate({
        session,
        action,
        actor: userActor,
        subject: tenantSubject(user),
        policy: {
          canManage,
          canChangeMultiplayer: canChangeInteractiveSessionMultiplayer(
            user,
            session,
            accessContext,
          ),
          canControl: canControlInteractiveSession(
            user,
            session,
            now,
            delegatedControlAvailable,
            accessContext,
          ),
          delegatedControlAvailable,
          stableSubjectsRequired: tenancyMode(this.env) === "private",
        },
        now,
      });
      return {
        session: this.present(result.session, user, grant, now),
        ...(result.shareToken
          ? { shareUrl: browserSessionShareUrl(request, this.env, id, result.shareToken) }
          : {}),
      };
    }

    if (action === "stop") {
      const stopped = await this.stop(user).stop({
        session,
        actor: userActor,
        canManage,
        now,
      });
      return { session: this.present(stopped, user, grant, now) };
    }

    throw badRequest("unknown action");
  }

  present(
    session: InteractiveSession,
    user: User,
    grant: InteractiveSessionAccessGrant | null = null,
    now = Date.now(),
  ): InteractiveSession {
    return presentInteractiveSession(session, user, {
      now,
      delegatedControlAvailable: this.delegatedControlAvailable(session),
      terminalRouteAvailable: interactiveTerminalRouteAvailable(this.env, session),
      runtimeProfiles: deploymentConfig(this.env).runtimeProfiles,
      configuredRuntimeAdapterControlPlane: (profile) =>
        configuredRuntimeAdapterControlPlane(this.env, profile),
      browserVncUrl: (sessionId) =>
        runtimeAdapterBrowserVncUrl(browserAppOrigin(this.env), sessionId),
      tenancyMode: tenancyMode(this.env),
      grant,
    });
  }

  async presentForUser(session: InteractiveSession, user: User): Promise<InteractiveSession> {
    const now = Date.now();
    return this.present(session, user, await this.grantFor(user, session.id, now), now);
  }

  async presentVisibleForUser(
    session: InteractiveSession,
    user: User,
  ): Promise<InteractiveSession | null> {
    const now = Date.now();
    const grant = await this.grantFor(user, session.id, now);
    return this.canView(user, session, grant, now) ? this.present(session, user, grant, now) : null;
  }

  listGrants(user: User, sessionId: string): Promise<{ grants: InteractiveSessionGrant[] }> {
    return this.grants().list(user, sessionId);
  }

  grantAccess(
    user: User,
    sessionId: string,
    input: InteractiveSessionGrantInput,
  ): Promise<{ grants: InteractiveSessionGrant[] }> {
    return this.grants().grant(user, sessionId, input);
  }

  revokeAccess(
    user: User,
    sessionId: string,
    subject: string,
  ): Promise<{ grants: InteractiveSessionGrant[] }> {
    return this.grants().revoke(user, sessionId, subject);
  }

  delegatedControlAvailable(session: InteractiveSession): boolean {
    return delegatedInteractiveSessionControlAvailable(Boolean(this.env.SANDBOX), session);
  }

  private creation(user: User): InteractiveSessionCreationService {
    const admin = this.adminRepository();
    const supervision = this.dependencies.supervision();
    const store: InteractiveSessionCreationStore = {
      now: () => Date.now(),
      defaultIdentity: () => {
        const identity = actor(user);
        return { owner: identity, ownerSubject: tenantSubject(user), createdBy: identity };
      },
      resolveRequest: (body, identity) =>
        resolveInteractiveSessionCreateRequest(this.env, body, identity),
      requireRepo: (repo) => admin.requireRepo(repo),
      resolveLineage: (parentSessionId, rootSessionId) =>
        this.lineage().resolve(user, parentSessionId, rootSessionId),
      supervisedRootForCreate: (createdBy, lineage) =>
        supervision.supervisedRootForCreate(createdBy, lineage),
      nextSessionId: () => nextInteractiveSessionId(this.env),
      createReservationContext: (request, session) =>
        createInteractiveSessionReservationContext(this.env, request, session),
      insertReservation: (input, replay) =>
        insertInteractiveSessionReservation(
          this.env,
          buildInteractiveSessionReservationValues(input),
          replay,
        ),
      provisionManaged: (request, agentToken, ownership) =>
        this.runtime.provisioning().provisionManaged(request, agentToken, ownership),
      auditCreated: (sessionId, request, now) =>
        this.dependencies.audit(
          user,
          `interactive session created ${sessionId} repo=${request.repo} runtime=${request.runtime}`,
          now,
        ),
      decorateSession: (session) => this.present(session, user),
      enforceSupervision: (rootSessionId, insertedSessionId, insertedAt) =>
        supervision.enforceRoomSessionLimitAfterInsert(
          rootSessionId,
          insertedSessionId,
          insertedAt,
        ),
      rollbackReservation: (insertedSessionId, insertedAt) =>
        supervision.rollbackReservation(insertedSessionId, insertedAt),
      activateReservation: (insertedSessionId, insertedAt, adapterWorkspaceId) =>
        supervision.requireReservationActivation(insertedSessionId, insertedAt, adapterWorkspaceId),
      recordRequest: (insertedSessionId, insertedAt) =>
        persistInteractiveSessionEventRecord(this.env, {
          sessionId: insertedSessionId,
          actor: actor(user),
          message: "interactive workspace requested",
          now: insertedAt,
        }),
      isConstraintError,
      readRequestReplay: async (requestId, requestHash) => {
        const session = await readOpenClawRequestSession(this.env, requestId, requestHash);
        return session ? this.present(session, user) : null;
      },
      persistProvisionResult: (input, result) =>
        persistInteractiveSessionProvisionResult(this.env, input, result),
      markPendingAdapter: (input) => markInteractiveSessionPendingAdapter(this.env, input),
      recordProvisionEvent: (sessionId, message, now) =>
        appendInteractiveSessionEventRecord(this.env, {
          sessionId,
          actor: actor(user),
          message,
          now,
        }),
      finalizeTerminal: (sessionId, status, now) =>
        finalizeTerminalInteractiveSession(this.env, sessionId, status, now),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
      stopSupersededAdapter: (sessionId, adapterWorkspaceId, registration, createPending, now) =>
        this.runtime.release().stopSuperseded({
          sessionId,
          adapterWorkspaceId,
          registration,
          createPending,
          now,
        }),
      cleanupSupersededSandbox: async (sessionId, leaseId) => {
        await queueSandboxCredentialPolicyCleanup(
          this.env,
          sessionId,
          sandboxLeaseInfo({ id: sessionId, leaseId }).sandboxId,
        );
        await reconcileSandboxCredentialPolicyCleanupBatch(this.env, Date.now(), sessionId);
      },
    };
    return new InteractiveSessionCreationService(store, {
      adapterName: runtimeAdapterName,
      sandboxLeasePrefix,
      maximumAttempts: 3,
    });
  }

  private adminRepository(): AdminRepository {
    return this.registry.get(services.adminRepository, () => new AdminRepository(this.env));
  }

  private lineage(): InteractiveSessionLineageService {
    return this.registry.get(
      services.lineage,
      () =>
        new InteractiveSessionLineageService({
          readSession: (id) => readInteractiveSessionRecord(this.env, id),
          canManage: (user, session) =>
            canManageInteractiveSession(user, session, { mode: tenancyMode(this.env) }),
        } satisfies InteractiveSessionLineageStore),
    );
  }

  private cleanupService() {
    return this.registry.get(services.cleanup, () =>
      createInteractiveSessionCleanupService(this.env),
    );
  }

  private attach(): InteractiveSessionAttachService {
    return this.registry.get(
      services.attach,
      () =>
        new InteractiveSessionAttachService({
          persist: (session, actorName, transition, now) =>
            persistInteractiveSessionEventMutation(
              this.env,
              session,
              actorName,
              transition.message,
              {
                status: transition.status,
                last_seen_at: transition.lastSeenAt,
              },
              now,
            ),
          archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
          readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
        } satisfies InteractiveSessionAttachStore),
    );
  }

  private metadata(user: User): InteractiveSessionMetadataService {
    return new InteractiveSessionMetadataService({
      persist: (session, actorName, message, values, now) =>
        persistInteractiveSessionEventMutation(this.env, session, actorName, message, values, now),
      archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
      audit: (message, now) => this.dependencies.audit(user, message, now),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
    } satisfies InteractiveSessionMetadataStore);
  }

  private githubActionsStop(): GitHubActionsSessionStopService {
    return this.registry.get(
      services.githubActionsStop,
      () =>
        new GitHubActionsSessionStopService({
          persist: (session, actorName, now) =>
            persistGitHubActionsSessionStop(
              this.env,
              session,
              actorName,
              githubActionsRuntime,
              now,
            ),
          disconnect: (sessionId) => this.dependencies.disconnectGitHubActionsRunner(sessionId),
          archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
          finalize: (sessionId, now) =>
            finalizeTerminalInteractiveSession(this.env, sessionId, "stopped", now),
        } satisfies GitHubActionsSessionStopStore),
    );
  }

  private runtimeAdapterStop(): RuntimeAdapterStopService {
    const store: RuntimeAdapterStopStore = {
      claimStop: (session, actorName, now) =>
        persistInteractiveSessionEventMutation(
          this.env,
          session,
          actorName,
          "runtime adapter stop requested",
          {
            status: "stopping",
            lease_id: null,
            reconcile_error: null,
            agent_token_hash: null,
            attach_url: null,
            vnc_url: null,
            controller: null,
            controller_subject: null,
            control_requested_by: null,
            control_requested_by_subject: null,
            control_requested_at: null,
            control_granted_at: null,
            control_expires_at: null,
          },
          now,
        ),
      archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
      stopWorkspace: (sessionId, adapterWorkspaceId) =>
        this.runtime.workspaceLifecycle().stopForSession(sessionId, adapterWorkspaceId),
      providerError: (error, adapterWorkspaceId) => safeProviderError(error, [adapterWorkspaceId]),
      persistEvidence: (sessionId, adapterWorkspaceId, message, now, reconcileError, actorName) =>
        persistRuntimeAdapterStopEvidence(
          this.env,
          sessionId,
          adapterWorkspaceId,
          message,
          now,
          reconcileError,
          actorName,
        ),
      readCreatePending: (sessionId, adapterWorkspaceId) =>
        readRuntimeAdapterCreatePending(
          this.env,
          sessionId,
          runtimeAdapterName,
          adapterWorkspaceId,
        ),
      confirmRelease: (sessionId, adapterWorkspaceId, now, message) =>
        confirmRuntimeAdapterRelease(this.env, sessionId, adapterWorkspaceId, now, message),
      now: Date.now,
    };
    return new RuntimeAdapterStopService(store, runtimeAdapterName);
  }

  private stop(user: User): InteractiveSessionStopService {
    const store: InteractiveSessionStopStore = {
      isSandbox: isSandboxInteractiveSession,
      stageTerminalCleanup: (sessionId, status, message, now) =>
        stageTerminalCredentialPolicyCleanupById(this.env, sessionId, status, message, now),
      reconcileCleanup: (sessionId, now) =>
        reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, sessionId),
      readTerminalCleanupIntent: (sessionId) =>
        readInteractiveSessionTerminalCleanupIntent(this.env, sessionId),
      recordEvent: (sessionId, message, now) =>
        appendInteractiveSessionEventRecord(this.env, {
          sessionId,
          actor: actor(user),
          message,
          now,
        }),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
      finalizeTerminal: (sessionId, status, now) =>
        finalizeTerminalInteractiveSession(this.env, sessionId, status, now),
      stopGitHubActions: (session, actorName, now) =>
        this.githubActionsStop().stop(session, actorName, now),
      stopRuntimeAdapter: (session, actorName, now) =>
        this.runtimeAdapterStop().stop({
          session,
          actor: actorName,
          now,
        }),
      audit: (message, now) => this.dependencies.audit(user, message, now),
    };
    return new InteractiveSessionStopService(store, runtimeAdapterName);
  }

  private grantRepository(): InteractiveSessionGrantRepository {
    return this.registry.get(
      services.grantRepository,
      () => new InteractiveSessionGrantRepository(this.env),
    );
  }

  private grants(): InteractiveSessionGrantService {
    return this.registry.get(services.grants, () => {
      const repository = this.grantRepository();
      return new InteractiveSessionGrantService({
        readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
        canManage: async (user, session) =>
          canManageInteractiveSession(user, session, { mode: tenancyMode(this.env) }),
        resolvePrincipal: (value) => repository.resolvePrincipal(value),
        list: (sessionId) => repository.list(sessionId),
        upsert: (input) => repository.upsert(input),
        revoke: (sessionId, subject, now) => repository.revoke(sessionId, subject, now),
        appendEvent: (sessionId, actorName, message, now) =>
          appendInteractiveSessionEventRecord(this.env, {
            sessionId,
            actor: actorName,
            message,
            now,
          }),
        audit: (user, message, now) => this.dependencies.audit(user, message, now),
        warn: (event) => console.error(JSON.stringify(event)),
        now: Date.now,
      } satisfies InteractiveSessionGrantServiceStore);
    });
  }

  private async grantFor(
    user: User,
    sessionId: string,
    now = Date.now(),
  ): Promise<InteractiveSessionGrant | null> {
    return this.grantRepository().readActive(sessionId, tenantSubject(user), now);
  }

  private accessContext(grant: InteractiveSessionAccessGrant | null) {
    return { mode: tenancyMode(this.env), grant } as const;
  }

  private canView(
    user: User,
    session: InteractiveSession,
    grant: InteractiveSessionAccessGrant | null,
    now: number,
  ): boolean {
    return canViewInteractiveSession(user, session, now, this.accessContext(grant));
  }
}

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}
