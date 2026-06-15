import { ContainerProxy, Sandbox as CloudflareSandboxBase } from "@cloudflare/sandbox";
import { buildFleetState, type FleetState } from "./fleet-state";
import { buildGitHubActionsRunnerPtyUrl } from "./github-actions-runtime";
import {
  APP_HTML,
  LOGO_PNG_BASE64,
  OG_IMAGE_PNG_BASE64,
  SPEC_HTML,
  SPEC_MARKDOWN,
  SPEC_V2_HTML,
  SPEC_V2_MARKDOWN,
} from "./generated";
import { appCanonicalOrigin } from "./canonical-host";
import { runtimeAdapterName } from "./runtime-adapter";
import { createOpenClawEmbedTicket, openClawRoomMaxSessions } from "./openclaw-service";
import type { TrustedProxyAuthResult } from "./trusted-proxy-auth";
import {
  browserAppOrigin,
  browserSessionEmbedUrl,
  browserSessionUrl,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
} from "./worker/deployment";
import type { RuntimeEnv } from "./worker/env";
import type { User } from "./worker/models";
import {
  badRequest,
  json,
  readJson,
  securityHeaders,
  serviceUnavailable,
  text,
  wantsMarkdown,
} from "./worker/http";
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
import {
  AgentSessionAuthenticator,
  agentSessionId,
  type AgentSessionAuthenticationStore,
} from "./worker/session-agent-auth";
import { githubCallback, githubLogin } from "./worker/github-auth";
import { githubHeaders } from "./worker/github";
import {
  GitHubActionsSessionRegistrationService,
  type GitHubActionsSessionRegistrationStore,
} from "./worker/github-actions-session-registration";
import {
  GitHubActionsRunnerConnectionService,
  type GitHubActionsRunnerConnectionStore,
} from "./worker/github-actions-runner-connection";
import { GitHubActionsRepository } from "./worker/github-actions-repository";
import {
  GitHubActionsWorkStateService,
  type GitHubActionsWorkStateInput,
  type GitHubActionsWorkStateStore,
} from "./worker/github-actions-session-work-state";
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
import { sandboxLeasePrefix } from "./worker/sandbox-lease";
import { readOpenClawRequestSession } from "./worker/openclaw-request";
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
} from "./worker/openclaw-repository";
import {
  OpenClawSupervisionService,
  type OpenClawSupervisionStore,
} from "./worker/openclaw-supervision";
import { OpenClawRootStopService, type OpenClawRootStopStore } from "./worker/openclaw-root-stop";
import { OpenClawMutationService, type OpenClawMutationStore } from "./worker/openclaw-mutations";
import { OpenClawCreateService, type OpenClawCreateStore } from "./worker/openclaw-create";
import { OpenClawBranchService } from "./worker/openclaw-branch";
import { OpenClawController, type OpenClawControllerStore } from "./worker/openclaw-controller";
import {
  countInteractiveSessionEvents,
  readAgentSessionCredential,
  readInteractiveSessionEventRows,
  readInteractiveSessionRecord as readInteractiveSession,
  readInteractiveSessionShareCredential,
} from "./worker/session-repository";
import { nextInteractiveSessionId } from "./worker/session-id-repository";
import {
  isOpenClawEmbedSessionToken,
  openClawEmbedTicketSecret,
} from "./worker/openclaw-embed-access";
import { appendInteractiveSessionEventRecord } from "./worker/session-events";
import {
  SharedSessionService,
  type SharedSessionServiceStore,
} from "./worker/shared-session-service";
import { newAgentToken } from "./worker/session-reservation-context";
import { SshGateway } from "./worker/ssh-gateway";
import { interactiveTerminalRouteAvailable } from "./worker/session-terminal-route";
import { terminalAssetResponse } from "./worker/terminal-assets";
import { githubActionsRelayStub, readSandboxFleetPolicies } from "./worker/session-control-do";
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

