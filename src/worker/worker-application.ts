import { buildFleetState, type FleetState } from "../fleet-state.ts";
import type { TrustedProxyAuthResult } from "../trusted-proxy-auth.ts";
import { AdminRepository } from "./admin-repository.ts";
import { AdminService } from "./admin-service.ts";
import { AuditRepository } from "./audit-repository.ts";
import { actor, authMethods, optionalUser, requireRole, sessionGitHubToken } from "./auth.ts";
import { BrowserSessionCreationService } from "./browser-session-creation.ts";
import { CardLifecycleService, type CardCreateInput } from "./card-lifecycle-service.ts";
import { CardRepository } from "./card-repository.ts";
import { sha256 } from "./crypto.ts";
import {
  browserAppOrigin,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
} from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import { githubHeaders } from "./github.ts";
import { GitHubActionsApplication } from "./github-actions-application.ts";
import { GitHubReferenceService } from "./github-reference-service.ts";
import { conflict, forbidden, notFound, readJson } from "./http.ts";
import { InteractiveSessionApplication } from "./interactive-session-application.ts";
import { createInteractiveDesktopService } from "./interactive-desktop-service.ts";
import { DesktopHostRepository } from "./desktop-host-repository.ts";
import { DesktopHostService } from "./desktop-host-service.ts";
import { InteractiveTerminalService } from "./interactive-terminal-service.ts";
import type { User } from "./models.ts";
import { createNativeAuthService, type NativeAuthService } from "./native-auth.ts";
import { isOpenClawEmbedSessionToken } from "./openclaw-embed-access.ts";
import { OpenClawApplication } from "./openclaw-application.ts";
import { normalizeRepo, sortRepos } from "./repositories.ts";
import type { BrowserSessionRouteDependencies } from "./routes/browser-sessions.ts";
import type { ControlPlaneRouteDependencies } from "./routes/control-plane.ts";
import type { ProvisioningRouteDependencies } from "./routes/provisioning.ts";
import type { NativeRouteDependencies } from "./routes/native.ts";
import type { SessionIngressRouteDependencies } from "./routes/session-ingress.ts";
import type { ServiceSessionRouteDependencies } from "./routes/service-sessions.ts";
import { RuntimeApplication, runtimeAdapterReconcileIntervalMs } from "./runtime-application.ts";
import { defaultSandboxEgressHosts } from "./sandbox-outbound.ts";
import { scheduleNativeAuthPruning, scheduleRecurringCardTick } from "./scheduled.ts";
import { createSandboxSessionResourceService } from "./sandbox-session-resources.ts";
import { ServiceRegistry } from "./service-registry.ts";
import type { InteractiveSession } from "./session-model.ts";
import {
  interactiveSessionAdapterControlPlane,
  interactiveSessionOwnerSubject,
} from "./session-model.ts";
import { readInteractiveSessionShareCredential } from "./session-repository.ts";
import { ownsInteractiveSession } from "./session-access.ts";
import { readSandboxFleetPolicies } from "./session-control-do.ts";
import {
  interactiveTerminalRouteAvailable,
  validateTerminalWebSocketOrigin,
} from "./session-terminal-route.ts";
import { SharedSessionService, type SharedSessionServiceStore } from "./shared-session-service.ts";
import { SshGateway } from "./ssh-gateway.ts";
import { createWorkflowService, type WorkflowService } from "./workflow-service.ts";

const services = {
  adminRepository: Symbol("admin-repository"),
  adminService: Symbol("admin-service"),
  browserSessionCreation: Symbol("browser-session-creation"),
  cardLifecycle: Symbol("card-lifecycle"),
  desktop: Symbol("desktop"),
  desktopHosts: Symbol("desktop-hosts"),
  githubReference: Symbol("github-reference"),
  sandboxResources: Symbol("sandbox-resources"),
  sharedSessions: Symbol("shared-sessions"),
  sshGateway: Symbol("ssh-gateway"),
  terminal: Symbol("terminal"),
  nativeAuth: Symbol("native-auth"),
  workflow: Symbol("workflow"),
};

