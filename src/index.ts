import { ContainerProxy, Sandbox as CloudflareSandboxBase } from "@cloudflare/sandbox";
import { buildFleetState, type FleetState } from "./fleet-state";
import { buildGitHubActionsRunnerPtyUrl, githubActionsRuntime } from "./github-actions-runtime";
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
import { runtimeAdapterBrowserVncUrl, runtimeAdapterName } from "./runtime-adapter";
import { createOpenClawEmbedTicket, openClawRoomMaxSessions } from "./openclaw-service";
import type { TrustedProxyAuthResult } from "./trusted-proxy-auth";
import {
  browserAppOrigin,
  browserSessionEmbedUrl,
  browserSessionShareUrl,
  browserSessionUrl,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
} from "./worker/deployment";
import type { RuntimeEnv } from "./worker/env";
import type { User } from "./worker/models";
import {
  badRequest,
  forbidden,
  json,
  notFound,
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
import {
  GitHubActionsSessionStopService,
  type GitHubActionsSessionStopStore,
} from "./worker/github-actions-session-stop";
import { GitHubActionsRepository } from "./worker/github-actions-repository";
import {
  GitHubActionsWorkStateService,
  type GitHubActionsWorkStateInput,
  type GitHubActionsWorkStateStore,
} from "./worker/github-actions-session-work-state";
import {
  interactiveSession,
  interactiveSessionEvent,
  type InteractiveSession,
  type InteractiveSessionEvent,
  type InteractiveSessionLogArchive,
} from "./worker/session-model";
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
import {
  isSandboxInteractiveSession,
  sandboxLeaseInfo,
  sandboxLeasePrefix,
} from "./worker/sandbox-lease";
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
  InteractiveSessionLineageService,
  type InteractiveSessionLineageStore,
} from "./worker/session-lineage";
import {
  InteractiveSessionCreationService,
  type InteractiveSessionCreateOptions,
  type InteractiveSessionCreationStore,
} from "./worker/session-creation";
import {
  buildInteractiveSessionReservationValues,
  countInteractiveSessionEvents,
  insertInteractiveSessionReservation,
  markInteractiveSessionPendingAdapter,
  persistGitHubActionsSessionStop,
  persistInteractiveSessionEventMutation,
  persistInteractiveSessionProvisionResult,
  readAgentSessionCredential,
  readInteractiveSessionTerminalCleanupIntent,
  readInteractiveSessionEventRows,
  readInteractiveSessionLogArchives,
  readInteractiveSessionRecord as readInteractiveSession,
  readInteractiveSessionRecords,
  readInteractiveSessionShareCredential,
  readRuntimeAdapterCreatePending,
} from "./worker/session-repository";
import { nextInteractiveSessionId } from "./worker/session-id-repository";
import {
  InteractiveSessionAttachService,
  type InteractiveSessionAttachStore,
} from "./worker/session-attach";
import {
  canChangeInteractiveSessionMultiplayer,
  canControlInteractiveSession,
  canManageInteractiveSession,
  delegatedInteractiveSessionControlAvailable,
} from "./worker/session-access";
import { presentInteractiveSession } from "./worker/session-presentation";
import {
  isOpenClawEmbedSessionToken,
  openClawEmbedTicketSecret,
} from "./worker/openclaw-embed-access";
import { archiveInteractiveSessionLogs, sessionLogTranscript } from "./worker/session-log-archive";
import { appendInteractiveSessionEventRecord } from "./worker/session-events";
import { createInteractiveSessionCleanupService } from "./worker/session-cleanup";
import { finalizeTerminalInteractiveSession } from "./worker/session-terminal-finalization";
import {
  InteractiveSessionMetadataService,
  isInteractiveSessionMetadataAction,
  type InteractiveSessionMetadataStore,
  type InteractiveSessionSummaryInput,
} from "./worker/session-metadata";
import {
  InteractiveSessionStopService,
  type InteractiveSessionStopStore,
} from "./worker/session-stop";
import {
  RuntimeAdapterStopService,
  type RuntimeAdapterStopStore,
} from "./worker/session-runtime-adapter-stop";
import {
  SharedSessionService,
  type SharedSessionServiceStore,
} from "./worker/shared-session-service";
import { safeProviderError } from "./worker/provisioning/result";
import {
  confirmRuntimeAdapterRelease,
  persistRuntimeAdapterStopEvidence,
} from "./worker/provisioning/runtime-adapter-repository";
import { queueSandboxCredentialPolicyCleanup } from "./worker/sandbox-credential-policy-repository";
import { stageTerminalCredentialPolicyCleanupById } from "./worker/sandbox-credential-policy-cleanup";
import { reconcileSandboxCredentialPolicyCleanupBatch as reconcileCredentialPolicyCleanupBatch } from "./worker/sandbox-credential-policy-cleanup-service";
import {
  resolveInteractiveSessionCreateRequest,
  type InteractiveSessionCreateRequest,
} from "./worker/session-create-request";
import {
  createInteractiveSessionReservationContext,
  newAgentToken,
} from "./worker/session-reservation-context";
import { SshGateway } from "./worker/ssh-gateway";
import { configuredRuntimeAdapterControlPlane } from "./worker/runtime-adapter-preflight";
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

      const runtime = runtimeApplication(env);
      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (authRequest) => githubLogin(authRequest, env),
        githubCallback: (authRequest) => githubCallback(authRequest, env),
        sshLink: (authRequest, code, requestAuth) =>
          sshGateway(env, runtime).link(authRequest, code, requestAuth),
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
        return await api(request, env, context, trustedProxy, runtime);
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
    runtimeApplication(env).schedule(context);
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function api(
  request: Request,
  env: RuntimeEnv,
  context: ExecutionContext,
  requestAuth: TrustedProxyAuthResult,
  runtime: RuntimeApplication,
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
    serviceSessionRouteDependencies(env, runtime),
  );
  if (serviceSessionResponse) return serviceSessionResponse;

  const openClawResponse = await handleOpenClawRoute(request, url, {
    controller: openClawController(env, runtime),
    automationTokens: [env.CRABBOX_OPENCLAW_TOKEN],
    roomTokens: [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN],
  });
  if (openClawResponse) return openClawResponse;

  const sessionIngressResponse = await handleSessionIngressRoute(
    request,
    url,
    sessionIngressRouteDependencies(env, requestAuth, runtime),
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
    controlPlaneRouteDependencies(env, context, runtime),
  );
  if (controlPlaneResponse) return controlPlaneResponse;

  const browserSessionResponse = await handleBrowserSessionRoute(
    request,
    url,
    user,
    browserSessionRouteDependencies(env, runtime),
  );
  if (browserSessionResponse) return browserSessionResponse;

  return json({ error: "not found" }, { status: 404 });
}

