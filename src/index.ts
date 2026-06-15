import { ContainerProxy, Sandbox as CloudflareSandboxBase } from "@cloudflare/sandbox";
import { buildFleetState, type FleetState } from "./fleet-state";
import {
  APP_HTML,
  LOGO_PNG_BASE64,
  OG_IMAGE_PNG_BASE64,
  SPEC_HTML,
  SPEC_MARKDOWN,
  SPEC_V2_HTML,
  SPEC_V2_MARKDOWN,
} from "./generated";
import type { TrustedProxyAuthResult } from "./trusted-proxy-auth";
import {
  browserAppOrigin,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
} from "./worker/deployment";
import type { RuntimeEnv } from "./worker/env";
import type { User } from "./worker/models";
import { json, readJson, securityHeaders, text, wantsMarkdown } from "./worker/http";
import { enforceWorkerIngressAuth, prepareWorkerIngress } from "./worker/ingress";
import {
  actor,
  authMethods,
  devIdentityLogin,
  logout,
  optionalUser,
  requireRole,
  requireUser,
  sessionGitHubToken,
  tokenLogin,
} from "./worker/auth";
import { sha256 } from "./worker/crypto";
import { AuditRepository } from "./worker/audit-repository";
import { githubCallback, githubLogin } from "./worker/github-auth";
import { githubHeaders } from "./worker/github";
import type { InteractiveSession } from "./worker/session-model";
import { CardLifecycleService, type CardCreateInput } from "./worker/card-lifecycle-service";
import { CardRepository } from "./worker/card-repository";
import { AdminRepository } from "./worker/admin-repository";
import { AdminService } from "./worker/admin-service";
import { BrowserSessionCreationService } from "./worker/browser-session-creation";
import { GitHubReferenceService } from "./worker/github-reference-service";
import { createWorkflowService, type WorkflowService } from "./worker/workflow-service";
import { normalizeRepo, sortRepos } from "./worker/repositories";
import { handlePublicAuthRoute, handleSessionAuthRoute } from "./worker/routes/auth";
import {
  handleBrowserSessionRoute,
  type BrowserSessionRouteDependencies,
} from "./worker/routes/browser-sessions";
import {
  handleControlPlaneRoute,
  type ControlPlaneRouteDependencies,
} from "./worker/routes/control-plane";
import { handleOpenClawRoute } from "./worker/routes/openclaw";
import {
  handleProvisioningRoute,
  type ProvisioningRouteDependencies,
} from "./worker/routes/provisioning";
import {
  handleSessionIngressRoute,
  type SessionIngressRouteDependencies,
} from "./worker/routes/session-ingress";
import {
  handleServiceSessionRoute,
  type ServiceSessionRouteDependencies,
} from "./worker/routes/service-sessions";
import { readInteractiveSessionShareCredential } from "./worker/session-repository";
import { isOpenClawEmbedSessionToken } from "./worker/openclaw-embed-access";
import {
  SharedSessionService,
  type SharedSessionServiceStore,
} from "./worker/shared-session-service";
import { SshGateway } from "./worker/ssh-gateway";
import { interactiveTerminalRouteAvailable } from "./worker/session-terminal-route";
import { terminalAssetResponse } from "./worker/terminal-assets";
import { readSandboxFleetPolicies } from "./worker/session-control-do";
import { defaultSandboxEgressHosts, sandboxPlaceholderOpenAIKey } from "./worker/sandbox-outbound";
import { sandboxOutbound } from "./worker/sandbox-outbound-service";
import { createInteractiveDesktopService } from "./worker/interactive-desktop-service";
import { InteractiveTerminalService } from "./worker/interactive-terminal-service";
import { createSandboxSessionResourceService } from "./worker/sandbox-session-resources";
import {
  RuntimeApplication,
  runtimeAdapterReconcileIntervalMs,
} from "./worker/runtime-application";
import { InteractiveSessionApplication } from "./worker/interactive-session-application";
import { GitHubActionsApplication } from "./worker/github-actions-application";
import { OpenClawApplication } from "./worker/openclaw-application";

type SandboxClassWithOutbound = {
  outbound?: typeof sandboxOutbound;
};

