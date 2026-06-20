import { appCanonicalOrigin } from "../canonical-host.ts";
import { buildGitHubActionsRunnerPtyUrl } from "../github-actions-runtime.ts";
import { createOpenClawEmbedTicket, openClawRoomMaxSessions } from "../openclaw-service.ts";
import { runtimeAdapterName } from "../runtime-adapter.ts";
import { AdminRepository } from "./admin-repository.ts";
import { actor } from "./auth.ts";
import { browserSessionEmbedUrl, browserSessionUrl, deploymentConfig } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import type { GitHubActionsApplication } from "./github-actions-application.ts";
import { serviceUnavailable } from "./http.ts";
import { userServiceSessionAuthority, type User } from "./models.ts";
import { OpenClawBranchService } from "./openclaw-branch.ts";
import { OpenClawController, type OpenClawControllerStore } from "./openclaw-controller.ts";
import { OpenClawCreateService, type OpenClawCreateStore } from "./openclaw-create.ts";
import {
  OpenClawMutationService,
  type OpenClawMutationStore,
  type OpenClawTerminalSocket,
} from "./openclaw-mutations.ts";
import {
  activateInteractiveSessionReservation,
  canReconcileOpenClawStoppingSession,
  closeOpenClawRootAdmission,
  openClawRoomReservationPosition,
  openClawRootAdmissionOpen,
  readOpenClawLineageSession,
  readOpenClawRoomRoot,
  readOpenClawRoomSessions,
  readOpenClawRootCompletion,
  readOpenClawRootRows,
  removeInteractiveSessionReservation,
} from "./openclaw-repository.ts";
import { openClawEmbedTicketSecret } from "./openclaw-embed-access.ts";
import { readOpenClawRequestSession, type OpenClawCrabboxRequest } from "./openclaw-request.ts";
import { OpenClawRootStopService, type OpenClawRootStopStore } from "./openclaw-root-stop.ts";
import {
  OpenClawSupervisionService,
  type OpenClawSupervisionStore,
} from "./openclaw-supervision.ts";
import type { RuntimeApplication } from "./runtime-application.ts";
import { sandboxLeasePrefix } from "./sandbox-lease.ts";
import { ServiceRegistry } from "./service-registry.ts";
import { appendInteractiveSessionEventRecord } from "./session-events.ts";
import { InteractiveSessionGrantRepository } from "./session-grant-repository.ts";
import type { InteractiveSessionApplication } from "./interactive-session-application.ts";
import type { InteractiveSession } from "./session-model.ts";
import {
  countInteractiveSessionEvents,
  readInteractiveSessionEventRows,
  readInteractiveSessionRecord,
} from "./session-repository.ts";
import { tenancyMode } from "./tenancy.ts";

const openClawPreparationTimeoutMs = 60_000;

const services = {
  controller: Symbol("controller"),
  create: Symbol("create"),
  supervision: Symbol("supervision"),
};

export type OpenClawApplicationDependencies = {
  audit(user: User, message: string, now: number): Promise<void>;
  openTerminal(
    request: Request,
    user: User,
    session: InteractiveSession,
    cols: number,
    rows: number,
  ): Promise<OpenClawTerminalSocket>;
};

export class OpenClawApplication {
  private readonly env: RuntimeEnv;
  private readonly runtime: RuntimeApplication;
  private readonly sessions: InteractiveSessionApplication;
  private readonly githubActions: GitHubActionsApplication;
  private readonly dependencies: OpenClawApplicationDependencies;
  private readonly serviceUser = openClawServiceUser();
  private readonly registry = new ServiceRegistry();

  constructor(
    env: RuntimeEnv,
    runtime: RuntimeApplication,
    sessions: InteractiveSessionApplication,
    githubActions: GitHubActionsApplication,
    dependencies: OpenClawApplicationDependencies,
  ) {
    this.env = env;
    this.runtime = runtime;
    this.sessions = sessions;
    this.githubActions = githubActions;
    this.dependencies = dependencies;
  }

  controller(): OpenClawController {
    return this.registry.get(
      services.controller,
      () => new OpenClawController(this.controllerStore()),
    );
  }