function controlPlaneRouteDependencies(
  env: RuntimeEnv,
  context: ExecutionContext,
  runtime: RuntimeApplication,
): ControlPlaneRouteDependencies {
  const admin = adminService(env);
  return {
    readState: (request, user) => readState(request, env, user, runtime, context),
    readFleet: (user) => readFleetState(env, user, runtime, undefined, context),
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
): SessionIngressRouteDependencies {
  const sharedSessions = sharedSessionService(env);
  return {
    readSharedSession: (sessionId, token) => sharedSessions.read(sessionId, token),
    openTerminal: async (request) =>
      interactiveTerminalService(env, runtime).open(
        request,
        await terminalHubUser(request, env, requestAuth, runtime),
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
): BrowserSessionRouteDependencies {
  const creation = new BrowserSessionCreationService({
    readGitHubToken: (request, user) => sessionGitHubToken(request, env, user.subject),
    createSession: (user, input, githubToken) =>
      createInteractiveSessionFromInput(env, user, input, githubToken, {}, runtime).then(
        (result) => result.session,
      ),
  });
  return {
    createSession: (request, user) => creation.create(request, user),
    cleanupSessions: (request, user) => cleanupInteractiveSessions(request, env, user, runtime),
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId, runtime),
    presentSession: (session, user) => decorateInteractiveSession(session, user, env),
    readLogs: (user, sessionId) => readInteractiveSessionLogBundle(env, user, sessionId),
    readTranscript: (user, sessionId) => interactiveSessionTranscriptResponse(env, user, sessionId),
    updateSummary: (user, sessionId, input) =>
      updateInteractiveSessionSummary(env, user, sessionId, input),
    mutateSession: (request, user, sessionId, action) =>
      mutateInteractiveSession(request, env, user, sessionId, action, runtime),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env).restoreCheckpoint(user, sessionId, checkpointId),
    readDiagnostics: (user, sessionId) =>
      sandboxSessionResourceService(env).readDiagnostics(user, sessionId),
    openVnc: (user, sessionId) => interactiveDesktopService(env, runtime).open(user, sessionId),
    uploadClipboard: (request, user, sessionId) =>
      interactiveTerminalService(env, runtime).uploadClipboard(request, user, sessionId),
  };
}

function serviceSessionRouteDependencies(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
): ServiceSessionRouteDependencies {
  return {
    sshAuth: (request) => sshGateway(env, runtime).authenticate(request),
    sshState: (request) => sshGateway(env, runtime).state(request),
    agentState: (request) => agentState(request, env, runtime),
    createSshSession: (request) => sshGateway(env, runtime).createSession(request),
    createAgentSession: (request) => agentCreateInteractiveSession(request, env, runtime),
    updateAgentWorkState: (request, sessionId) =>
      updateGitHubActionsWorkState(request, env, sessionId),
    openAgentRunnerPty: (request, sessionId) => githubActionsRunnerPty(request, env, sessionId),
    requireSshViewer: async (request) => {
      const user = await sshGateway(env, runtime).requireUser(request);
      requireRole(user, "viewer");
      return user;
    },
    requireAgentUser: async (request) =>
      (await agentSessionAuthentication(env).require(request)).user,
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId, runtime),
    presentSession: (session, user) => decorateInteractiveSession(session, user, env),
    mutateSession: (request, user, sessionId, action) =>
      mutateInteractiveSession(request, env, user, sessionId, action, runtime),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env).restoreCheckpoint(user, sessionId, checkpointId),
    readLogs: (user, sessionId) => readInteractiveSessionLogBundle(env, user, sessionId),
    readTranscript: (user, sessionId) => interactiveSessionTranscriptResponse(env, user, sessionId),
    updateSummary: (user, sessionId, input) =>
      updateInteractiveSessionSummary(env, user, sessionId, input),
  };
}