type WorkerApplication = {
  runtime: RuntimeApplication;
  sessions: InteractiveSessionApplication;
  githubActions: GitHubActionsApplication;
  openClaw: OpenClawApplication;
};

export class Sandbox extends CloudflareSandboxBase<RuntimeEnv> {
  override allowedHosts = ["*"];
  override enableInternet = false;
  override envVars = {
    CRABFLEET_SANDBOX: "1",
    CURL_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    GIT_SSL_CAINFO: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    NODE_EXTRA_CA_CERTS: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    OPENAI_API_KEY: sandboxPlaceholderOpenAIKey,
    REQUESTS_CA_BUNDLE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
    SSL_CERT_FILE: "/etc/cloudflare/certs/cloudflare-containers-ca.crt",
  };
  override interceptHttps = true;
}

(Sandbox as unknown as SandboxClassWithOutbound).outbound = sandboxOutbound;

export { ContainerProxy };
export { SessionControlDO } from "./worker/session-control-do";

export default {
  async fetch(request: Request, env: RuntimeEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      const ingress = prepareWorkerIngress(request, env);
      request = ingress.request;
      const { trustedProxy } = ingress;

      if (url.pathname === "/healthz") {
        return text("ok\n", "text/plain; charset=utf-8");
      }

      enforceWorkerIngressAuth(ingress);

      if (url.pathname === "/crabbox-logo.png") {
        return new Response(base64Bytes(LOGO_PNG_BASE64), {
          headers: {
            ...securityHeaders("image/png"),
            "cache-control": "public, max-age=86400",
          },
        });
      }

      if (url.pathname === "/crabfleet-og.png") {
        return new Response(base64Bytes(OG_IMAGE_PNG_BASE64), {
          headers: {
            ...securityHeaders("image/png"),
            "cache-control": "public, max-age=86400",
          },
        });
      }

      const terminalAsset = terminalAssetResponse(url.pathname);
      if (terminalAsset) return terminalAsset;

      if (url.pathname === "/docs/spec.md") {
        return text(SPEC_MARKDOWN, "text/markdown; charset=utf-8");
      }

      if (url.pathname === "/docs/spec-v2.md") {
        return text(SPEC_V2_MARKDOWN, "text/markdown; charset=utf-8");
      }

      if (url.pathname === "/docs/spec-v2" || url.pathname === "/docs/spec-v2/") {
        if (wantsMarkdown(request)) {
          return text(SPEC_V2_MARKDOWN, "text/markdown; charset=utf-8", { vary: "Accept" });
        }

        return text(SPEC_V2_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      if (
        url.pathname === "/docs" ||
        url.pathname === "/docs/" ||
        url.pathname === "/docs/spec" ||
        url.pathname === "/docs/spec/"
      ) {
        if (wantsMarkdown(request)) {
          return text(SPEC_MARKDOWN, "text/markdown; charset=utf-8", { vary: "Accept" });
        }

        return text(SPEC_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      const application = workerApplication(env);
      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (authRequest) => githubLogin(authRequest, env),
        githubCallback: (authRequest) => githubCallback(authRequest, env),
        sshLink: (authRequest, code, requestAuth) =>
          sshGateway(env, application.runtime, application.sessions).link(
            authRequest,
            code,
            requestAuth,
          ),
        tokenLogin: (authRequest) => tokenLogin(authRequest, env),
        devIdentityLogin: (authRequest) => devIdentityLogin(authRequest, env),
        logout: (authRequest) => logout(authRequest, env),
        authState: (authRequest) =>
          json({
            auth: authMethods(env, authRequest),
            deployment: publicDeploymentConfig(env),
          }),
      });
      if (authResponse) return authResponse;

      if (url.pathname.startsWith("/api/")) {
        return await api(request, env, context, trustedProxy, application);
      }

      if (
        url.pathname === "/" ||
        url.pathname === "/app" ||
        url.pathname === "/app/" ||
        url.pathname === "/app/fleet" ||
        url.pathname === "/app/fleet/" ||
        url.pathname === "/app/board" ||
        url.pathname === "/app/board/" ||
        url.pathname === "/sessions" ||
        url.pathname === "/sessions/" ||
        url.pathname.startsWith("/sessions/") ||
        url.pathname.startsWith("/app/sessions/")
      ) {
        return text(APP_HTML, "text/html; charset=utf-8", { vary: "Accept" });
      }

      return new Response("Not found\n", {
        status: 404,
        headers: securityHeaders("text/plain; charset=utf-8"),
      });
    } catch (error) {
      const hasStatus = typeof error === "object" && error && "status" in error;
      const status = hasStatus ? Number(error.status) : 500;
      const message = hasStatus && error instanceof Error ? error.message : "internal error";
      return json({ error: message }, { status: Number.isFinite(status) ? status : 500 });
    }
  },
  async scheduled(
    _controller: ScheduledController,
    env: RuntimeEnv,
    context: ExecutionContext,
  ): Promise<void> {
    workerApplication(env).runtime.schedule(context);
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function api(
  request: Request,
  env: RuntimeEnv,
  context: ExecutionContext,
  requestAuth: TrustedProxyAuthResult,
  application: WorkerApplication,
): Promise<Response> {
  const url = new URL(request.url);
  const { runtime } = application;

  const provisioningResponse = await handleProvisioningRoute(
    request,
    url,
    provisioningRouteDependencies(runtime),
  );
  if (provisioningResponse) return provisioningResponse;

  const serviceSessionResponse = await handleServiceSessionRoute(
    request,
    url,
    serviceSessionRouteDependencies(env, application),
  );
  if (serviceSessionResponse) return serviceSessionResponse;

  const openClawResponse = await handleOpenClawRoute(request, url, {
    controller: application.openClaw.controller(),
    automationTokens: [env.CRABBOX_OPENCLAW_TOKEN],
    roomTokens: [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN],
  });
  if (openClawResponse) return openClawResponse;

  const sessionIngressResponse = await handleSessionIngressRoute(
    request,
    url,
    sessionIngressRouteDependencies(env, requestAuth, application),
  );
  if (sessionIngressResponse) return sessionIngressResponse;

  const user = await requireUser(request, env, requestAuth);

  const sessionAuthResponse = handleSessionAuthRoute(request, url, user, {
    sessionState: (authRequest, authenticatedUser) =>
      json({ user: authenticatedUser, auth: authMethods(env, authRequest) }),
  });
  if (sessionAuthResponse) return sessionAuthResponse;

  const controlPlaneResponse = await handleControlPlaneRoute(
    request,
    url,
    user,
    controlPlaneRouteDependencies(env, context, application),
  );
  if (controlPlaneResponse) return controlPlaneResponse;

  const browserSessionResponse = await handleBrowserSessionRoute(
    request,
    url,
    user,
    browserSessionRouteDependencies(env, application),
  );
  if (browserSessionResponse) return browserSessionResponse;

  return json({ error: "not found" }, { status: 404 });
}

function controlPlaneRouteDependencies(
  env: RuntimeEnv,
  context: ExecutionContext,
  application: WorkerApplication,
): ControlPlaneRouteDependencies {
  const admin = adminService(env);
  const { runtime, sessions } = application;
  return {
    readState: (request, user) => readState(request, env, user, runtime, sessions, context),
    readFleet: (user) => readFleetState(env, user, runtime, sessions, undefined, context),
    searchGitHubRefs: (number) => githubReferenceService(env).search(number),
    createCard: async (request, user) =>
      cardLifecycleService(env).create(await readJson<CardCreateInput>(request), user),
    readCardRuns: (cardId) => cardLifecycleService(env).runs(cardId),
    mutateCard: (user, cardId, action) => cardLifecycleService(env).mutate(user, cardId, action),
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

function provisioningRouteDependencies(runtime: RuntimeApplication): ProvisioningRouteDependencies {
  const endpoints = runtime.endpoints();
  return {
    provision: (request) => endpoints.provision(request),
    stop: (request, provisionId) => endpoints.stop(request, provisionId),
    openPty: (request, provisionId) => endpoints.openPty(request, provisionId),
  };
}

function sessionIngressRouteDependencies(
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
  application: WorkerApplication,
): SessionIngressRouteDependencies {
  const sharedSessions = sharedSessionService(env);
  const { runtime, sessions } = application;
  return {
    readSharedSession: (sessionId, token) => sharedSessions.read(sessionId, token),
    openTerminal: async (request) =>
      interactiveTerminalService(env, runtime, sessions).open(
        request,
        await terminalHubUser(request, env, requestAuth, application),
      ),
  };
}

function sharedSessionService(env: RuntimeEnv): SharedSessionService {
  const store: SharedSessionServiceStore = {
    now: () => Date.now(),
    readCredential: (sessionId) => readInteractiveSessionShareCredential(env, sessionId),
    hashToken: sha256,
    isEmbedToken: (sessionId, token) => isOpenClawEmbedSessionToken(env, sessionId, token),
    terminalRouteAvailable: (session) => interactiveTerminalRouteAvailable(env, session),
  };
  return new SharedSessionService(store);
}

function browserSessionRouteDependencies(
  env: RuntimeEnv,
  application: WorkerApplication,
): BrowserSessionRouteDependencies {
  const { runtime, sessions } = application;
  const creation = new BrowserSessionCreationService({
    readGitHubToken: (request, user) => sessionGitHubToken(request, env, user.subject),
    createSession: (user, input, githubToken) =>
      sessions.create(user, input, githubToken).then((result) => result.session),
  });
  return {
    createSession: (request, user) => creation.create(request, user),
    cleanupSessions: async (request, user) => {
      const removedIds = await sessions.cleanup(request, user);
      return {
        state: await readState(request, env, user, runtime, sessions),
        removedIds,
      };
    },
    readFreshSession: (sessionId) => sessions.readFresh(sessionId),
    presentSession: (session, user) => sessions.present(session, user),
    readLogs: (user, sessionId) => sessions.readLogBundle(user, sessionId),
    readTranscript: (user, sessionId) => sessions.transcript(user, sessionId),
    updateSummary: (user, sessionId, input) => sessions.updateSummary(user, sessionId, input),
    mutateSession: (request, user, sessionId, action) =>
      sessions.mutate(request, user, sessionId, action),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env, sessions).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env, sessions).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env, sessions).restoreCheckpoint(user, sessionId, checkpointId),
    readDiagnostics: (user, sessionId) =>
      sandboxSessionResourceService(env, sessions).readDiagnostics(user, sessionId),
    openVnc: (user, sessionId) => interactiveDesktopService(env, sessions).open(user, sessionId),
    uploadClipboard: (request, user, sessionId) =>
      interactiveTerminalService(env, runtime, sessions).uploadClipboard(request, user, sessionId),
  };
}

function serviceSessionRouteDependencies(
  env: RuntimeEnv,
  application: WorkerApplication,
): ServiceSessionRouteDependencies {
  const { runtime, sessions, githubActions } = application;
  return {
    sshAuth: (request) => sshGateway(env, runtime, sessions).authenticate(request),
    sshState: (request) => sshGateway(env, runtime, sessions).state(request),
    agentState: (request) => agentState(request, env, application),
    createSshSession: (request) => sshGateway(env, runtime, sessions).createSession(request),
    createAgentSession: (request) =>
      agentCreateInteractiveSession(request, env, sessions, githubActions),
    updateAgentWorkState: async (request, sessionId) => {
      const result = await githubActions.updateWorkState(request, sessionId);
      return { session: sessions.present(result.session, result.user) };
    },
    openAgentRunnerPty: (request, sessionId) => githubActions.openRunnerPty(request, sessionId),
    requireSshViewer: async (request) => {
      const user = await sshGateway(env, runtime, sessions).requireUser(request);
      requireRole(user, "viewer");
      return user;
    },
    requireAgentUser: async (request) => (await githubActions.authenticate(request)).user,
    readFreshSession: (sessionId) => sessions.readFresh(sessionId),
    presentSession: (session, user) => sessions.present(session, user),
    mutateSession: (request, user, sessionId, action) =>
      sessions.mutate(request, user, sessionId, action),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env, sessions).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env, sessions).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env, sessions).restoreCheckpoint(user, sessionId, checkpointId),
    readLogs: (user, sessionId) => sessions.readLogBundle(user, sessionId),
    readTranscript: (user, sessionId) => sessions.transcript(user, sessionId),
    updateSummary: (user, sessionId, input) => sessions.updateSummary(user, sessionId, input),
  };
}