export class WorkerApplication {
  readonly runtime: RuntimeApplication;
  readonly sessions: InteractiveSessionApplication;
  readonly githubActions: GitHubActionsApplication;
  readonly openClaw: OpenClawApplication;

  private readonly env: RuntimeEnv;
  private readonly registry = new ServiceRegistry();

  constructor(env: RuntimeEnv) {
    this.env = env;
    let openClaw: OpenClawApplication | null = null;
    const supervision = () => {
      if (!openClaw) throw new Error("OpenClaw application is not initialized");
      return openClaw.supervision();
    };

    this.githubActions = new GitHubActionsApplication(env, {
      audit: (user, message, now) => this.audit(user, message, now),
    });
    this.runtime = new RuntimeApplication(env, {
      rollbackReservation: (sessionId, createdAt) =>
        supervision().rollbackReservation(sessionId, createdAt),
    });
    this.sessions = new InteractiveSessionApplication(env, this.runtime, {
      audit: (user, message, now) => this.audit(user, message, now),
      disconnectGitHubActionsRunner: (sessionId) => this.githubActions.disconnectRunner(sessionId),
      supervision,
    });
    openClaw = new OpenClawApplication(env, this.runtime, this.sessions, this.githubActions, {
      audit: (user, message, now) => this.audit(user, message, now),
      openTerminal: async (request, user, session, cols, rows) => {
        const terminalRequest = new Request(request.url, {
          headers: { upgrade: "websocket" },
        });
        const upstream = await this.terminal().openUpstream(
          terminalRequest,
          user,
          session,
          cols,
          rows,
        );
        return upstream.socket;
      },
    });
    this.openClaw = openClaw;
  }

  schedule(context: ExecutionContext): void {
    this.runtime.schedule(context);
    scheduleRecurringCardTick(context, {
      now: Date.now,
      run: (now) => this.cardLifecycleService().runRecurringScheduler(now),
      reportError: (error) => {
        console.error("scheduled recurring card tick failed", error);
      },
    });
    scheduleNativeAuthPruning(context, {
      now: Date.now,
      prune: (now) => this.nativeAuth().pruneExpired(now),
      reportError: (error) => {
        console.error("scheduled native auth pruning failed", error);
      },
    });
  }

  provisioningRoutes(): ProvisioningRouteDependencies {
    const endpoints = this.runtime.endpoints();
    return {
      provision: (request) => endpoints.provision(request),
      stop: (request, provisionId) => endpoints.stop(request, provisionId),
      openPty: (request, provisionId) => endpoints.openPty(request, provisionId),
    };
  }

  sessionIngressRoutes(requestAuth: TrustedProxyAuthResult): SessionIngressRouteDependencies {
    return {
      readSharedSession: (sessionId, token) => this.sharedSessions().read(sessionId, token),
      openTerminal: async (request) => {
        validateTerminalWebSocketOrigin(request, this.env, this.isServiceTerminalRequest(request));
        return this.terminal().open(request, await this.terminalHubUser(request, requestAuth));
      },
    };
  }