async function terminalHubUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
  runtime: RuntimeApplication,
): Promise<User | null> {
  if (sshGateway(env, runtime).isRequest(request)) {
    return sshGateway(env, runtime).requireUser(request);
  }
  if (agentSessionId(request)) {
    return (await agentSessionAuthentication(env).require(request)).user;
  }
  return optionalUser(request, env, requestAuth);
}

function interactiveTerminalService(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
): InteractiveTerminalService {
  return new InteractiveTerminalService(env, {
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId, runtime),
    reconcileSession: (sessionId, now) => runtime.reconcileById(sessionId, now),
    reconcileIntervalMs: runtimeAdapterReconcileIntervalMs,
    resolveSandboxSession: (request, user, session) =>
      sandboxSessionWithGitHubToken(request, env, user, session, runtime),
  });
}

function interactiveDesktopService(env: RuntimeEnv, runtime: RuntimeApplication) {
  return createInteractiveDesktopService(env, {
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId, runtime),
    delegatedControlAvailable: (session) => canGrantDelegatedControl(env, session),
  });
}

function sandboxSessionResourceService(env: RuntimeEnv) {
  return createSandboxSessionResourceService(env, {
    presentSession: (session, user) => decorateInteractiveSession(session, user, env),
    delegatedControlAvailable: (session) => canGrantDelegatedControl(env, session),
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

function sshGateway(env: RuntimeEnv, runtime: RuntimeApplication): SshGateway {
  return new SshGateway(env, {
    readState: (request, user) => readState(request, env, user, runtime),
    createSession: (user, body, githubToken) =>
      createInteractiveSessionFromInput(env, user, body, githubToken, {}, runtime),
    audit: (user, message, now) => audit(env, user, message, now),
  });
}

async function agentState(
  request: Request,
  env: RuntimeEnv,
  runtime: RuntimeApplication,
): Promise<Record<string, unknown>> {
  const { session, user } = await agentSessionAuthentication(env).require(request);
  const state = await readState(request, env, user, runtime);
  return { ...state, agent: { sessionId: session.id, rootSessionId: session.rootSessionId } };
}

async function agentCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  runtime: RuntimeApplication,
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
  const result = await createInteractiveSessionFromInput(
    env,
    user,
    body,
    undefined,
    {
      createdBy: `session:${parent.id}`,
      owner: parent.owner,
      parentSessionId: parent.id,
      rootSessionId: parent.rootSessionId || parent.id,
    },
    runtime,
  );
  await audit(
    env,
    user,
    `agent session ${parent.id} created child ${result.session.id}`,
    Date.now(),
  );
  return result;
}

function runtimeApplication(env: RuntimeEnv): RuntimeApplication {
  let runtime: RuntimeApplication;
  runtime = new RuntimeApplication(env, {
    rollbackReservation: (sessionId, createdAt) =>
      openClawSupervision(env, runtime).rollbackReservation(sessionId, createdAt),
  });
  return runtime;
}

function openClawSupervision(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
): OpenClawSupervisionService {
  const store: OpenClawSupervisionStore = {
    readSession: (id) => readInteractiveSession(env, id),
    refreshSession: (id) => readFreshInteractiveSession(env, id, runtime),
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
): OpenClawRootStopService {
  const supervision = openClawSupervision(env, runtime);
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
      mutateInteractiveSession(request, env, serviceUser, session.id, "stop", runtime).then(
        () => undefined,
      ),
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
): OpenClawMutationService {
  const store: OpenClawMutationStore = {
    now: () => Date.now(),
    recordEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, serviceUser, message, now),
    audit: (message, now) => audit(env, serviceUser, message, now),
    openTerminal: async (session) => {
      const terminalRequest = new Request(request.url, { headers: { upgrade: "websocket" } });
      const upstream = await interactiveTerminalService(env, runtime).openUpstream(
        terminalRequest,
        serviceUser,
        session,
        120,
        34,
      );
      return upstream.socket;
    },
    stopSession: (sessionId) =>
      mutateInteractiveSession(request, env, serviceUser, sessionId, "stop", runtime).then(
        (result) => result.session,
      ),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawMutationService(store);
}

function openClawCreateService(
  env: RuntimeEnv,
  serviceUser: User,
  runtime: RuntimeApplication,
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
      return session ? decorateInteractiveSession(session, serviceUser, env) : null;
    },
    prepareBranch: (repo, branch, baseBranch, signal) =>
      branches.ensure(repo, branch, baseBranch, signal),
    createSession: (body, githubToken, options) =>
      createInteractiveSessionFromInput(env, serviceUser, body, githubToken, options, runtime).then(
        (result) => result.session,
      ),
    audit: (message, now) => audit(env, serviceUser, message, now),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawCreateService(store);
}

function openClawController(env: RuntimeEnv, runtime: RuntimeApplication): OpenClawController {
  const serviceUser = openClawServiceUser();
  const store: OpenClawControllerStore = {
    createCrabbox: (input) => openClawCreateService(env, serviceUser, runtime).create(input),
    readRoomRoot: (rootSessionId) => readOpenClawRoomRoot(env, rootSessionId),
    readRoomSessions: (rootSessionId) =>
      readOpenClawRoomSessions(env, rootSessionId, openClawRoomMaxSessions),
    stopSessionRoot: (request, rootSessionId) =>
      openClawRootStopService(request, env, serviceUser, runtime).stop(rootSessionId),
    requireRootScopedSession: (sessionId, rootSessionId) =>
      openClawSupervision(env, runtime).requireRootScopedSession(sessionId, rootSessionId),
    readTranscriptEvents: (sessionId, maximumEvents) =>
      readInteractiveSessionEventRows(env, sessionId, {
        limit: maximumEvents,
        newest: true,
      }),
    countTranscriptEvents: (sessionId) => countInteractiveSessionEvents(env, sessionId),
    sendMessage: (request, session, input) =>
      openClawMutationService(request, env, serviceUser, runtime).sendMessage(session, input),
    stopSession: (request, sessionId) =>
      openClawMutationService(request, env, serviceUser, runtime).stopSession(sessionId),
    registerActionSession: (input) =>
      openClawActionSessionRegistrationService(env, serviceUser).register(input),
    now: () => Date.now(),
    createEmbedTicket: (sessionId, expiresAt) => {
      const secret = openClawEmbedTicketSecret(env);
      if (!secret) throw serviceUnavailable("OpenClaw embed ticket secret is not configured");
      return createOpenClawEmbedTicket(secret, sessionId, expiresAt);
    },
    decorateSession: (session) => decorateInteractiveSession(session, serviceUser, env),
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
    readInteractiveSessions(env, user),
    user.role === "owner" ? workflowService(env).summaries() : Promise.resolve([]),
  ]);
  const repoNames = sortRepos(repos, deploymentConfig(env).preferredRepo);
  const fleet = await readFleetState(env, user, runtime, interactiveSessions);

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
  sessions?: InteractiveSession[],
  context?: ExecutionContext,
): Promise<FleetState> {
  const deployment = deploymentConfig(env);
  if (!sessions) await runtime.reconcileSessions(Date.now(), context);
  const [interactiveSessions, policyResult] = await Promise.all([
    sessions ? Promise.resolve(sessions) : readInteractiveSessions(env, user),
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

async function createInteractiveSessionFromInput(
  env: RuntimeEnv,
  user: User,
  body: InteractiveSessionCreateRequest,
  githubToken: string | undefined,
  options: InteractiveSessionCreateOptions,
  runtime: RuntimeApplication,
): Promise<{ session: InteractiveSession }> {
  const supervision = openClawSupervision(env, runtime);
  return {
    session: await interactiveSessionCreationService(env, user, supervision, runtime).create(
      body,
      githubToken,
      options,
    ),
  };
}

function interactiveSessionLineageService(env: RuntimeEnv): InteractiveSessionLineageService {
  const store: InteractiveSessionLineageStore = {
    readSession: (id) => readInteractiveSession(env, id),
    canManage: canManageInteractiveSession,
  };
  return new InteractiveSessionLineageService(store);
}

function interactiveSessionCreationService(
  env: RuntimeEnv,
  user: User,
  supervision: OpenClawSupervisionService,
  runtime: RuntimeApplication,
): InteractiveSessionCreationService {
  const admin = new AdminRepository(env);
  const store: InteractiveSessionCreationStore = {
    now: () => Date.now(),
    defaultIdentity: () => {
      const identity = actor(user);
      return { owner: identity, createdBy: identity };
    },
    resolveRequest: (body, identity) => resolveInteractiveSessionCreateRequest(env, body, identity),
    requireRepo: (repo) => admin.requireRepo(repo),
    resolveLineage: (parentSessionId, rootSessionId) =>
      interactiveSessionLineageService(env).resolve(user, parentSessionId, rootSessionId),
    supervisedRootForCreate: (createdBy, lineage) =>
      supervision.supervisedRootForCreate(createdBy, lineage),
    nextSessionId: () => nextInteractiveSessionId(env),
    createReservationContext: (request, session) =>
      createInteractiveSessionReservationContext(env, request, session),
    insertReservation: (input, replay) =>
      insertInteractiveSessionReservation(
        env,
        buildInteractiveSessionReservationValues(input),
        replay,
      ),
    provisionManaged: (request, agentToken, ownership) =>
      runtime.provisioning().provisionManaged(request, agentToken, ownership),
    auditCreated: (sessionId, request, now) =>
      audit(
        env,
        user,
        `interactive session created ${sessionId} repo=${request.repo} runtime=${request.runtime}`,
        now,
      ),
    decorateSession: (session) => decorateInteractiveSession(session, user, env),
    enforceSupervision: (rootSessionId, insertedSessionId, insertedAt) =>
      supervision.enforceRoomSessionLimitAfterInsert(rootSessionId, insertedSessionId, insertedAt),
    rollbackReservation: (insertedSessionId, insertedAt) =>
      supervision.rollbackReservation(insertedSessionId, insertedAt),
    activateReservation: (insertedSessionId, insertedAt, adapterWorkspaceId) =>
      supervision.requireReservationActivation(insertedSessionId, insertedAt, adapterWorkspaceId),
    recordRequest: (insertedSessionId, insertedAt) =>
      appendInteractiveSessionEvent(
        env,
        insertedSessionId,
        user,
        "interactive workspace requested",
        insertedAt,
      ),
    isConstraintError,
    readRequestReplay: async (requestId, requestHash) => {
      const session = await readOpenClawRequestSession(env, requestId, requestHash);
      return session ? decorateInteractiveSession(session, user, env) : null;
    },
    persistProvisionResult: (input, result) =>
      persistInteractiveSessionProvisionResult(env, input, result),
    markPendingAdapter: (input) => markInteractiveSessionPendingAdapter(env, input),
    recordProvisionEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
    finalizeTerminal: (sessionId, status, now) =>
      finalizeTerminalInteractiveSession(env, sessionId, status, now),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
    stopSupersededAdapter: (sessionId, adapterWorkspaceId, createPending, now) =>
      runtime.release().stopSuperseded({
        sessionId,
        adapterWorkspaceId,
        createPending,
        now,
      }),
    cleanupSupersededSandbox: async (sessionId, leaseId) => {
      await queueSandboxCredentialPolicyCleanup(
        env,
        sessionId,
        sandboxLeaseInfo({ id: sessionId, leaseId }).sandboxId,
      );
      await reconcileCredentialPolicyCleanupBatch(env, Date.now(), sessionId);
    },
  };
  return new InteractiveSessionCreationService(store, {
    adapterName: runtimeAdapterName,
    sandboxLeasePrefix,
    maximumAttempts: 3,
  });
}

async function cleanupInteractiveSessions(
  request: Request,
  env: RuntimeEnv,
  user: User,
  runtime: RuntimeApplication,
): Promise<{ state: Record<string, unknown>; removedIds: string[] }> {
  const body = await readJson<{ ids?: unknown }>(request);
  const ids = Array.isArray(body.ids)
    ? [...new Set(body.ids.map((id) => clean(String(id), 80)).filter(Boolean))]
    : [];
  const cleanup = createInteractiveSessionCleanupService(env);
  const removedIds = await cleanup.cleanup(ids, (row) =>
    canManageInteractiveSession(user, interactiveSession(row, [])),
  );
  if (removedIds.length) {
    await audit(env, user, `interactive sessions cleaned ${removedIds.join(",")}`, Date.now());
  }
  return { state: await readState(request, env, user, runtime), removedIds };
}

function interactiveSessionAttachService(env: RuntimeEnv): InteractiveSessionAttachService {
  const store: InteractiveSessionAttachStore = {
    persist: (session, actorName, transition, now) =>
      persistInteractiveSessionEventMutation(
        env,
        session,
        actorName,
        transition.message,
        {
          status: transition.status,
          last_seen_at: transition.lastSeenAt,
        },
        now,
      ),
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
  };
  return new InteractiveSessionAttachService(store);
}

function interactiveSessionMetadataService(
  env: RuntimeEnv,
  user: User,
): InteractiveSessionMetadataService {
  const store: InteractiveSessionMetadataStore = {
    persist: (session, actorName, message, values, now) =>
      persistInteractiveSessionEventMutation(env, session, actorName, message, values, now),
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
    audit: (message, now) => audit(env, user, message, now),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
  };
  return new InteractiveSessionMetadataService(store);
}

function githubActionsSessionStopService(env: RuntimeEnv): GitHubActionsSessionStopService {
  const store: GitHubActionsSessionStopStore = {
    persist: (session, actorName, now) =>
      persistGitHubActionsSessionStop(env, session, actorName, githubActionsRuntime, now),
    disconnect: (sessionId) => disconnectGitHubActionsRunner(env, sessionId),
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
    finalize: (sessionId, now) =>
      finalizeTerminalInteractiveSession(env, sessionId, "stopped", now),
  };
  return new GitHubActionsSessionStopService(store);
}

function interactiveSessionRuntimeAdapterStopService(
  env: RuntimeEnv,
  runtime: RuntimeApplication,
): RuntimeAdapterStopService {
  const store: RuntimeAdapterStopStore = {
    claimStop: (session, actorName, now) =>
      persistInteractiveSessionEventMutation(
        env,
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
          control_requested_by: null,
          control_requested_at: null,
          control_granted_at: null,
          control_expires_at: null,
        },
        now,
      ),
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
    stopWorkspace: (sessionId, adapterWorkspaceId) =>
      runtime.workspaceLifecycle().stopForSession(sessionId, adapterWorkspaceId),
    providerError: (error, adapterWorkspaceId) => safeProviderError(error, [adapterWorkspaceId]),
    persistEvidence: (sessionId, adapterWorkspaceId, message, now, reconcileError, actorName) =>
      persistRuntimeAdapterStopEvidence(
        env,
        sessionId,
        adapterWorkspaceId,
        message,
        now,
        reconcileError,
        actorName,
      ),
    readCreatePending: (sessionId, adapterWorkspaceId) =>
      readRuntimeAdapterCreatePending(env, sessionId, runtimeAdapterName, adapterWorkspaceId),
    confirmRelease: (sessionId, adapterWorkspaceId, now, message) =>
      confirmRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message),
    now: Date.now,
  };
  return new RuntimeAdapterStopService(store, runtimeAdapterName);
}

function interactiveSessionStopService(
  env: RuntimeEnv,
  user: User,
  runtime: RuntimeApplication,
): InteractiveSessionStopService {
  const store: InteractiveSessionStopStore = {
    isSandbox: isSandboxInteractiveSession,
    stageTerminalCleanup: (sessionId, status, message, now) =>
      stageTerminalCredentialPolicyCleanupById(env, sessionId, status, message, now),
    reconcileCleanup: (sessionId, now) =>
      reconcileCredentialPolicyCleanupBatch(env, now, sessionId),
    readTerminalCleanupIntent: (sessionId) =>
      readInteractiveSessionTerminalCleanupIntent(env, sessionId),
    recordEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
    finalizeTerminal: (sessionId, status, now) =>
      finalizeTerminalInteractiveSession(env, sessionId, status, now),
    stopGitHubActions: (session, actorName, now) =>
      githubActionsSessionStopService(env).stop(session, actorName, now),
    stopRuntimeAdapter: (session, actorName, now) =>
      interactiveSessionRuntimeAdapterStopService(env, runtime).stop({
        session,
        actor: actorName,
        now,
      }),
    audit: (message, now) => audit(env, user, message, now),
  };
  return new InteractiveSessionStopService(store, runtimeAdapterName);
}

async function mutateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  user: User,
  id: string,
  action: string,
  runtime: RuntimeApplication,
): Promise<{ session: InteractiveSession; shareUrl?: string }> {
  const session = await readFreshInteractiveSession(env, id, runtime);
  if (!session) throw notFound("interactive session not found");
  const now = Date.now();
  const userActor = actor(user);
  if (action === "attach") {
    const attached = await interactiveSessionAttachService(env).attach({
      session,
      actor: userActor,
      canControl: canControlInteractiveSession(
        user,
        session,
        now,
        canGrantDelegatedControl(env, session),
      ),
      now,
    });
    return {
      session: decorateInteractiveSession(attached, user, env),
    };
  }

  const canManage = canManageInteractiveSession(user, session);
  if (isInteractiveSessionMetadataAction(action)) {
    const delegatedControlAvailable = canGrantDelegatedControl(env, session);
    const result = await interactiveSessionMetadataService(env, user).mutate({
      session,
      action,
      actor: userActor,
      policy: {
        canManage,
        canChangeMultiplayer: canChangeInteractiveSessionMultiplayer(user, session),
        canControl: canControlInteractiveSession(user, session, now, delegatedControlAvailable),
        delegatedControlAvailable,
      },
      now,
    });
    return {
      session: decorateInteractiveSession(result.session, user, env),
      ...(result.shareToken
        ? { shareUrl: browserSessionShareUrl(request, env, id, result.shareToken) }
        : {}),
    };
  }

  if (action === "stop") {
    const stopped = await interactiveSessionStopService(env, user, runtime).stop({
      session,
      actor: userActor,
      canManage,
      now,
    });
    return {
      session: decorateInteractiveSession(stopped, user, env),
    };
  }

  throw badRequest("unknown action");
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

async function readInteractiveSessions(env: RuntimeEnv, user: User): Promise<InteractiveSession[]> {
  return (await readInteractiveSessionRecords(env)).map((session) =>
    decorateInteractiveSession(session, user, env),
  );
}

async function readFreshInteractiveSession(
  env: RuntimeEnv,
  id: string,
  runtime: RuntimeApplication,
): Promise<InteractiveSession | null> {
  await runtime.reconcileById(id).catch((error) => {
    console.error("targeted runtime adapter reconciliation failed", error);
  });
  return readInteractiveSession(env, id);
}

async function readInteractiveSessionLogBundle(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{
  session: InteractiveSession;
  events: InteractiveSessionEvent[];
  archive: InteractiveSessionLogArchive | null;
  eventCount: number;
  truncated: boolean;
}> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  const [events, eventCount, archives] = await Promise.all([
    readInteractiveSessionEventRows(env, id, { limit: 5000, newest: true }),
    countInteractiveSessionEvents(env, id),
    readInteractiveSessionLogArchives(env, [id]),
  ]);
  return {
    session: decorateInteractiveSession(session, user, env),
    events: events.map(interactiveSessionEvent),
    archive: archives.get(id) ?? null,
    eventCount,
    truncated: eventCount > events.length,
  };
}

async function interactiveSessionTranscriptResponse(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<Response> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (!canManageInteractiveSession(user, session)) throw forbidden("session is not visible");

  if (env.SESSION_LOGS && session.logArchive?.transcriptKey) {
    const object = await env.SESSION_LOGS.get(session.logArchive.transcriptKey);
    if (object?.body) {
      return new Response(object.body, {
        headers: securityHeaders("text/markdown; charset=utf-8"),
      });
    }
  }

  const events = await readInteractiveSessionEventRows(env, id, { limit: 10000 });
  return text(sessionLogTranscript(session, events), "text/markdown; charset=utf-8");
}

async function updateInteractiveSessionSummary(
  env: RuntimeEnv,
  user: User,
  id: string,
  input: InteractiveSessionSummaryInput,
): Promise<{ session: InteractiveSession }> {
  return {
    session: decorateInteractiveSession(
      await interactiveSessionMetadataService(env, user).updateSummary({
        ...input,
        sessionId: id,
        actor: actor(user),
        now: Date.now(),
        canManage: (session) => canManageInteractiveSession(user, session),
      }),
      user,
      env,
    ),
  };
}

async function updateGitHubActionsWorkState(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<{ session: InteractiveSession }> {
  const { session, user } = await agentSessionAuthentication(env).require(request, id);
  const body = await readJson<GitHubActionsWorkStateInput>(request);
  const current = await githubActionsWorkStateService(env, user).update(session, body);
  return {
    session: decorateInteractiveSession(current, user, env),
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
): Promise<InteractiveSession & { githubToken?: string }> {
  if (!user?.subject.startsWith("github:")) return session;
  if (actor(user) !== session.owner) return session;
  const githubToken =
    (await sessionGitHubToken(request, env, user.subject)) ??
    (await sshGateway(env, runtime).githubTokenForRequest(request, user));
  return githubToken ? { ...session, githubToken } : session;
}

async function audit(env: RuntimeEnv, user: User, message: string, now: number): Promise<void> {
  await new AuditRepository(env).record(actor(user), message, now);
}

function decorateInteractiveSession(
  session: InteractiveSession,
  user: User,
  env: RuntimeEnv,
): InteractiveSession {
  return presentInteractiveSession(session, user, {
    now: Date.now(),
    delegatedControlAvailable: canGrantDelegatedControl(env, session),
    terminalRouteAvailable: interactiveTerminalRouteAvailable(env, session),
    runtimeProfiles: deploymentConfig(env).runtimeProfiles,
    configuredRuntimeAdapterControlPlane: (profile) =>
      configuredRuntimeAdapterControlPlane(env, profile),
    browserVncUrl: (sessionId) => runtimeAdapterBrowserVncUrl(browserAppOrigin(env), sessionId),
  });
}

function canGrantDelegatedControl(env: RuntimeEnv, session: InteractiveSession): boolean {
  return delegatedInteractiveSessionControlAvailable(Boolean(env.SANDBOX), session);
}

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
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