  supervision(): OpenClawSupervisionService {
    return this.registry.get(
      services.supervision,
      () =>
        new OpenClawSupervisionService({
          readSession: (id) => readInteractiveSessionRecord(this.env, id),
          refreshSession: (id) => this.sessions.readFresh(id),
          readLineageSession: (id, preparationPending) =>
            readOpenClawLineageSession(this.env, id, preparationPending),
          rootAdmissionOpen: (rootSessionId) => openClawRootAdmissionOpen(this.env, rootSessionId),
          roomReservationPosition: (rootSessionId, insertedSessionId, insertedAt) =>
            openClawRoomReservationPosition(this.env, rootSessionId, insertedSessionId, insertedAt),
          removeReservation: (insertedSessionId, insertedAt) =>
            removeInteractiveSessionReservation(this.env, insertedSessionId, insertedAt),
          activateReservation: (insertedSessionId, insertedAt, adapterWorkspaceId) =>
            activateInteractiveSessionReservation(
              this.env,
              insertedSessionId,
              insertedAt,
              adapterWorkspaceId,
              runtimeAdapterName,
            ),
        } satisfies OpenClawSupervisionStore),
    );
  }

  private controllerStore(): OpenClawControllerStore {
    return {
      createCrabbox: (input) => this.createService().create(input),
      readRoomRoot: (rootSessionId) => readOpenClawRoomRoot(this.env, rootSessionId),
      readRoomSessions: (rootSessionId) =>
        readOpenClawRoomSessions(this.env, rootSessionId, openClawRoomMaxSessions),
      stopSessionRoot: (request, rootSessionId) =>
        this.rootStopService(request).stop(rootSessionId),
      requireRootScopedSession: (sessionId, rootSessionId) =>
        this.supervision().requireRootScopedSession(sessionId, rootSessionId),
      readTranscriptEvents: (sessionId, maximumEvents) =>
        readInteractiveSessionEventRows(this.env, sessionId, {
          limit: maximumEvents,
          newest: true,
        }),
      countTranscriptEvents: (sessionId) => countInteractiveSessionEvents(this.env, sessionId),
      sendMessage: (request, session, input) =>
        this.mutationService(request).sendMessage(session, input),
      stopSession: (request, session) => this.mutationService(request).stopSession(session),
      registerActionSession: (input) => this.githubActions.register(input, this.serviceUser),
      now: () => Date.now(),
      createEmbedTicket: (sessionId, expiresAt) => {
        const secret = openClawEmbedTicketSecret(this.env);
        if (!secret) {
          throw serviceUnavailable("OpenClaw embed ticket secret is not configured");
        }
        return createOpenClawEmbedTicket(secret, sessionId, expiresAt);
      },
      decorateSession: (session) =>
        this.sessions.present(session, openClawAuthorizedUser(this.serviceUser, session)),
      browserUrl: (sessionId) => browserSessionUrl(this.env, sessionId),
      browserEmbedUrl: (sessionId, token) => browserSessionEmbedUrl(this.env, sessionId, token),
      runnerPtyUrl: (sessionId, agentToken) =>
        buildGitHubActionsRunnerPtyUrl(appCanonicalOrigin, sessionId, agentToken),
    };
  }