  controlPlaneRoutes(context: ExecutionContext): ControlPlaneRouteDependencies {
    const admin = this.adminService();
    return {
      readState: (request, user) => this.readState(request, user, context),
      readFleet: (user) => this.readFleetState(user, undefined, context),
      registerDesktopHost: (user, id, input, ownershipMode, publicationID) =>
        this.desktopHosts().register(user, id, input, ownershipMode, publicationID),
      recoverDesktopHost: (user, id, publicationID) =>
        this.desktopHosts().recover(user, id, publicationID),
      removeDesktopHost: (user, id, ownershipToken) =>
        this.desktopHosts().remove(user, id, ownershipToken),
      searchGitHubRefs: (number) => this.githubReferenceService().search(number),
      createCard: async (request, user) =>
        this.cardLifecycleService().create(await readJson<CardCreateInput>(request), user),
      readCardRuns: (user, cardId) => this.cardLifecycleService().runs(user, cardId),
      mutateCard: (user, cardId, action) =>
        this.cardLifecycleService().mutate(user, cardId, action),
      runRecurringCardScheduler: () => this.cardLifecycleService().runRecurringScheduler(),
      updatePolicy: async (input, user) => {
        await admin.updatePolicy(input, user);
      },
      evaluateWorkflow: async (input, user) => {
        await admin.evaluateWorkflow(input, user);
      },
      addAllowEntry: async (input, user) => {
        await admin.addAllowEntry(input, user);
      },
      removeAllowEntry: async (user, entry) => {
        await admin.removeAllowEntry(entry, user);
      },
      addRepo: async (input, user) => {
        await admin.addRepo(input, user);
      },
      removeRepo: async (user, repo) => {
        await admin.removeRepo(repo, user);
      },
    };
  }

  nativeRoutes(context: ExecutionContext): NativeRouteDependencies {
    const auth = this.nativeAuth();
    return {
      startDevice: (clientName, remoteIp) => auth.start(clientName, remoteIp),
      pollToken: (deviceCode) => auth.poll(deviceCode),
      requireUser: (request) => auth.authenticate(request),
      revokeToken: (request) => auth.revoke(request),
      readFleet: (user) => this.readFleetState(user, undefined, context),
      createNativeVNCGrant: async (user, sessionId) => {
        const session = await this.sessions.readVisibleFresh(user, sessionId);
        if (!session) throw notFound("session not found");
        if (session.canControl !== true) throw forbidden("session control required");
        const controlPlane = session[interactiveSessionAdapterControlPlane];
        if (
          session.runtime !== "crabbox" ||
          session.adapter !== "runtime-v1" ||
          session.capabilities.nativeVnc !== true ||
          !session.adapterWorkspaceId ||
          !controlPlane
        ) {
          throw conflict("native VNC is unavailable for this session");
        }
        return await this.runtime
          .workspaceLifecycle()
          .createNativeVNCGrant(session.profile, controlPlane, session.adapterWorkspaceId);
      },
      deployment: publicDeploymentConfig(this.env),
    };
  }

  nativeAuth(): NativeAuthService {
    return this.registry.get(services.nativeAuth, () => createNativeAuthService(this.env));
  }

  browserSessionRoutes(): BrowserSessionRouteDependencies {
    return {
      createSession: (request, user) => this.browserSessionCreation().create(request, user),
      cleanupSessions: async (request, user) => {
        const removedIds = await this.sessions.cleanup(request, user);
        return {
          state: await this.readState(request, user),
          removedIds,
        };
      },
      readFreshSession: (user, sessionId) => this.sessions.readFreshForUser(user, sessionId),
      presentSession: (session, user) => this.sessions.presentVisibleForUser(session, user),
      readLogs: (user, sessionId) => this.sessions.readLogBundle(user, sessionId),
      readTranscript: (user, sessionId) => this.sessions.transcript(user, sessionId),
      updateSummary: (user, sessionId, input) =>
        this.sessions.updateSummary(user, sessionId, input),
      mutateSession: (request, user, sessionId, action) =>
        this.sessions.mutate(request, user, sessionId, action),
      listCheckpoints: (user, sessionId) =>
        this.sandboxResources().listCheckpoints(user, sessionId),
      createCheckpoint: (user, sessionId) =>
        this.sandboxResources().createCheckpoint(user, sessionId),
      restoreCheckpoint: (user, sessionId, checkpointId) =>
        this.sandboxResources().restoreCheckpoint(user, sessionId, checkpointId),
      readDiagnostics: (user, sessionId) =>
        this.sandboxResources().readDiagnostics(user, sessionId),
      openVnc: (user, sessionId) => this.desktop().open(user, sessionId),
      uploadClipboard: (request, user, sessionId) =>
        this.terminal().uploadClipboard(request, user, sessionId),
      listGrants: (user, sessionId) => this.sessions.listGrants(user, sessionId),
      grantAccess: (user, sessionId, input) => this.sessions.grantAccess(user, sessionId, input),
      revokeAccess: (user, sessionId, subject) =>
        this.sessions.revokeAccess(user, sessionId, subject),
    };
  }