async function terminalHubUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
  application: WorkerApplication,
): Promise<User | null> {
  const { runtime, sessions, githubActions } = application;
  if (sshGateway(env, runtime, sessions).isRequest(request)) {
    return sshGateway(env, runtime, sessions).requireUser(request);
  }
  if (githubActions.isAgentRequest(request)) {
    return (await githubActions.authenticate(request)).user;
  }
  return optionalUser(request, env, requestAuth);
}

function interactiveTerminalService(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): InteractiveTerminalService {
  return new InteractiveTerminalService(env, {
    readFreshSession: (sessionId) => sessions.readFresh(sessionId),
    reconcileSession: (sessionId, now) => runtime.reconcileById(sessionId, now),
    reconcileIntervalMs: runtimeAdapterReconcileIntervalMs,
    resolveSandboxSession: (request, user, session) =>
      sandboxSessionWithGitHubToken(request, env, user, session, runtime, sessions),
  });
}

function interactiveDesktopService(env: RuntimeEnv, sessions: InteractiveSessionApplication) {
  return createInteractiveDesktopService(env, {
    readFreshSession: (sessionId) => sessions.readFresh(sessionId),
    delegatedControlAvailable: (session) => sessions.delegatedControlAvailable(session),
  });
}

function sandboxSessionResourceService(env: RuntimeEnv, sessions: InteractiveSessionApplication) {
  return createSandboxSessionResourceService(env, {
    presentSession: (session, user) => sessions.present(session, user),
    delegatedControlAvailable: (session) => sessions.delegatedControlAvailable(session),
  });
}

