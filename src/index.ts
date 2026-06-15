import type { UpdateObject } from "kysely";
import { ContainerProxy, Sandbox as CloudflareSandboxBase } from "@cloudflare/sandbox";
import { buildFleetState, type FleetState } from "./fleet-state";
import { buildGitHubActionsRunnerPtyUrl, githubActionsRuntime } from "./github-actions-runtime";
import {
  APP_HTML,
  GHOSTTY_BROWSER_EXTERNAL_JS,
  GHOSTTY_WEB_JS,
  LOGO_PNG_BASE64,
  OG_IMAGE_PNG_BASE64,
  SPEC_HTML,
  SPEC_MARKDOWN,
  SPEC_V2_HTML,
  SPEC_V2_MARKDOWN,
} from "./generated";
import { appCanonicalOrigin, canonicalAppRedirect, productHostResponse } from "./canonical-host";
import {
  runtimeAdapterBrowserVncUrl,
  runtimeAdapterName,
  runtimeAdapterReplayRequest,
} from "./runtime-adapter";
import { openClawRoomMaxSessions } from "./openclaw-service";
import { trustedProxyPublicOrigin, type TrustedProxyAuthResult } from "./trusted-proxy-auth";
import {
  browserAppOrigin,
  browserSessionUrl,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
} from "./worker/deployment";
import { mapWithConcurrency } from "./worker/concurrency";
import type { RuntimeEnv } from "./worker/env";
import type { Database, InteractiveSessionRow } from "./worker/database";
import type { User } from "./worker/models";
import {
  badRequest,
  conflict,
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
import { GitHubApiError, githubFetch, githubHeaders } from "./worker/github";
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
import { GitHubReferenceService } from "./worker/github-reference-service";
import { createWorkflowService, type WorkflowService } from "./worker/workflow-service";
import { githubRepoParts, normalizeRepo, sortRepos } from "./worker/repositories";
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
  readAbandonedInteractiveSessionReservations,
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
import {
  OpenClawCreateService,
  openClawServiceBranch,
  type OpenClawCreateStore,
} from "./worker/openclaw-create";
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
  readInteractiveSessionLogs,
  readInteractiveSessionRecord as readInteractiveSession,
  readInteractiveSessionRecords,
  readSharedInteractiveSessionRow,
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
} from "./worker/session-access";
import { presentInteractiveSession } from "./worker/session-presentation";
import { scheduleInteractiveSessionReconciliation } from "./worker/scheduled";
import { archiveInteractiveSessionLogs, sessionLogTranscript } from "./worker/session-log-archive";
import { appendInteractiveSessionEventRecord } from "./worker/session-events";
import { createInteractiveSessionCleanupService } from "./worker/session-cleanup";
import {
  claimInteractiveSessionReconciliation,
  InteractiveSessionReconciliationService,
  persistInteractiveSessionReconciliation,
  recordInteractiveSessionReconciliationFailure,
  type InteractiveSessionReconciliationStore,
} from "./worker/session-reconciliation";
import {
  InteractiveSessionReconciliationScheduler,
  readInteractiveSessionReconciliationCandidates,
  readInteractiveSessionReconciliationRow,
  requeueTerminalArchiveObjectBackfill,
  type InteractiveSessionReconciliationSchedulerStore,
} from "./worker/session-reconciliation-scheduler";
import { finalizeTerminalInteractiveSession } from "./worker/session-terminal-finalization";
import {
  InteractiveSessionMetadataService,
  isInteractiveSessionMetadataAction,
  type InteractiveSessionMetadataStore,
} from "./worker/session-metadata";
import {
  InteractiveSessionStopService,
  type InteractiveSessionStopStore,
} from "./worker/session-stop";
import {
  RuntimeAdapterStopService,
  type RuntimeAdapterStopStore,
} from "./worker/session-runtime-adapter-stop";
import { sharedInteractiveSession } from "./worker/session-sharing";
import { InteractiveProvisioningService } from "./worker/provisioning/service";
import { RuntimeAdapterProvisioningService } from "./worker/provisioning/runtime-adapter";
import { InteractiveProvisioningEndpoints } from "./worker/provisioning/endpoints";
import { safeProviderError } from "./worker/provisioning/result";
import {
  clearRuntimeAdapterCreatePending,
  confirmRuntimeAdapterRelease,
  failRuntimeAdapterWorkspaceIdConflict,
  persistRuntimeAdapterStopEvidence,
  stageFailedRuntimeAdapterRelease,
  stageRuntimeAdapterProvision,
} from "./worker/provisioning/runtime-adapter-repository";
import { RuntimeAdapterReleaseService } from "./worker/provisioning/runtime-adapter-release-service";
import { SandboxLifecycleService } from "./worker/provisioning/sandbox-lifecycle";
import {
  standaloneSandboxProvisionTtlMs,
  standaloneSandboxProvisionRequestHashInput,
  StandaloneSandboxProvisioningService,
} from "./worker/provisioning/standalone-sandbox";
import {
  activateStandaloneSandboxProvision,
  claimStandaloneSandboxProvision,
  readStandaloneSandboxProvision,
  stageStandaloneSandboxClaimCleanup,
  stageStandaloneSandboxProvisionCleanup,
} from "./worker/provisioning/standalone-sandbox-repository";
import { queueSandboxCredentialPolicyCleanup } from "./worker/sandbox-credential-policy-repository";
import { stageTerminalCredentialPolicyCleanupById } from "./worker/sandbox-credential-policy-cleanup";
import { reconcileSandboxCredentialPolicyCleanupBatch as reconcileCredentialPolicyCleanupBatch } from "./worker/sandbox-credential-policy-cleanup-service";
import { credentialPolicyProvisioningStaleMs } from "./worker/sandbox-credential-policy-scanner";
import {
  resolveInteractiveSessionCreateRequest,
  type InteractiveSessionCreateRequest,
} from "./worker/session-create-request";
import {
  createInteractiveSessionReservationContext,
  newAgentToken,
} from "./worker/session-reservation-context";
import { SshGateway } from "./worker/ssh-gateway";
import {
  configuredRuntimeAdapterControlPlane,
  requireRegisteredRuntimeAdapterControlPlane,
  runtimeAdapterConfigurationPresent,
} from "./worker/runtime-adapter-preflight";
import {
  readRuntimeAdapterResponseBody,
  runtimeAdapterFetch,
} from "./worker/runtime-adapter-transport";
import {
  RuntimeAdapterWorkspaceLifecycle,
  runtimeAdapterProviderConfigured,
} from "./worker/runtime-adapter-workspaces";
import {
  interactivePtyRouteKind,
  interactiveTerminalTarget,
} from "./worker/session-terminal-route";
import { githubActionsRelayStub, readSandboxFleetPolicies } from "./worker/session-control-do";
import { defaultSandboxEgressHosts, sandboxPlaceholderOpenAIKey } from "./worker/sandbox-outbound";
import { sandboxOutbound } from "./worker/sandbox-outbound-service";
import { createInteractiveDesktopService } from "./worker/interactive-desktop-service";
import { InteractiveTerminalService } from "./worker/interactive-terminal-service";
import { createSandboxSessionResourceService } from "./worker/sandbox-session-resources";

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