  private createService(): OpenClawCreateService {
    return this.registry.get(services.create, () => {
      const admin = new AdminRepository(this.env);
      const branches = new OpenClawBranchService({
        token: this.env.GITHUB_TOKEN,
        requireRepo: (repo) => admin.requireRepo(repo),
      });
      const store: OpenClawCreateStore = {
        defaultRuntime: deploymentConfig(this.env).defaultRuntime,
        privateTenancy: tenancyMode(this.env) === "private",
        now: () => Date.now(),
        preparationSignal: () => AbortSignal.timeout(openClawPreparationTimeoutMs),
        readRequestSession: async (requestId, requestHash, compatibility) => {
          const session = await readOpenClawRequestSession(
            this.env,
            requestId,
            requestHash,
            compatibility,
          );
          return session ? this.sessions.present(session, this.serviceUser) : null;
        },
        resolvePrincipal: (value) =>
          new InteractiveSessionGrantRepository(this.env).resolvePrincipal(value),
        prepareBranch: (repo, branch, baseBranch, signal) =>
          branches.ensure(repo, branch, baseBranch, signal),
        createSession: async (body, githubToken, options) => {
          const createUser = await openClawCreateUser(
            this.serviceUser,
            body,
            (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
            (sessionId, rootSessionId) =>
              this.supervision().requireRootScopedSession(sessionId, rootSessionId),
          );
          return this.sessions
            .create(createUser, body, githubToken, options)
            .then((result) => result.session);
        },
        audit: (message, now) => this.audit(message, now),
        warn: (event) => console.warn(JSON.stringify(event)),
      };
      return new OpenClawCreateService(store);
    });
  }

  private rootStopService(request: Request): OpenClawRootStopService {
    const store: OpenClawRootStopStore = {
      readRootSession: (rootSessionId) => readInteractiveSessionRecord(this.env, rootSessionId),
      recordStopRequested: (rootSessionId, now) =>
        this.audit(`openclaw session root stop requested ${rootSessionId}`, now),
      closeAdmission: (rootSessionId) => closeOpenClawRootAdmission(this.env, rootSessionId),
      readRootRows: (rootSessionId, maximumSessions) =>
        readOpenClawRootRows(this.env, rootSessionId, maximumSessions),
      rollbackReservation: (sessionId, createdAt) =>
        this.supervision().rollbackReservation(sessionId, createdAt),
      stopSession: (session) =>
        this.sessions
          .mutate(request, openClawAuthorizedUser(this.serviceUser, session), session.id, "stop")
          .then(() => undefined),
      canReconcileStoppingSession: (sessionId) =>
        canReconcileOpenClawStoppingSession(this.env, sessionId, sandboxLeasePrefix),
      reconcileSession: (session, now) => this.runtime.reconcileById(session.id, now),
      readRootCompletion: (rootSessionId) => readOpenClawRootCompletion(this.env, rootSessionId),
      recordStopped: (rootSessionId, now) =>
        this.audit(`openclaw session root stopped ${rootSessionId}`, now),
    };
    return new OpenClawRootStopService(store, runtimeAdapterName);
  }

  private mutationService(request: Request): OpenClawMutationService {
    const store: OpenClawMutationStore = {
      now: () => Date.now(),
      recordEvent: (sessionId, message, now) =>
        appendInteractiveSessionEventRecord(this.env, {
          sessionId,
          actor: actor(this.serviceUser),
          message,
          now,
        }),
      audit: (message, now) => this.audit(message, now),
      openTerminal: (session) =>
        this.dependencies.openTerminal(
          request,
          openClawAuthorizedUser(this.serviceUser, session),
          session,
          120,
          34,
        ),
      stopSession: (session) =>
        this.sessions
          .mutate(request, openClawAuthorizedUser(this.serviceUser, session), session.id, "stop")
          .then((result) => result.session),
      warn: (event) => console.warn(JSON.stringify(event)),
    };
    return new OpenClawMutationService(store);
  }

  private audit(message: string, now: number): Promise<void> {
    return this.dependencies.audit(this.serviceUser, message, now);
  }
}

function openClawServiceUser(): User {
  return {
    subject: "service:openclaw",
    login: "openclaw",
    email: null,
    name: "OpenClaw",
    role: "owner",
    allowed: true,
    teams: [],
  };
}

export function openClawAuthorizedUser(serviceUser: User, session: InteractiveSession): User {
  return { ...serviceUser, [userServiceSessionAuthority]: session.id };
}

export async function openClawCreateUser(
  serviceUser: User,
  body: OpenClawCrabboxRequest,
  readSession: (sessionId: string) => Promise<InteractiveSession | null>,
  requireRootScopedSession: (
    sessionId: string,
    rootSessionId: string,
  ) => Promise<InteractiveSession>,
): Promise<User> {
  const parentSessionId = optionalSessionId(body.parentSessionId);
  if (!parentSessionId) return serviceUser;
  const candidate = await readSession(parentSessionId);
  if (!candidate) return serviceUser;
  const parent = await requireRootScopedSession(
    parentSessionId,
    optionalSessionId(body.rootSessionId) || candidate.rootSessionId || candidate.id,
  );
  return openClawAuthorizedUser(serviceUser, parent);
}

function optionalSessionId(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 120) : "";
}