function cardLifecycleService(env: RuntimeEnv): CardLifecycleService {
  const admin = new AdminRepository(env);
  return new CardLifecycleService({
    store: new CardRepository(env),
    now: Date.now,
    requireRepo: (repo) => admin.requireRepo(repo),
    readSettings: () => admin.readSettings(),
    ensureWorkflow: (repo, now) => workflowService(env).ensure(repo, now),
    isConstraintError,
  });
}

function workflowService(env: RuntimeEnv): WorkflowService {
  return createWorkflowService(env);
}

function adminService(env: RuntimeEnv): AdminService {
  return new AdminService({
    store: new AdminRepository(env),
    preferredRepo: deploymentConfig(env).preferredRepo,
    now: Date.now,
    refreshWorkflow: (repo, now) => workflowService(env).refresh(repo, now),
    audit: (user, message, now) => audit(env, user, message, now),
  });
}

function githubReferenceService(env: RuntimeEnv): GitHubReferenceService {
  return new GitHubReferenceService({
    readEnabledRepos: () => new AdminRepository(env).readEnabledRepos(),
    preferredRepo: deploymentConfig(env).preferredRepo,
    authenticated: Boolean(env.GITHUB_TOKEN),
    headers: githubHeaders(env),
    fetcher: fetch,
  });
}