type SandboxClassWithOutbound = {
  outbound?: typeof sandboxOutbound;
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

const openClawPreparationTimeoutMs = 60_000;

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

      const { runtime, sessions } = workerApplication(env);
      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (authRequest) => githubLogin(authRequest, env),
        githubCallback: (authRequest) => githubCallback(authRequest, env),
        sshLink: (authRequest, code, requestAuth) =>
          sshGateway(env, runtime, sessions).link(authRequest, code, requestAuth),
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
        return await api(request, env, context, trustedProxy, runtime, sessions);
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): Promise<Response> {
  const url = new URL(request.url);

  const provisioningResponse = await handleProvisioningRoute(
    request,
    url,
    provisioningRouteDependencies(runtime),
  );
  if (provisioningResponse) return provisioningResponse;

  const serviceSessionResponse = await handleServiceSessionRoute(
    request,
    url,
    serviceSessionRouteDependencies(env, runtime, sessions),
  );
  if (serviceSessionResponse) return serviceSessionResponse;

  const openClawResponse = await handleOpenClawRoute(request, url, {
    controller: openClawController(env, runtime, sessions),
    automationTokens: [env.CRABBOX_OPENCLAW_TOKEN],
    roomTokens: [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN],
  });
  if (openClawResponse) return openClawResponse;

  const sessionIngressResponse = await handleSessionIngressRoute(
    request,
    url,
    sessionIngressRouteDependencies(env, requestAuth, runtime, sessions),
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
    controlPlaneRouteDependencies(env, context, runtime, sessions),
  );
  if (controlPlaneResponse) return controlPlaneResponse;

  const browserSessionResponse = await handleBrowserSessionRoute(
    request,
    url,
    user,
    browserSessionRouteDependencies(env, runtime, sessions),
  );
  if (browserSessionResponse) return browserSessionResponse;

  return json({ error: "not found" }, { status: 404 });
}