  serviceSessionRoutes(): ServiceSessionRouteDependencies {
    return {
      sshAuth: (request) => this.sshGateway().authenticate(request),
      sshState: (request) => this.sshGateway().state(request),
      agentState: (request) => this.agentState(request),
      createSshSession: (request) => this.sshGateway().createSession(request),
      createAgentSession: (request) => this.agentCreateSession(request),
      updateAgentWorkState: async (request, sessionId) => {
        const result = await this.githubActions.updateWorkState(request, sessionId);
        return {
          session: this.sessions.present(result.session, result.user),
        };
      },
      appendAgentEvent: (request, sessionId) =>
        this.githubActions.appendStructuredEvent(request, sessionId),
      openAgentRunnerPty: (request, sessionId) =>
        this.githubActions.openRunnerPty(request, sessionId),
      requireSshViewer: async (request) => {
        const user = await this.sshGateway().requireUser(request);
        requireRole(user, "viewer");
        return user;
      },
      requireAgentUser: async (request) => (await this.githubActions.authenticate(request)).user,
      readFreshSession: (user, sessionId) => this.sessions.readFreshForUser(user, sessionId),
      presentSession: (session, user) => this.sessions.presentVisibleForUser(session, user),
      mutateSession: (request, user, sessionId, action) =>
        this.sessions.mutate(request, user, sessionId, action),
      listCheckpoints: (user, sessionId) =>
        this.sandboxResources().listCheckpoints(user, sessionId),
      createCheckpoint: (user, sessionId) =>
        this.sandboxResources().createCheckpoint(user, sessionId),
      restoreCheckpoint: (user, sessionId, checkpointId) =>
        this.sandboxResources().restoreCheckpoint(user, sessionId, checkpointId),
      readLogs: (user, sessionId) => this.sessions.readLogBundle(user, sessionId),
      readTranscript: (user, sessionId) => this.sessions.transcript(user, sessionId),
      updateSummary: (user, sessionId, input) =>
        this.sessions.updateSummary(user, sessionId, input),
    };
  }

  sshGateway(): SshGateway {
    return this.registry.get(
      services.sshGateway,
      () =>
        new SshGateway(this.env, {
          readState: (request, user) => this.readState(request, user),
          createSession: (user, body, githubToken) => this.sessions.create(user, body, githubToken),
          audit: (user, message, now) => this.audit(user, message, now),
        }),
    );
  }

  private async readState(
    request: Request,
    user: User,
    context?: ExecutionContext,
  ): Promise<Record<string, unknown>> {
    await this.cardLifecycleService().reconcileStalledRuns();
    await this.runtime.reconcileSessions(Date.now(), context);
    const admin = this.adminRepository();
    const [settings, allow, repos, cards, interactiveSessions, workflows] = await Promise.all([
      admin.readSettings(),
      user.role === "owner" ? admin.readAllowEntries() : Promise.resolve([]),
      admin.readEnabledRepos(),
      this.cardLifecycleService().list(user),
      this.sessions.readAll(user),
      user.role === "owner" ? this.workflowService().summaries() : Promise.resolve([]),
    ]);
    const repoNames = sortRepos(repos, deploymentConfig(this.env).preferredRepo);
    const fleet = await this.readFleetState(user, interactiveSessions, context);

    return {
      user,
      auth: authMethods(this.env, request),
      deployment: clientDeploymentConfig(this.env),
      org: settings.org ?? "OpenClaw",
      cap: numberSetting(settings.cap, 20),
      retention: settings.retention ?? "30",
      merge: settings.merge ?? "guarded",
      allow,
      repos: repoNames,
      workflows,
      cards,
      interactiveSessions,
      fleet,
    };
  }