function sshGateway(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): SshGateway {
  return new SshGateway(env, {
    readState: (request, user) => readState(request, env, user, runtime, sessions),
    createSession: (user, body, githubToken) => sessions.create(user, body, githubToken),
    audit: (user, message, now) => audit(env, user, message, now),
  });
}

async function agentState(
  request: Request,
  env: RuntimeEnv,
  application: WorkerApplication,
): Promise<Record<string, unknown>> {
  const { runtime, sessions, githubActions } = application;
  const { session, user } = await githubActions.authenticate(request);
  const state = await readState(request, env, user, runtime, sessions);
  return { ...state, agent: { sessionId: session.id, rootSessionId: session.rootSessionId } };
}

async function agentCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  sessions: InteractiveSessionApplication,
  githubActions: GitHubActionsApplication,
): Promise<{ session: InteractiveSession }> {
  const { session: parent, user } = await githubActions.authenticate(request);
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
  if (!normalizeRepo(body.repo)) body.repo = parent.repo || deploymentConfig(env).preferredRepo;
  const result = await sessions.create(user, body, undefined, {
    createdBy: `session:${parent.id}`,
    owner: parent.owner,
    parentSessionId: parent.id,
    rootSessionId: parent.rootSessionId || parent.id,
  });
  await audit(
    env,
    user,
    `agent session ${parent.id} created child ${result.session.id}`,
    Date.now(),
  );
  return result;
}