function controlPlaneRouteDependencies(
  env: RuntimeEnv,
  context: ExecutionContext,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): ControlPlaneRouteDependencies {
  const admin = adminService(env);
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): SessionIngressRouteDependencies {
  const sharedSessions = sharedSessionService(env);
  return {
    readSharedSession: (sessionId, token) => sharedSessions.read(sessionId, token),
    openTerminal: async (request) =>
      interactiveTerminalService(env, runtime, sessions).open(
        request,
        await terminalHubUser(request, env, requestAuth, runtime, sessions),
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): BrowserSessionRouteDependencies {
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): ServiceSessionRouteDependencies {
  return {
    sshAuth: (request) => sshGateway(env, runtime, sessions).authenticate(request),
    sshState: (request) => sshGateway(env, runtime, sessions).state(request),
    agentState: (request) => agentState(request, env, runtime, sessions),
    createSshSession: (request) => sshGateway(env, runtime, sessions).createSession(request),
    createAgentSession: (request) => agentCreateInteractiveSession(request, env, sessions),
    updateAgentWorkState: (request, sessionId) =>
      updateGitHubActionsWorkState(request, env, sessionId, sessions),
    openAgentRunnerPty: (request, sessionId) => githubActionsRunnerPty(request, env, sessionId),
    requireSshViewer: async (request) => {
      const user = await sshGateway(env, runtime, sessions).requireUser(request);
      requireRole(user, "viewer");
      return user;
    },
    requireAgentUser: async (request) =>
      (await agentSessionAuthentication(env).require(request)).user,
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): Promise<User | null> {
  if (sshGateway(env, runtime, sessions).isRequest(request)) {
    return sshGateway(env, runtime, sessions).requireUser(request);
  }
  if (agentSessionId(request)) {
    return (await agentSessionAuthentication(env).require(request)).user;
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
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): Promise<Record<string, unknown>> {
  const { session, user } = await agentSessionAuthentication(env).require(request);
  const state = await readState(request, env, user, runtime, sessions);
  return { ...state, agent: { sessionId: session.id, rootSessionId: session.rootSessionId } };
}

async function agentCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  sessions: InteractiveSessionApplication,
): Promise<{ session: InteractiveSession }> {
  const { session: parent, user } = await agentSessionAuthentication(env).require(request);
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

function workerApplication(env: RuntimeEnv): {
  runtime: RuntimeApplication;
  sessions: InteractiveSessionApplication;
} {
  let sessions: InteractiveSessionApplication;
  const runtime = new RuntimeApplication(env, {
    rollbackReservation: (sessionId, createdAt) =>
      openClawSupervision(env, sessions).rollbackReservation(sessionId, createdAt),
  });
  sessions = new InteractiveSessionApplication(env, runtime, {
    audit: (user, message, now) => audit(env, user, message, now),
    disconnectGitHubActionsRunner: (sessionId) => disconnectGitHubActionsRunner(env, sessionId),
    supervision: () => openClawSupervision(env, sessions),
  });
  return { runtime, sessions };
}

function openClawSupervision(
  env: RuntimeEnv,
  sessions: InteractiveSessionApplication,
): OpenClawSupervisionService {
  const store: OpenClawSupervisionStore = {
    readSession: (id) => readInteractiveSession(env, id),
    refreshSession: (id) => sessions.readFresh(id),
    readLineageSession: (id, preparationPending) =>
      readOpenClawLineageSession(env, id, preparationPending),
    rootAdmissionOpen: (rootSessionId) => openClawRootAdmissionOpen(env, rootSessionId),
    roomReservationPosition: (rootSessionId, insertedSessionId, insertedAt) =>
      openClawRoomReservationPosition(env, rootSessionId, insertedSessionId, insertedAt),
    removeReservation: (insertedSessionId, insertedAt) =>
      removeInteractiveSessionReservation(env, insertedSessionId, insertedAt),
    activateReservation: (insertedSessionId, insertedAt, adapterWorkspaceId) =>
      activateInteractiveSessionReservation(
        env,
        insertedSessionId,
        insertedAt,
        adapterWorkspaceId,
        runtimeAdapterName,
      ),
  };
  return new OpenClawSupervisionService(store);
}

function openClawRootStopService(
  request: Request,
  env: RuntimeEnv,
  serviceUser: User,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): OpenClawRootStopService {
  const supervision = openClawSupervision(env, sessions);
  const store: OpenClawRootStopStore = {
    readRootSession: (rootSessionId) => readInteractiveSession(env, rootSessionId),
    recordStopRequested: (rootSessionId, now) =>
      audit(env, serviceUser, `openclaw session root stop requested ${rootSessionId}`, now),
    closeAdmission: (rootSessionId) => closeOpenClawRootAdmission(env, rootSessionId),
    readRootRows: (rootSessionId, maximumSessions) =>
      readOpenClawRootRows(env, rootSessionId, maximumSessions),
    rollbackReservation: (sessionId, createdAt) =>
      supervision.rollbackReservation(sessionId, createdAt),
    stopSession: (session) =>
      sessions.mutate(request, serviceUser, session.id, "stop").then(() => undefined),
    canReconcileStoppingSession: (sessionId) =>
      canReconcileOpenClawStoppingSession(env, sessionId, sandboxLeasePrefix),
    reconcileSession: (session, now) => runtime.reconcileById(session.id, now),
    readRootCompletion: (rootSessionId) => readOpenClawRootCompletion(env, rootSessionId),
    recordStopped: (rootSessionId, now) =>
      audit(env, serviceUser, `openclaw session root stopped ${rootSessionId}`, now),
  };
  return new OpenClawRootStopService(store, runtimeAdapterName);
}

function openClawMutationService(
  request: Request,
  env: RuntimeEnv,
  serviceUser: User,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): OpenClawMutationService {
  const store: OpenClawMutationStore = {
    now: () => Date.now(),
    recordEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, serviceUser, message, now),
    audit: (message, now) => audit(env, serviceUser, message, now),
    openTerminal: async (session) => {
      const terminalRequest = new Request(request.url, { headers: { upgrade: "websocket" } });
      const upstream = await interactiveTerminalService(env, runtime, sessions).openUpstream(
        terminalRequest,
        serviceUser,
        session,
        120,
        34,
      );
      return upstream.socket;
    },
    stopSession: (sessionId) =>
      sessions.mutate(request, serviceUser, sessionId, "stop").then((result) => result.session),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawMutationService(store);
}

function openClawCreateService(
  env: RuntimeEnv,
  serviceUser: User,
  sessions: InteractiveSessionApplication,
): OpenClawCreateService {
  const admin = new AdminRepository(env);
  const branches = new OpenClawBranchService({
    token: env.GITHUB_TOKEN,
    requireRepo: (repo) => admin.requireRepo(repo),
  });
  const store: OpenClawCreateStore = {
    defaultRuntime: deploymentConfig(env).defaultRuntime,
    now: () => Date.now(),
    preparationSignal: () => AbortSignal.timeout(openClawPreparationTimeoutMs),
    readRequestSession: async (requestId, requestHash) => {
      const session = await readOpenClawRequestSession(env, requestId, requestHash);
      return session ? sessions.present(session, serviceUser) : null;
    },
    prepareBranch: (repo, branch, baseBranch, signal) =>
      branches.ensure(repo, branch, baseBranch, signal),
    createSession: (body, githubToken, options) =>
      sessions.create(serviceUser, body, githubToken, options).then((result) => result.session),
    audit: (message, now) => audit(env, serviceUser, message, now),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawCreateService(store);
}

function openClawController(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
  sessions: InteractiveSessionApplication,
): OpenClawController {
  const serviceUser = openClawServiceUser();
  const store: OpenClawControllerStore = {
    createCrabbox: (input) => openClawCreateService(env, serviceUser, sessions).create(input),
    readRoomRoot: (rootSessionId) => readOpenClawRoomRoot(env, rootSessionId),
    readRoomSessions: (rootSessionId) =>
      readOpenClawRoomSessions(env, rootSessionId, openClawRoomMaxSessions),
    stopSessionRoot: (request, rootSessionId) =>
      openClawRootStopService(request, env, serviceUser, runtime, sessions).stop(rootSessionId),
    requireRootScopedSession: (sessionId, rootSessionId) =>
      openClawSupervision(env, sessions).requireRootScopedSession(sessionId, rootSessionId),
    readTranscriptEvents: (sessionId, maximumEvents) =>
      readInteractiveSessionEventRows(env, sessionId, {
        limit: maximumEvents,
        newest: true,
      }),
    countTranscriptEvents: (sessionId) => countInteractiveSessionEvents(env, sessionId),
    sendMessage: (request, session, input) =>
      openClawMutationService(request, env, serviceUser, runtime, sessions).sendMessage(
        session,
        input,
      ),
    stopSession: (request, sessionId) =>
      openClawMutationService(request, env, serviceUser, runtime, sessions).stopSession(sessionId),
    registerActionSession: (input) =>
      openClawActionSessionRegistrationService(env, serviceUser).register(input),
    now: () => Date.now(),
    createEmbedTicket: (sessionId, expiresAt) => {
      const secret = openClawEmbedTicketSecret(env);
      if (!secret) throw serviceUnavailable("OpenClaw embed ticket secret is not configured");
      return createOpenClawEmbedTicket(secret, sessionId, expiresAt);
    },
    decorateSession: (session) => sessions.present(session, serviceUser),
    browserUrl: (sessionId) => browserSessionUrl(env, sessionId),
    browserEmbedUrl: (sessionId, token) => browserSessionEmbedUrl(env, sessionId, token),
    runnerPtyUrl: (sessionId, agentToken) =>
      buildGitHubActionsRunnerPtyUrl(appCanonicalOrigin, sessionId, agentToken),
  };
  return new OpenClawController(store);
}

function openClawActionSessionRegistrationService(
  env: RuntimeEnv,
  serviceUser: User,
): GitHubActionsSessionRegistrationService {
  const admin = new AdminRepository(env);
  const repository = new GitHubActionsRepository(env);
  const store: GitHubActionsSessionRegistrationStore = {
    now: () => Date.now(),
    newAgentToken,
    hashToken: sha256,
    requireRepo: (repo) => admin.requireRepo(repo),
    readByWorkKey: (workKey) => repository.readByWorkKey(workKey),
    nextSessionId: () => nextInteractiveSessionId(env),
    insertSession: (values) => repository.insertSession(values),
    readById: (id) => repository.readById(id),
    updateSession: (id, values) => repository.updateSession(id, values),
    isConstraintError,
    disconnectRunner: (id) => disconnectGitHubActionsRunner(env, id),
    appendEvent: (id, message, now) =>
      appendInteractiveSessionEvent(env, id, serviceUser, message, now),
    audit: (message, now) => audit(env, serviceUser, message, now),
    readSession: (id) => readInteractiveSession(env, id),
  };
  return new GitHubActionsSessionRegistrationService(store);
}

function githubActionsWorkStateService(env: RuntimeEnv, user: User): GitHubActionsWorkStateService {
  const repository = new GitHubActionsRepository(env);
  const store: GitHubActionsWorkStateStore = {
    now: () => Date.now(),
    readRow: (sessionId) => repository.readById(sessionId),
    persist: (sessionId, values) => repository.updateSession(sessionId, values),
    appendEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
    disconnectRunner: (sessionId) => disconnectGitHubActionsRunner(env, sessionId),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
  };
  return new GitHubActionsWorkStateService(store);
}

function githubActionsRunnerConnectionService(
  env: RuntimeEnv,
  user: User,
): GitHubActionsRunnerConnectionService {
  const repository = new GitHubActionsRepository(env);
  const store: GitHubActionsRunnerConnectionStore = {
    now: () => Date.now(),
    persist: (sessionId, values) => repository.updateSession(sessionId, values),
    appendEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
  };
  return new GitHubActionsRunnerConnectionService(store);
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

function agentSessionAuthentication(env: RuntimeEnv): AgentSessionAuthenticator {
  const store: AgentSessionAuthenticationStore = {
    readCredential: (id) => readAgentSessionCredential(env, id),
    hashToken: sha256,
  };
  return new AgentSessionAuthenticator(store);
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

async function disconnectGitHubActionsRunner(env: RuntimeEnv, id: string): Promise<void> {
  const stub = githubActionsRelayStub(env, id);
  if (!stub) return;
  const response = await stub.fetch(
    "https://crabfleet.internal/api/session-control/github-actions/disconnect-runner",
    { method: "POST" },
  );
  if (!response.ok) throw serviceUnavailable("GitHub Actions relay is unavailable");
}

async function updateGitHubActionsWorkState(
  request: Request,
  env: RuntimeEnv,
  id: string,
  sessions: InteractiveSessionApplication,
): Promise<{ session: InteractiveSession }> {
  const { session, user } = await agentSessionAuthentication(env).require(request, id);
  const body = await readJson<GitHubActionsWorkStateInput>(request);
  const current = await githubActionsWorkStateService(env, user).update(session, body);
  return {
    session: sessions.present(current, user),
  };
}

async function githubActionsRunnerPty(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("websocket upgrade required");
  }
  const { session, user } = await agentSessionAuthentication(env).require(request, id, {
    allowQueryToken: true,
  });
  const stub = githubActionsRelayStub(env, id);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  await githubActionsRunnerConnectionService(env, user).connect(session);
  return stub.fetch("https://crabfleet.internal/api/session-control/github-actions/runner", {
    headers: { upgrade: "websocket" },
  });
}

async function appendInteractiveSessionEvent(
  env: RuntimeEnv,
  id: string,
  user: User,
  message: string,
  now = Date.now(),
): Promise<void> {
  await appendInteractiveSessionEventRecord(env, {
    sessionId: id,
    actor: actor(user),
    message,
    now,
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