  private async readFleetState(
    user: User,
    sessionRows?: InteractiveSession[],
    context?: ExecutionContext,
  ): Promise<FleetState> {
    const deployment = deploymentConfig(this.env);
    if (!sessionRows) {
      await this.runtime.reconcileSessions(Date.now(), context);
    }
    const [interactiveSessions, policyResult, desktopHosts] = await Promise.all([
      sessionRows ? Promise.resolve(sessionRows) : this.sessions.readAll(user),
      readSandboxFleetPolicies(this.env),
      this.desktopHosts().list(user),
    ]);
    return buildFleetState(interactiveSessions, policyResult.policies, {
      canonicalUrl: browserAppOrigin(this.env),
      productUrl: deployment.productUrl,
      defaultEgressHosts: defaultSandboxEgressHosts,
      generatedAt: Date.now(),
      registryAvailable: policyResult.available,
      sandboxAvailable: Boolean(this.env.SANDBOX),
      desktopHosts,
    });
  }

  private async terminalHubUser(
    request: Request,
    requestAuth: TrustedProxyAuthResult,
  ): Promise<User | null> {
    if (this.sshGateway().isRequest(request)) {
      return this.sshGateway().requireUser(request);
    }
    if (this.githubActions.isAgentRequest(request)) {
      return (await this.githubActions.authenticate(request)).user;
    }
    return optionalUser(request, this.env, requestAuth);
  }

  private isServiceTerminalRequest(request: Request): boolean {
    return this.sshGateway().isRequest(request) || this.githubActions.isAgentRequest(request);
  }

  private async agentState(request: Request): Promise<Record<string, unknown>> {
    const { session, user } = await this.githubActions.authenticate(request);
    const state = await this.readState(request, user);
    return {
      ...state,
      agent: {
        sessionId: session.id,
        rootSessionId: session.rootSessionId,
      },
    };
  }

  private async agentCreateSession(request: Request): Promise<{ session: InteractiveSession }> {
    const { session: parent, user } = await this.githubActions.authenticate(request);
    const body = await readJson<{
      repo?: string;
      branch?: string;
      runtime?: string;
      profile?: string;
      command?: string;
      prompt?: string;
      parentSessionId?: string;
      rootSessionId?: string;
      purpose?: string;
      summary?: string;
    }>(request);
    if (!normalizeRepo(body.repo)) {
      body.repo = parent.repo || deploymentConfig(this.env).preferredRepo;
    }
    const result = await this.sessions.create(user, body, undefined, {
      createdBy: `session:${parent.id}`,
      owner: parent.owner,
      ownerSubject: parent[interactiveSessionOwnerSubject],
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId || parent.id,
    });
    await this.audit(
      user,
      `agent session ${parent.id} created child ${result.session.id}`,
      Date.now(),
    );
    return result;
  }

  private terminal(): InteractiveTerminalService {
    return this.registry.get(
      services.terminal,
      () =>
        new InteractiveTerminalService(this.env, {
          readSession: (sessionId) => this.sessions.read(sessionId),
          reconcileSession: (sessionId, now) => this.runtime.reconcileById(sessionId, now),
          reconcileIntervalMs: runtimeAdapterReconcileIntervalMs,
          resolveSandboxSession: (request, user, session) =>
            this.sandboxSessionWithGitHubToken(request, user, session),
        }),
    );
  }