function workerApplication(env: RuntimeEnv): WorkerApplication {
  let sessions: InteractiveSessionApplication;
  let openClaw: OpenClawApplication;
  const githubActions = new GitHubActionsApplication(env, {
    audit: (user, message, now) => audit(env, user, message, now),
  });
  const runtime = new RuntimeApplication(env, {
    rollbackReservation: (sessionId, createdAt) =>
      openClaw.supervision().rollbackReservation(sessionId, createdAt),
  });
  sessions = new InteractiveSessionApplication(env, runtime, {
    audit: (user, message, now) => audit(env, user, message, now),
    disconnectGitHubActionsRunner: (sessionId) => githubActions.disconnectRunner(sessionId),
    supervision: () => openClaw.supervision(),
  });
  openClaw = new OpenClawApplication(env, runtime, sessions, githubActions, {
    audit: (user, message, now) => audit(env, user, message, now),
    openTerminal: async (request, user, session, cols, rows) => {
      const terminalRequest = new Request(request.url, { headers: { upgrade: "websocket" } });
      const upstream = await interactiveTerminalService(env, runtime, sessions).openUpstream(
        terminalRequest,
        user,
        session,
        cols,
        rows,
      );
      return upstream.socket;
    },
  });
  return { runtime, sessions, githubActions, openClaw };
}

async function readState(
  request: Request,
  env: RuntimeEnv,
  user: User,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
  context?: ExecutionContext,
): Promise<Record<string, unknown>> {
  await cardLifecycleService(env).reconcileStalledRuns();
  await runtime.reconcileSessions(Date.now(), context);
  const admin = new AdminRepository(env);
  const [settings, allow, repos, cards, interactiveSessions, workflows] = await Promise.all([
    admin.readSettings(),
    user.role === "owner" ? admin.readAllowEntries() : Promise.resolve([]),
    admin.readEnabledRepos(),
    cardLifecycleService(env).list(),
    sessions.readAll(user),
    user.role === "owner" ? workflowService(env).summaries() : Promise.resolve([]),
  ]);
  const repoNames = sortRepos(repos, deploymentConfig(env).preferredRepo);
  const fleet = await readFleetState(env, user, runtime, sessions, interactiveSessions);

  return {
    user,
    auth: authMethods(env, request),
    deployment: clientDeploymentConfig(env),
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

async function readFleetState(
  env: RuntimeEnv,
  user: User,
  runtime: RuntimeApplication,
  application: InteractiveSessionApplication,
  sessionRows?: InteractiveSession[],
  context?: ExecutionContext,
): Promise<FleetState> {
  const deployment = deploymentConfig(env);
  if (!sessionRows) await runtime.reconcileSessions(Date.now(), context);
  const [interactiveSessions, policyResult] = await Promise.all([
    sessionRows ? Promise.resolve(sessionRows) : application.readAll(user),
    readSandboxFleetPolicies(env),
  ]);
  return buildFleetState(interactiveSessions, policyResult.policies, {
    canonicalUrl: browserAppOrigin(env),
    productUrl: deployment.productUrl,
    defaultEgressHosts: defaultSandboxEgressHosts,
    generatedAt: Date.now(),
    registryAvailable: policyResult.available,
    sandboxAvailable: Boolean(env.SANDBOX),
  });
}

async function sandboxSessionWithGitHubToken(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): Promise<InteractiveSession & { githubToken?: string }> {
  if (!user?.subject.startsWith("github:")) return session;
  if (actor(user) !== session.owner) return session;
  const githubToken =
    (await sessionGitHubToken(request, env, user.subject)) ??
    (await sshGateway(env, runtime, sessions).githubTokenForRequest(request, user));
  return githubToken ? { ...session, githubToken } : session;
}

async function audit(env: RuntimeEnv, user: User, message: string, now: number): Promise<void> {
  await new AuditRepository(env).record(actor(user), message, now);
}

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