const runtimeAdapterReconcileIntervalMs = 15_000;
const runtimeAdapterReconcileLimit = 3;
const runtimeAdapterReconcileConcurrency = 3;
const runtimeAdapterReconcileForegroundBudgetMs = 750;
const openClawPreparationTimeoutMs = 60_000;
const interactiveSessionPreparationStaleMs = 5 * 60_000;

export default {
  async fetch(request: Request, env: RuntimeEnv, context: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    try {
      const ingress = prepareWorkerIngress(request, env);
      request = ingress.request;
      const { trustedProxy } = ingress;

      const productResponse = await productHostResponse(request);
      if (productResponse) return productResponse;

      if (url.pathname === "/healthz") {
        const canonicalRedirect = canonicalAppRedirect(url);
        if (canonicalRedirect) return canonicalRedirect;
        return text("ok\n", "text/plain; charset=utf-8");
      }

      enforceWorkerIngressAuth(ingress);
      if (trustedProxy.kind !== "authenticated") {
        const canonicalRedirect = canonicalAppRedirect(url);
        if (canonicalRedirect) return canonicalRedirect;
      }

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

      if (url.pathname === "/vendor/ghostty-web.js") {
        return text(GHOSTTY_WEB_JS, "text/javascript; charset=utf-8");
      }

      if (url.pathname === "/vendor/__vite-browser-external-2447137e.js") {
        return text(GHOSTTY_BROWSER_EXTERNAL_JS, "text/javascript; charset=utf-8");
      }

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

      const authResponse = await handlePublicAuthRoute(request, url, trustedProxy, {
        githubLogin: (authRequest) => githubLogin(authRequest, env),
        githubCallback: (authRequest) => githubCallback(authRequest, env),
        sshLink: (authRequest, code, requestAuth) =>
          sshGateway(env).link(authRequest, code, requestAuth),
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
        return await api(request, env, context, trustedProxy);
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
    scheduleInteractiveSessionReconciliation(context, {
      now: Date.now,
      reconcile: (now) => interactiveSessionReconciliationScheduler(env).runBatch(now),
      reportError: (error) => {
        console.error("scheduled interactive session reconciliation failed", error);
      },
    });
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function api(
  request: Request,
  env: RuntimeEnv,
  context: ExecutionContext,
  requestAuth: TrustedProxyAuthResult,
): Promise<Response> {
  const url = new URL(request.url);

  const provisioningResponse = await handleProvisioningRoute(
    request,
    url,
    provisioningRouteDependencies(env),
  );
  if (provisioningResponse) return provisioningResponse;

  const serviceSessionResponse = await handleServiceSessionRoute(
    request,
    url,
    serviceSessionRouteDependencies(env),
  );
  if (serviceSessionResponse) return serviceSessionResponse;

  const openClawResponse = await handleOpenClawRoute(request, url, {
    controller: openClawController(env),
    automationTokens: [env.CRABBOX_OPENCLAW_TOKEN],
    roomTokens: [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN],
  });
  if (openClawResponse) return openClawResponse;

  const sessionIngressResponse = await handleSessionIngressRoute(
    request,
    url,
    sessionIngressRouteDependencies(env, requestAuth),
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
    controlPlaneRouteDependencies(env, context),
  );
  if (controlPlaneResponse) return controlPlaneResponse;

  const browserSessionResponse = await handleBrowserSessionRoute(
    request,
    url,
    user,
    browserSessionRouteDependencies(env),
  );
  if (browserSessionResponse) return browserSessionResponse;

  return json({ error: "not found" }, { status: 404 });
}

function controlPlaneRouteDependencies(
  env: RuntimeEnv,
  context: ExecutionContext,
): ControlPlaneRouteDependencies {
  const admin = adminService(env);
  return {
    readState: (request, user) => readState(request, env, user, context),
    readFleet: (user) => readFleetState(env, user, undefined, context),
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

function provisioningRouteDependencies(env: RuntimeEnv): ProvisioningRouteDependencies {
  const endpoints = interactiveProvisioningEndpoints(env);
  return {
    provision: (request) => endpoints.provision(request),
    stop: (request, provisionId) => endpoints.stop(request, provisionId),
    openPty: (request, provisionId) => endpoints.openPty(request, provisionId),
  };
}

function sessionIngressRouteDependencies(
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): SessionIngressRouteDependencies {
  return {
    readSharedSession: (sessionId, token) => readSharedInteractiveSession(env, sessionId, token),
    openTerminal: async (request) =>
      interactiveTerminalService(env).open(
        request,
        await terminalHubUser(request, env, requestAuth),
      ),
  };
}

function browserSessionRouteDependencies(env: RuntimeEnv): BrowserSessionRouteDependencies {
  return {
    createSession: (request, user) => createInteractiveSession(request, env, user),
    cleanupSessions: (request, user) => cleanupInteractiveSessions(request, env, user),
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId),
    presentSession: (session, user) => decorateInteractiveSession(session, user, env),
    readLogs: (user, sessionId) => readInteractiveSessionLogBundle(env, user, sessionId),
    readTranscript: (user, sessionId) => interactiveSessionTranscriptResponse(env, user, sessionId),
    updateSummary: (request, user, sessionId) =>
      updateInteractiveSessionSummary(request, env, user, sessionId),
    mutateSession: (request, user, sessionId, action) =>
      mutateInteractiveSession(request, env, user, sessionId, action),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env).restoreCheckpoint(user, sessionId, checkpointId),
    readDiagnostics: (user, sessionId) =>
      sandboxSessionResourceService(env).readDiagnostics(user, sessionId),
    openVnc: (user, sessionId) => interactiveDesktopService(env).open(user, sessionId),
    uploadClipboard: (request, user, sessionId) =>
      interactiveTerminalService(env).uploadClipboard(request, user, sessionId),
  };
}

function serviceSessionRouteDependencies(env: RuntimeEnv): ServiceSessionRouteDependencies {
  return {
    sshAuth: (request) => sshGateway(env).authenticate(request),
    sshState: (request) => sshGateway(env).state(request),
    agentState: (request) => agentState(request, env),
    createSshSession: (request) => sshGateway(env).createSession(request),
    createAgentSession: (request) => agentCreateInteractiveSession(request, env),
    updateAgentWorkState: (request, sessionId) =>
      updateGitHubActionsWorkState(request, env, sessionId),
    openAgentRunnerPty: (request, sessionId) => githubActionsRunnerPty(request, env, sessionId),
    requireSshViewer: async (request) => {
      const user = await sshGateway(env).requireUser(request);
      requireRole(user, "viewer");
      return user;
    },
    requireAgentUser: async (request) =>
      (await agentSessionAuthentication(env).require(request)).user,
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId),
    presentSession: (session, user) => decorateInteractiveSession(session, user, env),
    mutateSession: (request, user, sessionId, action) =>
      mutateInteractiveSession(request, env, user, sessionId, action),
    listCheckpoints: (user, sessionId) =>
      sandboxSessionResourceService(env).listCheckpoints(user, sessionId),
    createCheckpoint: (user, sessionId) =>
      sandboxSessionResourceService(env).createCheckpoint(user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      sandboxSessionResourceService(env).restoreCheckpoint(user, sessionId, checkpointId),
    readLogs: (user, sessionId) => readInteractiveSessionLogBundle(env, user, sessionId),
    readTranscript: (user, sessionId) => interactiveSessionTranscriptResponse(env, user, sessionId),
    updateSummary: (request, user, sessionId) =>
      updateInteractiveSessionSummary(request, env, user, sessionId),
  };
}

async function terminalHubUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): Promise<User | null> {
  if (sshGateway(env).isRequest(request)) {
    return sshGateway(env).requireUser(request);
  }
  if (agentSessionId(request)) {
    return (await agentSessionAuthentication(env).require(request)).user;
  }
  return optionalUser(request, env, requestAuth);
}

function interactiveTerminalService(env: RuntimeEnv): InteractiveTerminalService {
  return new InteractiveTerminalService(env, {
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId),
    reconcileSession: (sessionId, now) =>
      reconcileExternalInteractiveSessionById(env, sessionId, now),
    reconcileIntervalMs: runtimeAdapterReconcileIntervalMs,
    resolveSandboxSession: (request, user, session) =>
      sandboxSessionWithGitHubToken(request, env, user, session),
  });
}

function interactiveDesktopService(env: RuntimeEnv) {
  return createInteractiveDesktopService(env, {
    readFreshSession: (sessionId) => readFreshInteractiveSession(env, sessionId),
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

function sshGateway(env: RuntimeEnv): SshGateway {
  return new SshGateway(env, {
    readState: (request, user) => readState(request, env, user),
    createSession: (user, body, githubToken) =>
      createInteractiveSessionFromInput(env, user, body, githubToken),
    audit: (user, message, now) => audit(env, user, message, now),
  });
}

async function agentState(request: Request, env: RuntimeEnv): Promise<Record<string, unknown>> {
  const { session, user } = await agentSessionAuthentication(env).require(request);
  const state = await readState(request, env, user);
  return { ...state, agent: { sessionId: session.id, rootSessionId: session.rootSessionId } };
}

async function agentCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
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
  const result = await createInteractiveSessionFromInput(env, user, body, undefined, {
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

async function cleanupAbandonedInteractiveSessionPreparations(
  env: RuntimeEnv,
  now: number,
): Promise<void> {
  const rows = await readAbandonedInteractiveSessionReservations(
    env,
    now - interactiveSessionPreparationStaleMs,
    runtimeAdapterReconcileLimit,
  );
  const supervision = openClawSupervision(env);
  await mapWithConcurrency(rows, runtimeAdapterReconcileConcurrency, async (row) => {
    await supervision.rollbackReservation(row.sessionId, row.createdAt).catch((error) => {
      console.error(`interactive session preparation cleanup failed for ${row.sessionId}`, error);
    });
  });
}

function openClawSupervision(env: RuntimeEnv): OpenClawSupervisionService {
  const store: OpenClawSupervisionStore = {
    readSession: (id) => readInteractiveSession(env, id),
    refreshSession: (id) => readFreshInteractiveSession(env, id),
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
): OpenClawRootStopService {
  const supervision = openClawSupervision(env);
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
      mutateInteractiveSession(request, env, serviceUser, session.id, "stop").then(() => undefined),
    canReconcileStoppingSession: (sessionId) =>
      canReconcileOpenClawStoppingSession(env, sessionId, sandboxLeasePrefix),
    reconcileSession: (session, now) =>
      reconcileExternalInteractiveSessionById(env, session.id, now),
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
): OpenClawMutationService {
  const store: OpenClawMutationStore = {
    now: () => Date.now(),
    recordEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, serviceUser, message, now),
    audit: (message, now) => audit(env, serviceUser, message, now),
    openTerminal: async (session) => {
      const terminalRequest = new Request(request.url, { headers: { upgrade: "websocket" } });
      const upstream = await interactiveTerminalService(env).openUpstream(
        terminalRequest,
        serviceUser,
        session,
        120,
        34,
      );
      return upstream.socket;
    },
    stopSession: (sessionId) =>
      mutateInteractiveSession(request, env, serviceUser, sessionId, "stop").then(
        (result) => result.session,
      ),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawMutationService(store);
}

function openClawCreateService(env: RuntimeEnv, serviceUser: User): OpenClawCreateService {
  const store: OpenClawCreateStore = {
    defaultRuntime: deploymentConfig(env).defaultRuntime,
    now: () => Date.now(),
    preparationSignal: () => AbortSignal.timeout(openClawPreparationTimeoutMs),
    readRequestSession: async (requestId, requestHash) => {
      const session = await readOpenClawRequestSession(env, requestId, requestHash);
      return session ? decorateInteractiveSession(session, serviceUser, env) : null;
    },
    prepareBranch: (repo, branch, baseBranch, signal) =>
      ensureOpenClawServiceBranch(env, repo, branch, baseBranch, signal),
    createSession: (body, githubToken, options) =>
      createInteractiveSessionFromInput(env, serviceUser, body, githubToken, options).then(
        (result) => result.session,
      ),
    audit: (message, now) => audit(env, serviceUser, message, now),
    warn: (event) => console.warn(JSON.stringify(event)),
  };
  return new OpenClawCreateService(store);
}

function openClawController(env: RuntimeEnv): OpenClawController {
  const serviceUser = openClawServiceUser();
  const store: OpenClawControllerStore = {
    createCrabbox: (input) => openClawCreateService(env, serviceUser).create(input),
    readRoomRoot: (rootSessionId) => readOpenClawRoomRoot(env, rootSessionId),
    readRoomSessions: (rootSessionId) =>
      readOpenClawRoomSessions(env, rootSessionId, openClawRoomMaxSessions),
    stopSessionRoot: (request, rootSessionId) =>
      openClawRootStopService(request, env, serviceUser).stop(rootSessionId),
    requireRootScopedSession: (sessionId, rootSessionId) =>
      openClawSupervision(env).requireRootScopedSession(sessionId, rootSessionId),
    readTranscriptEvents: (sessionId, maximumEvents) =>
      readInteractiveSessionEventRows(env, sessionId, {
        limit: maximumEvents,
        newest: true,
      }),
    countTranscriptEvents: (sessionId) => countInteractiveSessionEvents(env, sessionId),
    sendMessage: (request, session, input) =>
      openClawMutationService(request, env, serviceUser).sendMessage(session, input),
    stopSession: (request, sessionId) =>
      openClawMutationService(request, env, serviceUser).stopSession(sessionId),
    registerActionSession: (input) =>
      openClawActionSessionRegistrationService(env, serviceUser).register(input),
    decorateSession: (session) => decorateInteractiveSession(session, serviceUser, env),
    browserUrl: (sessionId) => browserSessionUrl(env, sessionId),
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

async function ensureOpenClawServiceBranch(
  env: RuntimeEnv,
  repoInput: unknown,
  branchInput: unknown,
  baseBranchInput: unknown,
  signal?: AbortSignal,
): Promise<void> {
  const repo = normalizeRepo(repoInput);
  if (!repo) throw badRequest("repo is required");
  const target = githubRepoParts(repo);
  if (!target) throw badRequest("repo must be a GitHub owner/name");
  await new AdminRepository(env).requireRepo(repo);
  const branch = openClawServiceBranch(branchInput, "branch", "main");
  const baseBranch = openClawServiceBranch(baseBranchInput, "baseBranch");
  if (!baseBranch) return;
  if (branch === baseBranch) return;
  if (!env.GITHUB_TOKEN) return;
  const { owner, name } = target;
  const refPath = `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(branch)}`;
  try {
    await githubFetch<{ object: { sha: string } }>(refPath, env.GITHUB_TOKEN, signal);
    return;
  } catch (error) {
    if (!(error instanceof GitHubApiError) || error.status !== 404) throw error;
  }
  const base = await githubFetch<{ object: { sha: string } }>(
    `/repos/${owner}/${name}/git/ref/heads/${encodeURIComponent(baseBranch)}`,
    env.GITHUB_TOKEN,
    signal,
  );
  const response = await fetch(`https://api.github.com/repos/${owner}/${name}/git/refs`, {
    method: "POST",
    body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
    headers: { ...githubHeaders(), authorization: `Bearer ${env.GITHUB_TOKEN}` },
    ...(signal ? { signal } : {}),
  });
  if (response.ok) return;
  if (response.status === 422) {
    await githubFetch<{ object: { sha: string } }>(refPath, env.GITHUB_TOKEN, signal);
    return;
  }
  throw new GitHubApiError(response.status);
}

function agentSessionAuthentication(env: RuntimeEnv): AgentSessionAuthenticator {
  const store: AgentSessionAuthenticationStore = {
    readCredential: (id) => readAgentSessionCredential(env, id),
    hashToken: sha256,
  };
  return new AgentSessionAuthenticator(store);
}

async function reconcileExternalInteractiveSessions(
  env: RuntimeEnv,
  now: number,
  context?: ExecutionContext,
): Promise<void> {
  const reconciliation = interactiveSessionReconciliationScheduler(env)
    .runBatch(now)
    .catch((error) => {
      console.error("interactive session reconciliation failed", error);
    });
  if (!context) {
    await reconciliation;
    return;
  }
  context.waitUntil(reconciliation);
  await Promise.race([
    reconciliation,
    new Promise<void>((resolve) => setTimeout(resolve, runtimeAdapterReconcileForegroundBudgetMs)),
  ]);
}

function interactiveSessionReconciliationScheduler(
  env: RuntimeEnv,
): InteractiveSessionReconciliationScheduler {
  const store: InteractiveSessionReconciliationSchedulerStore = {
    cleanupAbandonedPreparations: (now) => cleanupAbandonedInteractiveSessionPreparations(env, now),
    cleanupCredentialPolicies: (now, sessionId) =>
      reconcileCredentialPolicyCleanupBatch(env, now, sessionId),
    providerConfigured: () => runtimeAdapterProviderConfigured(env),
    requeueTerminalArchiveBackfill: (sessionId) =>
      requeueTerminalArchiveObjectBackfill(env, sessionId, runtimeAdapterReconcileLimit),
    readBatchCandidates: (providerConfigured) =>
      readInteractiveSessionReconciliationCandidates(
        env,
        runtimeAdapterName,
        providerConfigured,
        runtimeAdapterReconcileLimit,
      ),
    readSession: (sessionId) => readInteractiveSessionReconciliationRow(env, sessionId),
    reconcile: (row, now) => reconcileExternalInteractiveSession(env, row, now),
  };
  return new InteractiveSessionReconciliationScheduler(store, {
    adapterName: runtimeAdapterName,
    intervalMs: runtimeAdapterReconcileIntervalMs,
    limit: runtimeAdapterReconcileLimit,
    concurrency: runtimeAdapterReconcileConcurrency,
  });
}

async function reconcileExternalInteractiveSessionById(
  env: RuntimeEnv,
  id: string,
  now = Date.now(),
): Promise<void> {
  await interactiveSessionReconciliationScheduler(env).reconcileById(id, now);
}

async function reconcileExternalInteractiveSession(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  now: number,
): Promise<void> {
  await interactiveSessionReconciliationService(env).reconcile(row, now);
}

function interactiveSessionReconciliationService(
  env: RuntimeEnv,
): InteractiveSessionReconciliationService {
  const runtimeAdapterWorkspaces = runtimeAdapterWorkspaceLifecycle(env);
  const store: InteractiveSessionReconciliationStore = {
    now: Date.now,
    claim: (row, claimAt) => claimInteractiveSessionReconciliation(env, row, claimAt),
    inspect: (row, claimAt) => runtimeAdapterWorkspaces.inspect(row, claimAt),
    persist: (row, inspection, transition, claimAt) =>
      persistInteractiveSessionReconciliation(
        env,
        row,
        inspection,
        transition,
        claimAt,
        runtimeAdapterName,
      ),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
    stopSuperseded: (sessionId, adapterWorkspaceId, createPending, now) =>
      runtimeAdapterReleaseService(env).stopSuperseded({
        sessionId,
        adapterWorkspaceId,
        createPending,
        now,
      }),
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
    finalize: (sessionId, status, now) =>
      finalizeTerminalInteractiveSession(env, sessionId, status, now),
    recordFailure: (row, claimAt, failedAt, error) =>
      recordInteractiveSessionReconciliationFailure(
        env,
        row,
        claimAt,
        failedAt,
        safeProviderError(
          error,
          [row.adapter_workspace_id, row.provider_resource_id],
          [row.attach_url],
        ),
      ),
  };
  return new InteractiveSessionReconciliationService(store, runtimeAdapterName);
}

function runtimeAdapterWorkspaceLifecycle(env: RuntimeEnv): RuntimeAdapterWorkspaceLifecycle {
  return new RuntimeAdapterWorkspaceLifecycle(env, {
    now: Date.now,
    fetch: (input, init) => runtimeAdapterFetch(env, input, init),
    readResponseBody: readRuntimeAdapterResponseBody,
    provisionReplay: (session, owner) =>
      runtimeAdapterProvisioningService(env).provision(runtimeAdapterReplayRequest(session), owner),
    releaseFailed: (sessionId, result) =>
      runtimeAdapterProvisioningService(env).releaseFailed(sessionId, result),
    failWorkspaceIdConflict: (input) => failRuntimeAdapterWorkspaceIdConflict(env, input),
    recordConfirmedRelease: async (sessionId, adapterWorkspaceId, now, message) => {
      await confirmRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message);
    },
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
  });
}

function runtimeAdapterReleaseService(env: RuntimeEnv): RuntimeAdapterReleaseService {
  return new RuntimeAdapterReleaseService({
    clearCreatePending: (sessionId, adapterWorkspaceId) =>
      clearRuntimeAdapterCreatePending(env, sessionId, adapterWorkspaceId),
    stopWorkspace: (sessionId, adapterWorkspaceId) =>
      runtimeAdapterWorkspaceLifecycle(env).stopForSession(sessionId, adapterWorkspaceId),
    confirmRelease: (sessionId, adapterWorkspaceId, now, message) =>
      confirmRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message),
    persistStopEvidence: (sessionId, adapterWorkspaceId, message, now, reconcileError) =>
      persistRuntimeAdapterStopEvidence(
        env,
        sessionId,
        adapterWorkspaceId,
        message,
        now,
        reconcileError,
      ),
    providerError: (error, adapterWorkspaceId) => safeProviderError(error, [adapterWorkspaceId]),
  });
}

async function readState(
  request: Request,
  env: RuntimeEnv,
  user: User,
  context?: ExecutionContext,
): Promise<Record<string, unknown>> {
  await cardLifecycleService(env).reconcileStalledRuns();
  await reconcileExternalInteractiveSessions(env, Date.now(), context);
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
  const fleet = await readFleetState(env, user, interactiveSessions);

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
  sessions?: InteractiveSession[],
  context?: ExecutionContext,
): Promise<FleetState> {
  const deployment = deploymentConfig(env);
  if (!sessions) await reconcileExternalInteractiveSessions(env, Date.now(), context);
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

async function createInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<{ session: InteractiveSession }> {
  const body = await readJson<{
    repo?: string;
    branch?: string;
    runtime?: string;
    command?: string;
    prompt?: string;
    parentSessionId?: string;
    rootSessionId?: string;
    purpose?: string;
    summary?: string;
  }>(request);
  const githubToken = user.subject.startsWith("github:")
    ? await sessionGitHubToken(request, env, user.subject)
    : undefined;
  if (user.subject.startsWith("github:") && !githubToken) {
    throw forbidden("GitHub PR credentials are not connected; sign in with GitHub again");
  }
  return createInteractiveSessionFromInput(env, user, body, githubToken);
}

async function createInteractiveSessionFromInput(
  env: RuntimeEnv,
  user: User,
  body: InteractiveSessionCreateRequest,
  githubToken?: string,
  options: InteractiveSessionCreateOptions = {},
): Promise<{ session: InteractiveSession }> {
  const supervision = openClawSupervision(env);
  return {
    session: await interactiveSessionCreationService(env, user, supervision).create(
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
      interactiveProvisioningService(env).provisionManaged(request, agentToken, ownership),
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
      runtimeAdapterReleaseService(env).stopSuperseded({
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
  return { state: await readState(request, env, user), removedIds };
}

async function mutateInteractiveSessionWithEventAtomically(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
  user: User,
  message: string,
  values: UpdateObject<Database, "interactive_sessions">,
  now = Date.now(),
): Promise<void> {
  if (
    !(await persistInteractiveSessionEventMutation(env, session, actor(user), message, values, now))
  ) {
    throw conflict("interactive session lifecycle changed; retry metadata update");
  }
  await archiveInteractiveSessionLogs(env, session.id, now).catch(() => undefined);
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

async function stopGitHubActionsSession(
  env: RuntimeEnv,
  session: InteractiveSession,
  eventActor: string,
  now: number,
): Promise<boolean> {
  const stopped = await persistGitHubActionsSessionStop(
    env,
    session,
    eventActor,
    githubActionsRuntime,
    now,
  );
  if (!stopped) return false;
  await disconnectGitHubActionsRunner(env, session.id).catch(() => undefined);
  await archiveInteractiveSessionLogs(env, session.id, now).catch(() => undefined);
  await finalizeTerminalInteractiveSession(env, session.id, "stopped", now).catch(() => undefined);
  return true;
}

function interactiveSessionRuntimeAdapterStopService(env: RuntimeEnv): RuntimeAdapterStopService {
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
      runtimeAdapterWorkspaceLifecycle(env).stopForSession(sessionId, adapterWorkspaceId),
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

function interactiveSessionStopService(env: RuntimeEnv, user: User): InteractiveSessionStopService {
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
      stopGitHubActionsSession(env, session, actorName, now),
    stopRuntimeAdapter: (session, actorName, now) =>
      interactiveSessionRuntimeAdapterStopService(env).stop({
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
): Promise<{ session: InteractiveSession; shareUrl?: string }> {
  const session = await readFreshInteractiveSession(env, id);
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
      ...(result.shareToken ? { shareUrl: shareUrl(request, env, id, result.shareToken) } : {}),
    };
  }

  if (action === "stop") {
    const stopped = await interactiveSessionStopService(env, user).stop({
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

function interactiveProvisioningService(env: RuntimeEnv): InteractiveProvisioningService {
  const runtimeAdapter = runtimeAdapterProvisioningService(env);
  const sandbox = new SandboxLifecycleService(env);
  return new InteractiveProvisioningService({
    sandboxAvailable: Boolean(env.SANDBOX),
    runtimeAdapterAvailable: runtimeAdapterConfigurationPresent(env),
    provisionSandbox: (session, agentToken, ownership) =>
      sandbox.provisionReservation(session, agentToken, ownership.lease, ownership.ownership),
    provisionRuntimeAdapter: (session) => runtimeAdapter.provision(session),
  });
}

function runtimeAdapterProvisioningService(env: RuntimeEnv): RuntimeAdapterProvisioningService {
  return new RuntimeAdapterProvisioningService({
    namespace: env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "",
    now: Date.now,
    resolveControlPlane: (profile, registeredControlPlane) =>
      requireRegisteredRuntimeAdapterControlPlane(env, profile, registeredControlPlane),
    stageProvision: (input) => stageRuntimeAdapterProvision(env, input),
    createWorkspace: async ({ url, adapterWorkspaceId, createPayloadJson }) => {
      const response = await runtimeAdapterFetch(env, url, {
        method: "POST",
        headers: { "idempotency-key": adapterWorkspaceId },
        body: createPayloadJson,
      });
      return {
        ok: response.ok,
        status: response.status,
        body: await readRuntimeAdapterResponseBody(response),
      };
    },
    failWorkspaceIdConflict: (input) => failRuntimeAdapterWorkspaceIdConflict(env, input),
    stageFailedRelease: (sessionId, adapterWorkspaceId, message, now) =>
      stageFailedRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, message, now),
    stopWorkspaceForSession: (sessionId, adapterWorkspaceId) =>
      runtimeAdapterWorkspaceLifecycle(env).stopForSession(sessionId, adapterWorkspaceId),
    recordConfirmedRelease: async (sessionId, adapterWorkspaceId, now, message) => {
      await confirmRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message);
    },
    persistStopEvidence: (sessionId, adapterWorkspaceId, message, now) =>
      persistRuntimeAdapterStopEvidence(env, sessionId, adapterWorkspaceId, message, now),
  });
}

function standaloneSandboxProvisioningService(
  env: RuntimeEnv,
): StandaloneSandboxProvisioningService {
  const sandbox = new SandboxLifecycleService(env);
  const provisionTtlMs = standaloneSandboxProvisionTtlMs(env);
  return new StandaloneSandboxProvisioningService({
    now: Date.now,
    requestHash: (session) =>
      sha256(JSON.stringify(standaloneSandboxProvisionRequestHashInput(session))),
    readOwner: (provisionId) => readStandaloneSandboxProvision(env, provisionId),
    stageOwnerCleanup: (owner, message, now) =>
      stageStandaloneSandboxProvisionCleanup(env, owner, message, now),
    reconcileCleanup: (provisionId, now) =>
      reconcileCredentialPolicyCleanupBatch(env, now, provisionId),
    claim: (session, requestHash, now) =>
      claimStandaloneSandboxProvision(
        env,
        session,
        requestHash,
        now,
        credentialPolicyProvisioningStaleMs,
        provisionTtlMs,
      ),
    provision: (session, claim) =>
      sandbox.provisionClaim(session, undefined, claim.lease, claim.fence),
    stageClaimCleanup: (claim, message, now) =>
      stageStandaloneSandboxClaimCleanup(env, claim, message, now),
    queuePolicyCleanup: (provisionId, sandboxId, now) =>
      queueSandboxCredentialPolicyCleanup(env, provisionId, sandboxId, now),
    activate: (provisionId, claim, result, now) =>
      activateStandaloneSandboxProvision(env, provisionId, claim, result, now),
    providerError: safeProviderError,
  });
}

function interactiveProvisioningEndpoints(env: RuntimeEnv): InteractiveProvisioningEndpoints {
  const interactive = interactiveProvisioningService(env);
  const sandbox = new SandboxLifecycleService(env);
  return new InteractiveProvisioningEndpoints(env, {
    provisionManaged: (session, owner) => sandbox.provisionManaged(session, owner),
    provisionStandalone: (session) => standaloneSandboxProvisioningService(env).provision(session),
    supportsStandalone: (runtime) => interactive.supportsStandalone(runtime),
  });
}

async function readInteractiveSessions(env: RuntimeEnv, user: User): Promise<InteractiveSession[]> {
  return (await readInteractiveSessionRecords(env)).map((session) =>
    decorateInteractiveSession(session, user, env),
  );
}

async function readFreshInteractiveSession(
  env: RuntimeEnv,
  id: string,
): Promise<InteractiveSession | null> {
  await reconcileExternalInteractiveSessionById(env, id).catch((error) => {
    console.error("targeted runtime adapter reconciliation failed", error);
  });
  return readInteractiveSession(env, id);
}

async function readSharedInteractiveSession(
  env: RuntimeEnv,
  id: string,
  token: string,
): Promise<{ session: InteractiveSession }> {
  const row = await readSharedInteractiveSessionRow(env, id);
  if (!row || !row.share_token_hash || !token) throw notFound("shared session not found");
  if ((await sha256(token)) !== row.share_token_hash) throw notFound("shared session not found");
  const logs = await readInteractiveSessionLogs(env, [id]);
  const archives = await readInteractiveSessionLogArchives(env, [id]);
  const session = interactiveSession(row, logs.get(id) ?? [], archives.get(id) ?? null);
  return { session: sharedInteractiveSession(session, Date.now()) };
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
  request: Request,
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{ session: InteractiveSession }> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (!canManageInteractiveSession(user, session)) throw forbidden("session is not visible");
  const body = await readJson<{ purpose?: string; summary?: string }>(request);
  const purpose = clean(body.purpose, 500);
  const summary = clean(body.summary, 500);
  if (!purpose && !summary) throw badRequest("summary or purpose is required");
  const now = Date.now();
  await mutateInteractiveSessionWithEventAtomically(
    env,
    session,
    user,
    summary ? "session summary updated" : "session purpose updated",
    {
      ...(purpose ? { purpose } : {}),
      ...(summary ? { summary } : {}),
    },
    now,
  );
  return {
    session: decorateInteractiveSession(
      (await readInteractiveSession(env, id)) as InteractiveSession,
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
): Promise<InteractiveSession & { githubToken?: string }> {
  if (!user?.subject.startsWith("github:")) return session;
  if (actor(user) !== session.owner) return session;
  const githubToken =
    (await sessionGitHubToken(request, env, user.subject)) ??
    (await sshGateway(env).githubTokenForRequest(request, user));
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
  const routeKind = interactivePtyRouteKind(env, session);
  const routeAvailable =
    session.runtime === githubActionsRuntime ||
    (routeKind === "sandbox"
      ? Boolean(env.SANDBOX)
      : Boolean(interactiveTerminalTarget(env, session, routeKind)));
  return presentInteractiveSession(session, user, {
    now: Date.now(),
    delegatedControlAvailable: canGrantDelegatedControl(env, session),
    terminalRouteAvailable: routeAvailable,
    runtimeProfiles: deploymentConfig(env).runtimeProfiles,
    configuredRuntimeAdapterControlPlane: (profile) =>
      configuredRuntimeAdapterControlPlane(env, profile),
    browserVncUrl: (sessionId) => runtimeAdapterBrowserVncUrl(browserAppOrigin(env), sessionId),
  });
}

function canGrantDelegatedControl(env: RuntimeEnv, session: InteractiveSession): boolean {
  if (!env.SANDBOX && isSandboxInteractiveSession(session)) return false;
  return true;
}

function shareUrl(request: Request, env: RuntimeEnv, id: string, token: string): string {
  return `${externalRequestOrigin(request, env)}/sessions/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

function externalRequestOrigin(request: Request, env: RuntimeEnv): string {
  return trustedProxyPublicOrigin(env) ?? new URL(request.url).origin;
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