  private desktop() {
    return this.registry.get(services.desktop, () =>
      createInteractiveDesktopService(this.env, {
        readFreshSession: (user, sessionId) => this.sessions.readFreshForUser(user, sessionId),
        delegatedControlAvailable: (session) => this.sessions.delegatedControlAvailable(session),
      }),
    );
  }

  private sandboxResources() {
    return this.registry.get(services.sandboxResources, () =>
      createSandboxSessionResourceService(this.env, {
        presentSession: (session, user) => this.sessions.presentForUser(session, user),
      }),
    );
  }

  private sharedSessions(): SharedSessionService {
    return this.registry.get(services.sharedSessions, () => {
      const store: SharedSessionServiceStore = {
        now: () => Date.now(),
        readCredential: (sessionId) => readInteractiveSessionShareCredential(this.env, sessionId),
        hashToken: sha256,
        isEmbedToken: (sessionId, token) => isOpenClawEmbedSessionToken(this.env, sessionId, token),
        terminalRouteAvailable: (session) => interactiveTerminalRouteAvailable(this.env, session),
      };
      return new SharedSessionService(store);
    });
  }

  private browserSessionCreation(): BrowserSessionCreationService {
    return this.registry.get(
      services.browserSessionCreation,
      () =>
        new BrowserSessionCreationService({
          readGitHubToken: (request, user) => sessionGitHubToken(request, this.env, user.subject),
          createSession: (user, input, githubToken) =>
            this.sessions.create(user, input, githubToken).then((result) => result.session),
        }),
    );
  }

  private cardLifecycleService(): CardLifecycleService {
    return this.registry.get(
      services.cardLifecycle,
      () =>
        new CardLifecycleService({
          store: new CardRepository(this.env),
          now: Date.now,
          requireRepo: (repo) => this.adminRepository().requireRepo(repo),
          readSettings: () => this.adminRepository().readSettings(),
          ensureWorkflow: (repo, now) => this.workflowService().ensure(repo, now),
          isConstraintError,
        }),
    );
  }

  private workflowService(): WorkflowService {
    return this.registry.get(services.workflow, () => createWorkflowService(this.env));
  }

  private adminRepository(): AdminRepository {
    return this.registry.get(services.adminRepository, () => new AdminRepository(this.env));
  }

  private desktopHosts(): DesktopHostService {
    return this.registry.get(
      services.desktopHosts,
      () => new DesktopHostService(new DesktopHostRepository(this.env)),
    );
  }

  private adminService(): AdminService {
    return this.registry.get(
      services.adminService,
      () =>
        new AdminService({
          store: this.adminRepository(),
          preferredRepo: deploymentConfig(this.env).preferredRepo,
          now: Date.now,
          refreshWorkflow: (repo, now) => this.workflowService().refresh(repo, now),
          audit: (user, message, now) => this.audit(user, message, now),
        }),
    );
  }

  private githubReferenceService(): GitHubReferenceService {
    return this.registry.get(
      services.githubReference,
      () =>
        new GitHubReferenceService({
          readEnabledRepos: () => this.adminRepository().readEnabledRepos(),
          preferredRepo: deploymentConfig(this.env).preferredRepo,
          authenticated: Boolean(this.env.GITHUB_TOKEN),
          headers: githubHeaders(this.env),
          fetcher: fetch,
        }),
    );
  }

  private async sandboxSessionWithGitHubToken(
    request: Request,
    user: User | null,
    session: InteractiveSession,
  ): Promise<InteractiveSession & { githubToken?: string }> {
    if (!user?.subject.startsWith("github:")) return session;
    if (!ownsInteractiveSession(user, session)) return session;
    const githubToken =
      (await sessionGitHubToken(request, this.env, user.subject)) ??
      (await this.sshGateway().githubTokenForRequest(request, user));
    return githubToken ? { ...session, githubToken } : session;
  }

  private async audit(user: User, message: string, now: number): Promise<void> {
    await new AuditRepository(this.env).record(actor(user), message, now);
  }
}

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}
