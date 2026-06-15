import { sql, type Kysely, type UpdateObject } from "kysely";
import {
  ContainerProxy,
  Sandbox as CloudflareSandboxBase,
  getSandbox,
  type BackupOptions,
  type Sandbox as CloudflareSandbox,
} from "@cloudflare/sandbox";
import {
  attributedTerminalInputPayloads,
  newTerminalInputState,
  terminalSubmittedLine,
  type TerminalInputState,
} from "./terminal-multiplayer";
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
  currentAdapterDesktopConnection,
  runtimeAdapterBrowserVncUrl,
  runtimeAdapterDesktopUrl,
  runtimeAdapterName,
  runtimeAdapterReplayRequest,
  retainedRuntimeAdapterFailureMessage,
  resolveCreateAfterStopRace,
  safeDesktopUrl,
  terminalFailureStatusForAdapter,
  workerOwnedLeaseId,
} from "./runtime-adapter";
import { allocateInteractiveSessionIdSql, formatInteractiveSessionId } from "./session-id";
import { cachedBooleanGrant } from "./terminal-authorization";
import { openClawGitHubRepoParts, openClawRoomMaxSessions } from "./openclaw-service";
import {
  sanitizeTrustedProxyRequest,
  trustedProxyPublicOrigin,
  type TrustedProxyAuthResult,
} from "./trusted-proxy-auth";
import {
  browserAppOrigin,
  browserSessionUrl,
  clientDeploymentConfig,
  defaultPreferredRepo,
  deploymentConfig,
  publicDeploymentConfig,
  selectedRuntimeProfile,
} from "./worker/deployment";
import { clampedSeconds } from "./worker/duration";
import { mapWithConcurrency } from "./worker/concurrency";
import type { RuntimeEnv } from "./worker/env";
import {
  database,
  executeBatch,
  type CompilableQuery,
  type Database,
  type InteractiveSessionRow,
  type RepoWorkflowTable,
  type RunAttemptTable,
} from "./worker/database";
import { type Role, type RunStatus, type User, type WorkflowStatus } from "./worker/models";
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
  unauthorized,
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
import { base64FromBytes, sha256 } from "./worker/crypto";
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
import {
  GitHubActionsWorkStateService,
  type GitHubActionsWorkStateInput,
  type GitHubActionsWorkStateStore,
} from "./worker/github-actions-session-work-state";
import {
  containerCapabilities,
  crabboxCapabilities,
  interactiveSession,
  interactiveSessionEvent,
  runtimeCapabilities,
  type InteractiveSession,
  type InteractiveSessionEvent,
  type InteractiveSessionLogArchive,
  type RuntimeCapabilities,
} from "./worker/session-model";
import { normalizeRepo } from "./worker/repositories";
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
  isCurrentSandboxLease,
  newSandboxLease,
  sandboxLeaseId,
  sandboxLeaseInfo,
  sandboxLeasePrefix,
  sandboxLeaseRefreshStartedAt,
  sandboxLeaseWithoutRefresh,
  type SandboxLease,
  type SandboxLeaseRefreshFence,
} from "./worker/sandbox-lease";
import { readOpenClawRequestSession } from "./worker/openclaw-request";
import {
  activateInteractiveSessionReservation,
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
  readInteractiveSessionTerminalCleanupIntent,
  readInteractiveSessionEventRows,
  readInteractiveSessionLogArchives,
  readInteractiveSessionLogs,
  readInteractiveSessionRecord as readInteractiveSession,
  readInteractiveSessionRecords,
  readSharedInteractiveSessionRow,
  readRuntimeAdapterCreatePending,
} from "./worker/session-repository";
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
import { failedProvision, safeProviderError } from "./worker/provisioning/result";
import {
  failRuntimeAdapterWorkspaceIdConflict,
  persistRuntimeAdapterStopEvidence,
  stageFailedRuntimeAdapterRelease,
  stageRuntimeAdapterProvision,
} from "./worker/provisioning/runtime-adapter-repository";
import { ManagedSandboxProvisioningService } from "./worker/provisioning/sandbox";
import {
  claimManagedSandboxProvision,
  commitManagedSandboxProvision,
} from "./worker/provisioning/sandbox-repository";
import {
  isManagedInteractiveSessionId,
  standaloneSandboxDefaultTtlSeconds,
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
import type {
  InteractiveProvisionRequest,
  InteractiveProvisionResult,
} from "./worker/provisioning/types";
import {
  activeSandboxCredentialPolicyCondition,
  activeSandboxCredentialPolicyGeneration,
  queueSandboxCredentialPolicyCleanup,
  type SandboxCredentialPolicyOwnershipFence,
} from "./worker/sandbox-credential-policy-repository";
import { stageTerminalCredentialPolicyCleanupById } from "./worker/sandbox-credential-policy-cleanup";
import { reconcileSandboxCredentialPolicyCleanupBatch as reconcileCredentialPolicyCleanupBatch } from "./worker/sandbox-credential-policy-cleanup-service";
import {
  ensureSandboxCredentialPolicy,
  registerSandboxCredentialPolicy,
} from "./worker/sandbox-credential-policy-registration-service";
import { credentialPolicyProvisioningStaleMs } from "./worker/sandbox-credential-policy-scanner";
import {
  createSandboxSession,
  openSandboxTerminalResponse,
  sandboxSetupSessionId,
  sandboxTerminalShellPath,
  sandboxWorkdir,
  setupSandboxTerminalSession,
  terminalSize,
  type SandboxRuntimeSession,
} from "./worker/sandbox-runtime";
import {
  interactiveCommand,
  interactiveSessionPurpose,
  interactiveSessionSummary,
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
  interactiveTerminalFetch,
  readRuntimeAdapterResponseBody,
  runtimeAdapterFetch,
} from "./worker/runtime-adapter-transport";
import {
  RuntimeAdapterWorkspaceLifecycle,
  runtimeAdapterProviderConfigured,
} from "./worker/runtime-adapter-workspaces";
import {
  interactivePtyRouteKind,
  interactiveTerminalHeaders,
  interactiveTerminalTarget,
} from "./worker/session-terminal-route";
import {
  TerminalHub,
  type TerminalHubSubscription,
  type TerminalUpstream,
} from "./worker/terminal-hub";
import {
  githubActionsRelayStub,
  readSandboxFleetPolicies,
  sandboxControlStub,
  type SandboxCheckpoint,
} from "./worker/session-control-do";
import { defaultSandboxEgressHosts, sandboxPlaceholderOpenAIKey } from "./worker/sandbox-outbound";
import { sandboxOutbound } from "./worker/sandbox-outbound-service";
import {
  bridgeWebSockets,
  terminalOutputAcknowledgements,
} from "./worker/terminal-websocket-bridge";

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

type GitHubIssuePayload = {
  number: number;
  title: string;
  state: string;
  html_url: string;
  body: string | null;
  user: { login: string } | null;
  updated_at: string;
  pull_request?: unknown;
};

type GitHubGraphqlRefPayload = {
  __typename: "Issue" | "PullRequest";
  number: number;
  title: string;
  state: string;
  url: string;
  body: string | null;
  author: { login: string } | null;
  updatedAt: string;
};

type GitHubReference = {
  repo: string;
  number: number;
  title: string;
  source: "Issue" | "PR";
  state: string;
  url: string;
  author: string | null;
  updatedAt: string;
  body: string;
};

type GitHubContentPayload = {
  content?: string;
  encoding?: string;
  sha?: string;
};

type WorkflowConfig = {
  runtime?: string;
  policy?: string;
  stallMs?: number;
  cap?: number;
  promptPrefix?: string;
};

type RuntimeDescriptor = {
  runtime: "container" | "crabbox";
  reason: string;
  capabilities: RuntimeCapabilities;
};

type RepoWorkflow = {
  repo: string;
  status: WorkflowStatus;
  sourcePath: string;
  sourceSha: string | null;
  config: WorkflowConfig;
  prompt: string;
  error: string | null;
  evaluatedAt: number;
  updatedAt: number;
};

type Card = {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  source: string;
  runtime: string;
  policy: string;
  lane: string;
  owner: string;
  startedAt: number | null;
  createdAt: number;
  logs: string[];
  changes: CardChanges;
  run: RunAttempt | null;
};

type DiffFileStatus = "added" | "deleted" | "modified" | "renamed";

type RunAttempt = {
  id: string;
  cardId: string;
  attempt: number;
  runtime: string;
  status: RunStatus;
  controlIntent: string | null;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  ptyAvailable: boolean;
  selectionReason: string | null;
  capabilities: RuntimeCapabilities;
  operator: string | null;
  lastHeartbeatAt: number;
  startedAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  error: string | null;
};

type StandaloneSandboxTerminalOwnership = {
  provisionId: string;
  requestHash: string;
  sandboxId: string;
  leaseId: string;
  expiresAt: number;
  updatedAt: number;
  policyGeneration: string;
};

type ChangedFile = {
  path: string;
  oldPath?: string;
  status: DiffFileStatus;
  additions: number;
  deletions: number;
};

type CardChanges = {
  files: ChangedFile[];
  patch: string;
  totals: {
    additions: number;
    deletions: number;
    files: number;
  };
};

const terminalInputStates = new Map<string, TerminalInputState>();
const terminalClipboardMaxBytes = 10 * 1024 * 1024;
const lanes = ["Todo", "Running", "Human Review", "Done"];
const activeRunStatuses: readonly RunStatus[] = ["queued", "leasing", "running"];
const runtimeOptions = ["auto", "container", "crabbox"] as const;
const mergePolicyOptions = ["open_pr", "merge_when_green", "fix_until_green_and_merge"] as const;
const defaultStallMs = 5 * 60 * 1000;
const workflowCacheMs = 60 * 60 * 1000;
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
  return {
    readState: (request, user) => readState(request, env, user, context),
    readFleet: (user) => readFleetState(env, user, undefined, context),
    searchGitHubRefs: (request) => searchGitHubRefs(request, env),
    createCard: (request, user) => createCard(request, env, user),
    readCardRuns: async (cardId) =>
      (await readCard(env, cardId)) ? readRunsForCard(env, cardId) : null,
    mutateCard: (user, cardId, action) => mutateCard(env, user, cardId, action),
    updatePolicy: (request, user) => updatePolicy(request, env, user),
    evaluateWorkflow: (request, user) => evaluateWorkflow(request, env, user),
    addAllowEntry: (request, user) => addAllowEntry(request, env, user),
    removeAllowEntry: (request, user, entry) => removeAllowEntry(request, env, user, entry),
    addRepo: (request, user) => addRepo(request, env, user),
    removeRepo: (request, user, repo) => removeRepo(request, env, user, repo),
  };
}

function provisioningRouteDependencies(env: RuntimeEnv): ProvisioningRouteDependencies {
  return {
    provision: (request) => provisionInteractiveEndpoint(request, env),
    stop: (request, provisionId) => stopStandaloneSandboxProvision(request, env, provisionId),
    openPty: (request, provisionId) => standaloneSandboxPty(request, env, provisionId),
  };
}

function sessionIngressRouteDependencies(
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): SessionIngressRouteDependencies {
  return {
    readSharedSession: (sessionId, token) => readSharedInteractiveSession(env, sessionId, token),
    openTerminal: async (request) =>
      interactiveTerminalHub(request, env, await terminalHubUser(request, env, requestAuth)),
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
    listCheckpoints: (user, sessionId) => listInteractiveSessionCheckpoints(env, user, sessionId),
    createCheckpoint: (user, sessionId) => checkpointInteractiveSession(env, user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      restoreInteractiveSessionCheckpoint(env, user, sessionId, checkpointId),
    readDiagnostics: (user, sessionId) => readInteractiveSessionDiagnostics(env, user, sessionId),
    openVnc: (user, sessionId) => interactiveSessionVnc(env, user, sessionId),
    uploadClipboard: (request, user, sessionId) =>
      uploadInteractiveSessionClipboard(request, env, user, sessionId),
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
    listCheckpoints: (user, sessionId) => listInteractiveSessionCheckpoints(env, user, sessionId),
    createCheckpoint: (user, sessionId) => checkpointInteractiveSession(env, user, sessionId),
    restoreCheckpoint: (user, sessionId, checkpointId) =>
      restoreInteractiveSessionCheckpoint(env, user, sessionId, checkpointId),
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
    canReconcileStoppingSession: async (sessionId) => {
      const owner = await database(env)
        .selectFrom("interactive_sessions")
        .select(["adapter", "lease_id", "credential_cleanup_terminal_status"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      return Boolean(
        owner &&
        owner.adapter === null &&
        (owner.credential_cleanup_terminal_status !== null ||
          owner.lease_id?.startsWith(sandboxLeasePrefix)),
      );
    },
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
      const upstream = await openInteractiveTerminalUpstream(
        terminalRequest,
        env,
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
  const db = database(env);
  const store: GitHubActionsSessionRegistrationStore = {
    now: () => Date.now(),
    newAgentToken,
    hashToken: sha256,
    requireRepo: (repo) => requireRepo(env, repo),
    readByWorkKey: async (workKey) =>
      (await db
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("work_key", "=", workKey)
        .executeTakeFirst()) ?? null,
    nextSessionId: () => nextInteractiveSessionId(env),
    insertSession: async (values) => {
      await db.insertInto("interactive_sessions").values(values).execute();
    },
    readById: async (id) =>
      (await db
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("id", "=", id)
        .executeTakeFirst()) ?? null,
    updateSession: async (id, values) => {
      await db.updateTable("interactive_sessions").set(values).where("id", "=", id).execute();
    },
    isConstraintError,
    disconnectRunner: (id) => disconnectGitHubActionsRunner(env, id),
    appendEvent: (id, message, now) =>
      appendInteractiveSessionEvent(env, id, serviceUser, message, now),
    audit: (message, now) => audit(env, serviceUser, message, now),
    readSession: (id) => readInteractiveSession(env, id),
  };
  return new GitHubActionsSessionRegistrationService(store);
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
  const target = openClawGitHubRepoParts(repo);
  if (!target) throw badRequest("repo must be a GitHub owner/name");
  await requireRepo(env, repo);
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
    readCredential: async (id) => {
      const row = await database(env)
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("id", "=", id)
        .where("preparation_pending", "=", 0)
        .executeTakeFirst();
      return row
        ? {
            session: interactiveSession(row, []),
            tokenHash: row.agent_token_hash,
          }
        : null;
    },
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
      stopSupersededRuntimeAdapterProvision(env, sessionId, adapterWorkspaceId, createPending, now),
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
      await recordConfirmedRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message);
    },
    archive: (sessionId, now) => archiveInteractiveSessionLogs(env, sessionId, now),
  });
}

async function readState(
  request: Request,
  env: RuntimeEnv,
  user: User,
  context?: ExecutionContext,
): Promise<Record<string, unknown>> {
  await reconcileStalledRuns(env, Date.now());
  await reconcileExternalInteractiveSessions(env, Date.now(), context);
  const db = database(env);
  const [settings, allow, repos, cards, interactiveSessions, workflows] = await Promise.all([
    readSettings(env),
    user.role === "owner"
      ? db.selectFrom("allow_entries").select(["value", "role"]).orderBy("value").execute()
      : Promise.resolve([]),
    db.selectFrom("repos").select("repo").where("enabled", "=", 1).orderBy("repo").execute(),
    readCards(env),
    readInteractiveSessions(env, user),
    user.role === "owner" ? readWorkflowSummaries(env) : Promise.resolve([]),
  ]);
  const repoNames = sortRepos(
    repos.map((row) => row.repo),
    deploymentConfig(env).preferredRepo,
  );
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
  options: {
    createdBy?: string;
    owner?: string;
    parentSessionId?: string | null;
    rootSessionId?: string | null;
    openClawRequestId?: string | null;
    openClawRequestHash?: string | null;
    afterReserve?: () => Promise<void>;
  } = {},
): Promise<{ session: InteractiveSession }> {
  const request = resolveInteractiveSessionCreateRequest(env, body, {
    owner: options.owner || actor(user),
    createdBy: options.createdBy || actor(user),
  });
  const {
    repo,
    branch,
    runtime,
    profile,
    requestedCapabilities,
    command,
    prompt,
    purpose,
    summary,
    owner,
    createdBy,
  } = request;
  await requireRepo(env, repo);
  const lineage = await interactiveSessionLineageService(env).resolve(
    user,
    options.parentSessionId ?? (clean(body.parentSessionId, 120) || null),
    options.rootSessionId ?? (clean(body.rootSessionId, 120) || null),
  );
  const supervision = openClawSupervision(env);
  const creation = interactiveSessionCreationService(env, user, supervision);
  const supervisedRootSessionId = await supervision.supervisedRootForCreate(createdBy, lineage);
  const preparationReservation = Boolean(options.afterReserve || supervisedRootSessionId);
  const now = Date.now();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let reservationInserted = false;
    const id = await nextInteractiveSessionId(env);
    const rootSessionId = lineage.rootSessionId ?? id;
    const {
      agentToken,
      initialAgentTokenHash,
      initialSandboxLease,
      initialSandboxOwnership,
      adapterWorkspaceId,
      adapterControlPlane,
      adapterSettings,
      adapterCreatePayloadJson,
    } = await createInteractiveSessionReservationContext(env, request, {
      id,
      parentSessionId: lineage.parentSessionId,
      rootSessionId,
    });
    try {
      const reservationValues = buildInteractiveSessionReservationValues({
        id,
        parentSessionId: lineage.parentSessionId,
        rootSessionId,
        repo,
        branch,
        runtime,
        adapterName: runtimeAdapterName,
        profile,
        adapterWorkspaceId,
        adapterControlPlane,
        requestedCapabilities,
        adapterSettings,
        adapterCreatePayloadJson,
        preparationReservation,
        openClawRequestId: options.openClawRequestId ?? null,
        openClawRequestHash: options.openClawRequestHash ?? null,
        command,
        prompt,
        purpose,
        summary,
        owner,
        createdBy,
        initialLeaseId: initialSandboxOwnership?.leaseId ?? null,
        initialAgentTokenHash,
        now,
      });
      if (options.openClawRequestId && options.openClawRequestHash) {
        await insertInteractiveSessionReservation(env, reservationValues, {
          requestId: options.openClawRequestId,
          requestHash: options.openClawRequestHash,
          sessionId: id,
          createdAt: now,
        });
      } else {
        await insertInteractiveSessionReservation(env, reservationValues, null);
      }
      reservationInserted = true;
      const provisioned = await creation.provision(
        {
          id,
          insertedAt: now,
          supervisedRootSessionId,
          requiresActivation: preparationReservation,
          adapterWorkspaceId,
        },
        options.afterReserve,
        () =>
          interactiveProvisioningService(env).provisionManaged(
            {
              id,
              ...(adapterWorkspaceId ? { adapterWorkspaceId } : {}),
              ...(adapterControlPlane ? { adapterControlPlane } : {}),
              ...(adapterSettings
                ? {
                    adapterTtlSeconds: adapterSettings.ttlSeconds,
                    adapterIdleTimeoutSeconds: adapterSettings.idleTimeoutSeconds,
                    adapterRequestedCapabilities: adapterSettings.capabilities,
                    adapterCreatePayloadJson,
                  }
                : {}),
              parentSessionId: lineage.parentSessionId,
              rootSessionId,
              repo,
              branch,
              runtime,
              profile,
              command,
              prompt,
              purpose,
              summary,
              owner,
              createdBy,
              ...(githubToken ? { githubToken } : {}),
            },
            agentToken,
            initialSandboxLease && initialSandboxOwnership
              ? { lease: initialSandboxLease, ownership: initialSandboxOwnership }
              : undefined,
          ),
      );
      const provisionPersistence = await creation.completeProvision(
        {
          sessionId: id,
          insertedAt: now,
          profile,
          requestedCapabilities,
          initialLeaseId: initialSandboxOwnership?.leaseId ?? null,
          initialAgentTokenHash,
          adapterName: runtimeAdapterName,
        },
        provisioned,
      );
      if (!provisionPersistence.updated && provisioned) {
        const current = await creation.recoverSupersededProvision(
          {
            sessionId: id,
            adapterName: runtimeAdapterName,
            sandboxLeasePrefix,
            now: Date.now(),
          },
          provisioned,
        );
        return { session: decorateInteractiveSession(current, user, env) };
      }
      await audit(
        env,
        user,
        `interactive session created ${id} repo=${repo} runtime=${runtime}`,
        now,
      );
      return {
        session: decorateInteractiveSession(
          (await readInteractiveSession(env, id)) as InteractiveSession,
          user,
          env,
        ),
      };
    } catch (error) {
      const replay = await creation.recoverReservationFailure(error, {
        reservationInserted,
        attempt,
        maximumAttempts: 3,
        requestId: options.openClawRequestId ?? null,
        requestHash: options.openClawRequestHash ?? null,
      });
      if (replay) return { session: replay };
    }
  }
  throw new Error("failed to allocate interactive session id");
}

async function registeredRuntimeAdapterControlPlaneForSession(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
): Promise<string> {
  const registration = await database(env)
    .selectFrom("interactive_sessions")
    .select(["adapter_control_plane", "profile"])
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .executeTakeFirst();
  return requireRegisteredRuntimeAdapterControlPlane(
    env,
    registration?.profile ?? "",
    registration?.adapter_control_plane,
  );
}

async function stopSupersededRuntimeAdapterProvision(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  createPending: boolean,
  now: number,
): Promise<void> {
  if (!createPending) {
    await clearRuntimeAdapterCreatePending(env, sessionId, adapterWorkspaceId);
  }
  try {
    const release = await runtimeAdapterWorkspaceLifecycle(env).stopForSession(
      sessionId,
      adapterWorkspaceId,
    );
    if (release.status === "stopped") {
      await recordConfirmedRuntimeAdapterRelease(
        env,
        sessionId,
        adapterWorkspaceId,
        now,
        release.message,
      );
      return;
    }
    await persistRuntimeAdapterStopEvidence(
      env,
      sessionId,
      adapterWorkspaceId,
      release.message,
      now,
      null,
    );
  } catch (error) {
    const message = safeProviderError(error, [adapterWorkspaceId]);
    const pendingMessage = `superseded runtime adapter stop pending: ${message}`;
    await persistRuntimeAdapterStopEvidence(
      env,
      sessionId,
      adapterWorkspaceId,
      pendingMessage,
      now,
      message,
    );
  }
}

async function recordConfirmedRuntimeAdapterRelease(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  now: number,
  releaseMessage?: string,
): Promise<"stopping" | "stopped" | "failed" | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lifecycle = await database(env)
      .selectFrom("interactive_sessions")
      .select([
        "adapter_create_pending",
        "terminal_status",
        "terminal_failure_reason",
        "reconcile_error",
        "last_event",
        "updated_at",
      ])
      .where("id", "=", sessionId)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .where("status", "=", "stopping")
      .executeTakeFirst();
    if (!lifecycle) return null;

    const resolved = resolveCreateAfterStopRace(
      lifecycle.adapter_create_pending === 1,
      lifecycle.terminal_status,
    );
    const failureMessage = retainedRuntimeAdapterFailureMessage(
      lifecycle.terminal_failure_reason,
      lifecycle.reconcile_error,
      lifecycle.last_event,
    );
    const retainedReleaseMessage = clean(releaseMessage, 500) || null;
    const values =
      resolved.status === "stopping"
        ? ({
            adapter_create_pending: 1,
            last_reconciled_at: now,
            updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
            last_event:
              retainedReleaseMessage ?? "runtime adapter stop waiting for create resolution",
          } as const)
        : ({
            status: resolved.status,
            lease_id: null,
            attach_url: null,
            vnc_url: null,
            terminal_status: resolved.terminalStatus,
            terminal_failure_reason: resolved.status === "failed" ? failureMessage : null,
            adapter_create_pending: 0,
            terminal_finalize_pending: 1,
            last_reconciled_at: now,
            reconcile_error: resolved.status === "failed" ? failureMessage : null,
            stopped_at: now,
            agent_token_hash: null,
            controller: null,
            control_requested_by: null,
            control_requested_at: null,
            control_granted_at: null,
            control_expires_at: null,
            updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
            last_event:
              resolved.status === "failed"
                ? failureMessage
                : (retainedReleaseMessage ?? "interactive workspace stopped"),
          } as const);
    const terminalStatusOwner = lifecycle.terminal_status
      ? sql<boolean>`terminal_status = ${lifecycle.terminal_status}`
      : sql<boolean>`terminal_status IS NULL`;
    const expectedOwner = sql<boolean>`
      id = ${sessionId}
      AND adapter = ${runtimeAdapterName}
      AND adapter_workspace_id = ${adapterWorkspaceId}
      AND status = 'stopping'
      AND adapter_create_pending = ${lifecycle.adapter_create_pending}
      AND updated_at = ${lifecycle.updated_at}
      AND ${terminalStatusOwner}
    `;
    const db = database(env);
    const update = db
      .updateTable("interactive_sessions")
      .set(values)
      .where(expectedOwner)
      .returning("updated_at");
    const recordReleaseEvent =
      retainedReleaseMessage &&
      (resolved.status !== "stopping" || lifecycle.last_event !== retainedReleaseMessage);
    const queries: CompilableQuery[] = [];
    if (recordReleaseEvent) {
      queries.push(sql`
        INSERT INTO interactive_session_events (session_id, actor, message, created_at)
        SELECT ${sessionId}, 'system', ${retainedReleaseMessage}, ${now}
        FROM interactive_sessions
        WHERE ${expectedOwner}
      `);
    }
    queries.push(update);
    const results = await env.DB.batch<{ updated_at: number }>(
      queries.map((query) => {
        const compiled = query.compile(db);
        return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
      }),
    );
    if (results.at(-1)?.results.length) {
      if (recordReleaseEvent) {
        await archiveInteractiveSessionLogs(env, sessionId, now).catch(() => undefined);
      }
      if (resolved.status === "stopped" || resolved.status === "failed") {
        await finalizeTerminalInteractiveSession(env, sessionId, resolved.status, now).catch(
          () => undefined,
        );
      }
      return resolved.status;
    }
  }
  return null;
}

async function clearRuntimeAdapterCreatePending(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
): Promise<void> {
  await database(env)
    .updateTable("interactive_sessions")
    .set({ adapter_create_pending: 0 })
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("status", "=", "stopping")
    .execute();
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
  const store: InteractiveSessionCreationStore = {
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
      stopSupersededRuntimeAdapterProvision(env, sessionId, adapterWorkspaceId, createPending, now),
    cleanupSupersededSandbox: async (sessionId, leaseId) => {
      await queueSandboxCredentialPolicyCleanup(
        env,
        sessionId,
        sandboxLeaseInfo({ id: sessionId, leaseId }).sandboxId,
      );
      await reconcileCredentialPolicyCleanupBatch(env, Date.now(), sessionId);
    },
  };
  return new InteractiveSessionCreationService(store);
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
      recordConfirmedRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message),
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

function managedSandboxLeaseId(
  session: Pick<InteractiveSession, "adapter" | "leaseId">,
): string | null {
  return workerOwnedLeaseId(session.adapter, session.leaseId);
}

function isSandboxInteractiveSession(
  session: Pick<InteractiveSession, "adapter" | "leaseId">,
): boolean {
  return managedSandboxLeaseId(session)?.startsWith(sandboxLeasePrefix) === true;
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

async function interactiveTerminalHub(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
): Promise<Response> {
  return terminalHub(env).open(request, user);
}

function terminalHub(env: RuntimeEnv): TerminalHub {
  return new TerminalHub({
    createSocketPair: () => {
      const pair = new WebSocketPair();
      return { client: pair[0], server: pair[1] };
    },
    upgradeResponse: (client) => new Response(null, { status: 101, webSocket: client }),
    canOpenAnonymous: (request) => canOpenAnonymousTerminalHub(request, env),
    canViewShared: (request, sessionId) => canViewSharedTerminalRequest(request, env, sessionId),
    readSession: (sessionId) => readFreshInteractiveSession(env, sessionId),
    canViewSession: (request, user, session) => canViewTerminalSession(request, env, user, session),
    inputGrant: (user, session) => terminalInputGrant(env, user, session),
    viewGrant: (request, user, session) => terminalViewGrant(request, env, user, session),
    reconcileSubscription: (sessionId) => terminalSubscriptionReconciler(env, sessionId),
    openUpstream: (request, user, session, cols, rows) =>
      openInteractiveTerminalUpstream(request, env, user, session, cols, rows),
    inputPayloads: (subscription, user, payload) =>
      multiplayerTerminalInputPayloads(env, subscription, user, payload),
    markConnectionFailure: async (user, session, message) => {
      const markTerminal =
        session.runtime === githubActionsRuntime ||
        (isSandboxInteractiveSession(session) && env.SANDBOX)
          ? markInteractiveTerminalDetached
          : markInteractiveTerminalUnavailable;
      await markTerminal(env, user, session.id, Date.now(), message);
    },
    markDetached: (user, sessionId, message) =>
      markInteractiveTerminalDetached(env, user, sessionId, Date.now(), message),
  });
}

async function writeTerminalClipboardFile(
  env: RuntimeEnv,
  user: User,
  session: InteractiveSession,
  bytes: Uint8Array,
  rawName: unknown,
  rawMediaType: unknown,
): Promise<{ path: string; name: string; mediaType: string; byteCount: number }> {
  if (!isSandboxInteractiveSession(session) || !env.SANDBOX) {
    throw serviceUnavailable("clipboard file paste requires a Cloudflare Sandbox session");
  }
  if (!bytes.byteLength || bytes.byteLength > terminalClipboardMaxBytes) {
    throw badRequest(
      `clipboard file exceeds ${Math.floor(terminalClipboardMaxBytes / 1024 / 1024)} MiB`,
    );
  }
  const mediaType = clean(rawMediaType || "application/octet-stream", 120);
  const name = safeClipboardFilename(rawName, mediaType);
  const lease = sandboxLeaseInfo(session);
  const sandbox = getSandbox(env.SANDBOX, lease.sandboxId);
  const directory = `${sandboxWorkdir(session.id)}/.crabbox/clipboard`;
  const path = `${directory}/${Date.now()}-${crypto.randomUUID().slice(0, 8)}-${name}`;
  await sandbox.mkdir(directory, { recursive: true });
  await sandbox.writeFile(path, base64FromBytes(bytes), { encoding: "base64" });
  await appendInteractiveSessionEvent(
    env,
    session.id,
    user,
    `Clipboard file pasted: ${path}`,
    Date.now(),
  );
  return { path, name, mediaType, byteCount: bytes.byteLength };
}

async function openInteractiveTerminalUpstream(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
  cols: number,
  rows: number,
): Promise<TerminalUpstream> {
  if (!session.capabilities.terminal) {
    throw serviceUnavailable("session does not advertise terminal access");
  }
  const now = Date.now();
  if (session.runtime === githubActionsRuntime) {
    const stub = githubActionsRelayStub(env, session.id);
    if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
    const upstreamResponse = await stub.fetch(
      "https://crabfleet.internal/api/session-control/github-actions/viewer",
      { headers: { upgrade: "websocket" } },
    );
    const upstream = upstreamResponse.webSocket;
    if (!upstream || upstreamResponse.status !== 101) {
      throw serviceUnavailable(`GitHub Actions relay HTTP ${upstreamResponse.status}`);
    }
    upstream.accept();
    return {
      socket: upstream,
      outputAcknowledgements: false,
      markConnected: () =>
        markInteractiveTerminalConnected(
          env,
          user,
          session.id,
          now,
          "GitHub Actions terminal connected",
        ),
    };
  }

  const routeKind = interactivePtyRouteKind(env, session);
  if (routeKind === "sandbox" && env.SANDBOX) {
    const runtimeSession = await sandboxSessionWithGitHubToken(request, env, user, session);
    const sandboxSession = await ensureCurrentSandboxLease(request, env, user, runtimeSession);
    const lease = sandboxLeaseInfo(sandboxSession);
    const sandbox = getSandbox(env.SANDBOX, lease.sandboxId);
    const upstreamResponse = await openSandboxTerminalResponse(
      request,
      env,
      sandbox,
      sandboxSession,
      {
        cols,
        rows,
      },
    );
    const upstream = upstreamResponse.webSocket;
    if (!upstream || upstreamResponse.status !== 101) {
      throw serviceUnavailable(`Cloudflare Sandbox terminal HTTP ${upstreamResponse.status}`);
    }
    upstream.accept();
    return {
      socket: upstream,
      outputAcknowledgements: false,
      markConnected: () =>
        markInteractiveTerminalConnected(
          env,
          user,
          sandboxSession.id,
          now,
          "Cloudflare Sandbox terminal connected",
        ),
    };
  }

  const target = interactiveTerminalTarget(env, session, routeKind);
  if (!target) throw serviceUnavailable("terminal upstream is not configured for this session");
  const upstreamResponse = await interactiveTerminalFetch(
    env,
    session,
    target.url,
    interactiveTerminalHeaders(session, target.authorization),
  );
  const upstream = upstreamResponse.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    throw serviceUnavailable(`terminal upstream HTTP ${upstreamResponse.status}`);
  }
  upstream.accept();
  return {
    socket: upstream,
    outputAcknowledgements: terminalOutputAcknowledgements(target.url),
    markConnected: () =>
      markInteractiveTerminalConnected(env, user, session.id, now, "PTY terminal connected"),
  };
}

async function markInteractiveTerminalConnected(
  env: RuntimeEnv,
  user: User | null,
  id: string,
  now: number,
  message: string,
): Promise<void> {
  const previous = await database(env)
    .selectFrom("interactive_sessions")
    .select(["status", "last_event", "last_seen_at"])
    .where("id", "=", id)
    .executeTakeFirst();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "attached",
      last_seen_at: now,
      last_event: message,
    })
    .where("id", "=", id)
    .where("status", "in", ["ready", "attached", "detached"])
    .execute();
  if (
    previous &&
    (previous.status !== "attached" ||
      previous.last_event !== message ||
      now - previous.last_seen_at > 5 * 60_000)
  ) {
    await appendInteractiveSessionLog(env, id, user, message, now);
  }
}

async function markInteractiveTerminalDetached(
  env: RuntimeEnv,
  user: User | null,
  id: string,
  now: number,
  message: string,
): Promise<void> {
  const existing = await database(env)
    .selectFrom("interactive_sessions")
    .select("status")
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing || ["stopping", "expired", "failed", "stopped"].includes(existing.status)) return;
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "detached",
      last_event: message,
    })
    .where("id", "=", id)
    .where("status", "in", ["ready", "attached", "detached"])
    .execute();
  await appendInteractiveSessionLog(env, id, user, message, now);
}

async function markInteractiveTerminalUnavailable(
  env: RuntimeEnv,
  user: User | null,
  id: string,
  now: number,
  message: string,
): Promise<void> {
  const existing = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing || ["expired", "failed", "stopped"].includes(existing.status)) return;
  if (terminalFailureStatusForAdapter(existing.adapter) === "detached") {
    if (existing.status === "stopping") return;
    await markInteractiveTerminalDetached(env, user, id, now, message);
    return;
  }
  const legacySession = {
    adapter: existing.adapter,
    leaseId: existing.lease_id,
  };
  if (isSandboxInteractiveSession(legacySession)) {
    const staged = await stageTerminalCredentialPolicyCleanupById(
      env,
      id,
      "failed",
      message,
      now,
      message,
    );
    if (!staged) return;
    await appendInteractiveSessionLog(env, id, user, message, now);
    await reconcileCredentialPolicyCleanupBatch(env, now, id);
    return;
  }
  if (existing.status === "stopping") return;
  const update = await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "expired",
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      stopped_at: now,
      terminal_finalize_pending: 1,
      last_event: message,
    })
    .where("id", "=", id)
    .where("status", "=", existing.status)
    .where("updated_at", "=", existing.updated_at)
    .executeTakeFirst();
  if ((update.numUpdatedRows ?? 0n) > 0n) {
    await appendInteractiveSessionLog(env, id, user, message, now);
    await finalizeTerminalInteractiveSession(env, id, "expired", now).catch(() => undefined);
  }
}

async function uploadInteractiveSessionClipboard(
  request: Request,
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{ path: string; name: string; mediaType: string; byteCount: number }> {
  if (!(await canControlInteractiveSessionById(env, user, id))) {
    throw forbidden("terminal control has not been granted");
  }
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
    throw badRequest(`session is ${session.status}`);
  }
  const bytes = await readClipboardUploadBytes(request);
  return writeTerminalClipboardFile(
    env,
    user,
    session,
    bytes,
    decodeHeaderValue(request.headers.get("x-clipboard-name")),
    request.headers.get("content-type") || "application/octet-stream",
  );
}

async function readClipboardUploadBytes(request: Request): Promise<Uint8Array> {
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(contentLength) && contentLength > terminalClipboardMaxBytes) {
    throw badRequest(
      `clipboard file exceeds ${Math.floor(terminalClipboardMaxBytes / 1024 / 1024)} MiB`,
    );
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (!bytes.byteLength) throw badRequest("clipboard file is empty");
  if (bytes.byteLength > terminalClipboardMaxBytes) {
    throw badRequest(
      `clipboard file exceeds ${Math.floor(terminalClipboardMaxBytes / 1024 / 1024)} MiB`,
    );
  }
  return bytes;
}

function terminalInputGrant(
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  if (!user || !session.capabilities.terminal) return async () => false;
  return cachedBooleanGrant(() => canControlInteractiveSessionById(env, user, session.id));
}

function terminalSubscriptionReconciler(env: RuntimeEnv, id: string): () => void {
  let nextAt = Date.now() + runtimeAdapterReconcileIntervalMs;
  let inFlight = false;
  return () => {
    const now = Date.now();
    if (inFlight || now < nextAt) return;
    inFlight = true;
    nextAt = now + runtimeAdapterReconcileIntervalMs;
    void reconcileExternalInteractiveSessionById(env, id, now)
      .catch((error) => {
        console.error("terminal subscription reconciliation failed", error);
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

function terminalViewGrant(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): () => Promise<boolean> {
  return async () =>
    Boolean(user && (await canControlInteractiveSessionById(env, user, session.id))) ||
    (await canViewSharedTerminalRequest(request, env, session.id));
}

async function canViewSharedTerminalRequest(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return (!shareSession || shareSession === id) && (await isSharedSessionToken(env, id, token));
}

async function canOpenAnonymousTerminalHub(request: Request, env: RuntimeEnv): Promise<boolean> {
  const url = new URL(request.url);
  const shareSession = url.searchParams.get("shareSession") ?? "";
  const token = url.searchParams.get("token") ?? "";
  return Boolean(shareSession && token && (await isSharedSessionToken(env, shareSession, token)));
}

async function canViewTerminalSession(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession,
): Promise<boolean> {
  if (user) {
    requireRole(user, "viewer");
    if (await canControlInteractiveSessionById(env, user, session.id)) return true;
  }
  return canViewSharedTerminalRequest(request, env, session.id);
}

async function isSharedSessionToken(env: RuntimeEnv, id: string, token: string): Promise<boolean> {
  if (!token) return false;
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select(["share_token_hash", "share_mode", "status", "runtime", "capabilities_json"])
    .where("id", "=", id)
    .where("share_mode", "=", "link_read")
    .executeTakeFirst();
  return Boolean(
    row?.share_token_hash &&
    !["stopping", "expired", "failed", "stopped"].includes(row.status) &&
    runtimeCapabilities(row.runtime, row.capabilities_json).terminal &&
    (await sha256(token)) === row.share_token_hash,
  );
}

async function readInteractiveSessionDiagnostics(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{ session: InteractiveSession; diagnostics: unknown }> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  const decoratedSession = decorateInteractiveSession(session, user, env);
  if (
    !canControlInteractiveSession(user, session, Date.now(), canGrantDelegatedControl(env, session))
  ) {
    throw forbidden("terminal control has not been granted");
  }
  if (!env.SANDBOX || !isSandboxInteractiveSession(session)) {
    return {
      session: decoratedSession,
      diagnostics: {
        available: false,
        reason: "diagnostics are only available for Cloudflare Sandbox sessions",
      },
    };
  }

  const lease = sandboxLeaseInfo(session);
  const sandbox = getSandbox(env.SANDBOX, lease.sandboxId);
  const workdir = sandboxWorkdir(session.id);
  const setup = await createSandboxSession(
    sandbox,
    sandboxSetupSessionId(session.id),
    "/workspace",
    {
      CRABBOX_SESSION_ID: session.id,
      CRABBOX_WORKDIR: workdir,
    },
  );
  const result = await setup.exec(
    `
node - <<'NODE'
const fs = require("fs");
const cp = require("child_process");
const tools = [
  "bash", "git", "gh", "node", "npm", "pnpm", "codex", "rg", "fd", "jq",
  "python3", "pip3", "make", "gcc", "time", "ssh", "rsync", "curl",
  "unzip", "zip", "sqlite3", "shellcheck", "crabbox"
];
const workdir = process.env.CRABBOX_WORKDIR || "";
const repo = process.env.CRABBOX_REPO || "";
const home = process.env.HOME || "/root";
function run(command, args) {
  try {
    return cp.execFileSync(command, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000
    }).trim();
  } catch {
    return "";
  }
}
function shell(command) {
  return run("/bin/bash", ["-lc", command]);
}
function which(tool) {
  return shell("command -v " + JSON.stringify(tool));
}
function oneLine(text) {
  return String(text || "").split(/\\r?\\n/).find(Boolean) || "";
}
const toolResults = tools.map((name) => {
  const path = which(name);
  return {
    name,
    present: Boolean(path),
    path: path || null,
    version: path ? oneLine(run(path, ["--version"])) || null : null
  };
});
const missing = toolResults.filter((tool) => !tool.present).map((tool) => tool.name);
const checkout = {
  path: workdir,
  exists: Boolean(workdir && fs.existsSync(workdir)),
  git: Boolean(workdir && fs.existsSync(workdir + "/.git")),
  branch: workdir ? run("git", ["-C", workdir, "rev-parse", "--abbrev-ref", "HEAD"]) || null : null,
  head: workdir ? run("git", ["-C", workdir, "rev-parse", "--short", "HEAD"]) || null : null,
  remote: workdir ? run("git", ["-C", workdir, "config", "--get", "remote.origin.url"]).replace(/\\/\\/[^/@]+@/g, "//<redacted>@") || null : null
};
const codexHome = process.env.CODEX_HOME || home + "/.codex";
const repoPermissionsRaw = repo ? run("gh", ["api", "repos/" + repo, "--jq", ".permissions"]) : "";
let repoPermissions = null;
try {
  repoPermissions = repoPermissionsRaw ? JSON.parse(repoPermissionsRaw) : null;
} catch {}
const diagnostics = {
  available: true,
  imageVersion: process.env.CRABBOX_IMAGE_VERSION || null,
  cwd: process.cwd(),
  checkout,
  github: {
    credentialProxy: process.env.CRABFLEET_SANDBOX === "1",
    credentialFilePresent: fs.existsSync(home + "/.config/crabbox/github-credential"),
    ghAuthenticated: Boolean(run("gh", ["api", "user", "--jq", ".login"])),
    repo,
    permissions: repoPermissions
  },
  codex: {
    home: codexHome,
    configPresent: fs.existsSync(codexHome + "/config.toml"),
    authPresent: fs.existsSync(codexHome + "/auth.json")
  },
  tools: toolResults,
  missing
};
console.log(JSON.stringify(diagnostics));
NODE
`,
    { timeout: 20_000, env: { CRABBOX_WORKDIR: workdir, CRABBOX_REPO: session.repo } },
  );
  if (!result.success) {
    return {
      session: decoratedSession,
      diagnostics: {
        available: false,
        reason: clean(result.stderr || result.stdout || "diagnostics failed", 700),
      },
    };
  }
  const output = result.stdout.trim();
  try {
    return { session: decoratedSession, diagnostics: JSON.parse(output) };
  } catch {
    return {
      session: decoratedSession,
      diagnostics: {
        available: false,
        reason: "diagnostics returned invalid JSON",
        output: clean(output, 700),
      },
    };
  }
}

async function listInteractiveSessionCheckpoints(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{ checkpoints: Array<Omit<SandboxCheckpoint, "backup">>; session: InteractiveSession }> {
  const session = await managedSandboxSession(env, user, id);
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  const response = await stub.fetch(
    `https://crabfleet.internal/api/session-control/checkpoints/${encodeURIComponent(id)}`,
  );
  if (!response.ok) throw serviceUnavailable("checkpoint registry is unavailable");
  const body = (await response.json()) as { checkpoints?: SandboxCheckpoint[] };
  return {
    checkpoints: (body.checkpoints ?? []).map(({ backup: _backup, ...checkpoint }) => checkpoint),
    session: decorateInteractiveSession(session, user, env),
  };
}

async function checkpointInteractiveSession(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<{ checkpoint: Omit<SandboxCheckpoint, "backup">; session: InteractiveSession }> {
  const session = await managedSandboxSession(env, user, id);
  const lease = sandboxLeaseInfo(session);
  const sandbox = getManagedSandbox(env, session);
  const workdir = sandboxWorkdir(id);
  const name = `checkpoint-${Date.now()}`;
  const backup = await sandbox.createBackup(sandboxBackupOptions(env, workdir, name));
  const checkpoint: SandboxCheckpoint = {
    backup,
    createdAt: Date.now(),
    id: backup.id,
    name,
    sessionId: id,
    workdir,
  };
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  const response = await stub.fetch("https://crabfleet.internal/api/session-control/checkpoints", {
    method: "POST",
    body: JSON.stringify(checkpoint),
    headers: { "content-type": "application/json" },
  });
  if (!response.ok) throw serviceUnavailable("checkpoint registry is unavailable");
  await appendInteractiveSessionEvent(
    env,
    id,
    user,
    `checkpoint created ${checkpoint.id} in ${lease.sandboxId}`,
    Date.now(),
  );
  return {
    checkpoint: (({ backup: _backup, ...item }) => item)(checkpoint),
    session: decorateInteractiveSession(session, user, env),
  };
}

async function restoreInteractiveSessionCheckpoint(
  env: RuntimeEnv,
  user: User,
  id: string,
  checkpointId: string,
): Promise<{ checkpoint: Omit<SandboxCheckpoint, "backup">; session: InteractiveSession }> {
  const session = await managedSandboxSession(env, user, id);
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  const response = await stub.fetch(
    `https://crabfleet.internal/api/session-control/checkpoints/${encodeURIComponent(
      id,
    )}/${encodeURIComponent(checkpointId)}`,
  );
  if (!response.ok) throw notFound("checkpoint not found");
  const body = (await response.json()) as { checkpoint?: SandboxCheckpoint };
  if (!body.checkpoint) throw notFound("checkpoint not found");
  const sandbox = getManagedSandbox(env, session);
  await sandbox.restoreBackup(body.checkpoint.backup);
  await appendInteractiveSessionEvent(
    env,
    id,
    user,
    `checkpoint restored ${body.checkpoint.id}`,
    Date.now(),
  );
  return {
    checkpoint: (({ backup: _backup, ...item }) => item)(body.checkpoint),
    session: decorateInteractiveSession(session, user, env),
  };
}

function sandboxBackupOptions(env: RuntimeEnv, workdir: string, name: string): BackupOptions {
  const localBucket = env.CRABFLEET_LOCAL_SANDBOX_BACKUPS !== "0";
  if (localBucket && !env.BACKUP_BUCKET) {
    throw serviceUnavailable("checkpoint backups require the BACKUP_BUCKET R2 binding");
  }
  if (!localBucket && !sandboxHasPresignedBackupConfig(env)) {
    throw serviceUnavailable(
      "checkpoint backups require BACKUP_BUCKET plus CLOUDFLARE_ACCOUNT_ID, BACKUP_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
    );
  }
  return {
    dir: workdir,
    excludes: ["node_modules", ".pnpm-store", ".cache", "dist", "build"],
    gitignore: true,
    ...(localBucket ? { localBucket: true } : {}),
    name,
  };
}

function sandboxHasPresignedBackupConfig(env: RuntimeEnv): boolean {
  return Boolean(
    env.BACKUP_BUCKET &&
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.BACKUP_BUCKET_NAME &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY,
  );
}

async function managedSandboxSession(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<InteractiveSession> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (!canManageInteractiveSession(user, session)) {
    throw forbidden("only the session owner or maintainer can manage checkpoints");
  }
  if (!env.SANDBOX || !isSandboxInteractiveSession(session)) {
    throw badRequest("checkpoints require a Cloudflare Sandbox session");
  }
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
    throw badRequest(`session is ${session.status}`);
  }
  return session;
}

function getManagedSandbox(env: RuntimeEnv, session: InteractiveSession): CloudflareSandbox {
  if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
  const lease = sandboxLeaseInfo(session);
  return getSandbox(env.SANDBOX, lease.sandboxId);
}

async function interactiveSessionVnc(env: RuntimeEnv, user: User, id: string): Promise<Response> {
  const session = await readFreshInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (["stopping", "stopped", "expired", "failed"].includes(session.status)) {
    throw badRequest(`session is ${session.status}`);
  }
  const now = Date.now();
  const delegatedControl = canGrantDelegatedControl(env, session);
  if (!canControlInteractiveSession(user, session, now, delegatedControl)) {
    throw forbidden("terminal control has not been granted");
  }
  let target: string;
  if (session.adapter === runtimeAdapterName) {
    if (!["ready", "attached", "detached"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    if (!session.capabilities.vnc && !session.capabilities.desktop) {
      throw badRequest("session does not advertise desktop access");
    }
    if (!session.adapterWorkspaceId) {
      throw serviceUnavailable("runtime adapter workspace reference is incomplete");
    }
    let controlPlane: string;
    try {
      controlPlane = await registeredRuntimeAdapterControlPlaneForSession(
        env,
        session.id,
        session.adapterWorkspaceId,
      );
    } catch (error) {
      throw serviceUnavailable(clean(error instanceof Error ? error.message : String(error), 240));
    }
    let response: Response;
    let responseBody: unknown;
    try {
      response = await runtimeAdapterFetch(
        env,
        runtimeAdapterDesktopUrl(controlPlane, session.adapterWorkspaceId),
        {
          method: "POST",
        },
      );
      responseBody = await readRuntimeAdapterResponseBody(response);
    } catch (error) {
      throw serviceUnavailable(
        `runtime adapter desktop connection failed: ${clean(String(error), 240)}`,
      );
    }
    if (!response.ok) {
      throw serviceUnavailable(`runtime adapter desktop connection HTTP ${response.status}`);
    }
    const connection = currentAdapterDesktopConnection(responseBody, Date.now());
    if (!connection) throw serviceUnavailable("desktop connection has an invalid expiry");
    if (!(await currentRuntimeAdapterDesktopAccess(env, user, session, controlPlane))) {
      throw forbidden("desktop authorization changed; retry");
    }
    target = connection.url;
  } else {
    const legacyTarget = safeDesktopUrl(session.vncUrl);
    if (!legacyTarget) throw badRequest("legacy desktop connection is not available");
    target = legacyTarget;
  }
  return new Response(null, {
    status: 302,
    headers: {
      location: target,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

async function currentRuntimeAdapterDesktopAccess(
  env: RuntimeEnv,
  user: User,
  expected: InteractiveSession,
  controlPlane: string,
): Promise<boolean> {
  const currentRow = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", expected.id)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", expected.adapterWorkspaceId)
    .where("adapter_control_plane", "=", controlPlane)
    .where(sql<boolean>`provider_resource_id IS ${expected.providerResourceId}`)
    .where("runtime", "=", expected.runtime)
    .where("profile", "=", expected.profile)
    .where("adapter_create_pending", "=", 0)
    .where("status", "in", ["ready", "attached", "detached"])
    .executeTakeFirst();
  if (!currentRow) return false;
  const current = interactiveSession(currentRow, []);
  if (!current.capabilities.vnc && !current.capabilities.desktop) return false;
  return canControlInteractiveSession(
    user,
    current,
    Date.now(),
    canGrantDelegatedControl(env, current),
  );
}

async function multiplayerTerminalInputPayloads(
  env: RuntimeEnv,
  subscription: TerminalHubSubscription,
  user: User | null,
  payload: Uint8Array,
): Promise<Uint8Array[]> {
  const submitted = terminalSubmittedLine(terminalInputState(subscription.session.id), payload);
  if (!user || !submitted || !submitted.text.trim()) {
    return [payload];
  }
  const enabled = await readInteractiveSessionMultiplayerMode(
    env,
    subscription.session.id,
    subscription.session.multiplayerMode,
  );
  if (!enabled) {
    return [payload];
  }

  return attributedTerminalInputPayloads(user, submitted);
}

function terminalInputState(sessionId: string): TerminalInputState {
  let state = terminalInputStates.get(sessionId);
  if (!state) {
    state = newTerminalInputState();
    terminalInputStates.set(sessionId, state);
  }
  return state;
}

async function readInteractiveSessionMultiplayerMode(
  env: RuntimeEnv,
  id: string,
  fallback: boolean,
): Promise<boolean> {
  try {
    const row = await database(env)
      .selectFrom("interactive_sessions")
      .select(["multiplayer_mode"])
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? row.multiplayer_mode === 1 : fallback;
  } catch {
    return fallback;
  }
}

function interactiveProvisioningService(env: RuntimeEnv): InteractiveProvisioningService {
  const runtimeAdapter = runtimeAdapterProvisioningService(env);
  return new InteractiveProvisioningService({
    sandboxAvailable: Boolean(env.SANDBOX),
    runtimeAdapterAvailable: runtimeAdapterConfigurationPresent(env),
    provisionSandbox: (session, agentToken, sandbox) =>
      provisionWithSandbox(env, session, agentToken, sandbox.lease, sandbox.ownership),
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
      await recordConfirmedRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, now, message);
    },
    persistStopEvidence: (sessionId, adapterWorkspaceId, message, now) =>
      persistRuntimeAdapterStopEvidence(env, sessionId, adapterWorkspaceId, message, now),
  });
}

function managedSandboxProvisioningService(env: RuntimeEnv): ManagedSandboxProvisioningService {
  return new ManagedSandboxProvisioningService({
    now: Date.now,
    preflight: (session) => sandboxProvisionPreflightError(env, session),
    claim: (session, owner, now) =>
      claimManagedSandboxProvision(env, session, owner, now, credentialPolicyProvisioningStaleMs),
    provision: (session, claim) =>
      provisionWithSandbox(env, session, claim.agentToken, claim.lease, claim.fence),
    stageFailure: (sessionId, fence, message, now) =>
      stageFailedManagedSandboxProvision(env, sessionId, fence, message, now),
    commit: (sessionId, claim, result, now) =>
      commitManagedSandboxProvision(env, sessionId, claim, result, now),
    reconcileCleanup: (sessionId, now) =>
      reconcileCredentialPolicyCleanupBatch(env, now, sessionId),
    providerError: safeProviderError,
  });
}

function standaloneSandboxProvisioningService(
  env: RuntimeEnv,
): StandaloneSandboxProvisioningService {
  const provisionTtlMs =
    clampedSeconds(env.CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS, standaloneSandboxDefaultTtlSeconds) *
    1000;
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
      provisionWithSandbox(env, session, undefined, claim.lease, claim.fence),
    stageClaimCleanup: (claim, message, now) =>
      stageStandaloneSandboxClaimCleanup(env, claim, message, now),
    queuePolicyCleanup: (provisionId, sandboxId, now) =>
      queueSandboxCredentialPolicyCleanup(env, provisionId, sandboxId, now),
    activate: (provisionId, claim, result, now) =>
      activateStandaloneSandboxProvision(env, provisionId, claim, result, now),
    providerError: safeProviderError,
  });
}

async function provisionInteractiveEndpoint(
  request: Request,
  env: RuntimeEnv,
): Promise<InteractiveProvisionResult> {
  authorizeProvisionBearerToken(request, env);
  const session = await readJson<Partial<InteractiveProvisionRequest>>(request);
  const id = clean(session.id, 120);
  const repo = normalizeRepo(session.repo);
  const branch = clean(session.branch, 120) || "main";
  const runtime = oneOf(session.runtime, ["crabbox", "container"], "container") as
    | "crabbox"
    | "container";
  const command = interactiveCommand(session.command);
  const { profile } = selectedRuntimeProfile(deploymentConfig(env), session.profile);
  const prompt = clean(session.prompt, 4000);
  const purpose = interactiveSessionPurpose(session.purpose, prompt, repo, branch, command);
  const summary = interactiveSessionSummary(session.summary, purpose, prompt);
  const owner = clean(session.owner, 240);
  const githubToken = clean(session.githubToken, 4000) || undefined;
  if (!id || !repo || !owner) {
    return failedProvision("interactive provision failed: invalid session request");
  }
  const payload: InteractiveProvisionRequest = {
    id,
    repo,
    branch,
    runtime,
    profile,
    command,
    prompt,
    purpose,
    summary,
    owner,
    createdBy: clean(session.createdBy, 240) || owner,
    parentSessionId: clean(session.parentSessionId, 120) || null,
    rootSessionId: clean(session.rootSessionId, 120) || id,
    ...(githubToken ? { githubToken } : {}),
  };
  const managed = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", payload.id)
    .executeTakeFirst();
  if (managed && managed.preparation_pending !== 0) {
    return failedProvision("interactive provision failed: managed session preparation is pending");
  }
  if (managed) {
    if (payload.runtime !== "container" || !env.SANDBOX) {
      return failedProvision(
        "interactive provision failed: managed session id is not available to this backend",
      );
    }
    return managedSandboxProvisioningService(env).provision(payload, managed);
  }
  if (interactiveProvisioningService(env).supportsStandalone(payload.runtime)) {
    return standaloneSandboxProvisioningService(env).provision(payload);
  }
  return failedProvision(
    payload.runtime === "container"
      ? "interactive provision failed: Cloudflare Sandbox binding is not configured"
      : "interactive provision failed: standalone provision supports container runtime only",
  );
}

async function stopStandaloneSandboxProvision(
  request: Request,
  env: RuntimeEnv,
  provisionId: string,
): Promise<InteractiveProvisionResult> {
  authorizeProvisionBearerToken(request, env);
  const owner = await database(env)
    .selectFrom("standalone_sandbox_provisions")
    .selectAll()
    .where("id", "=", provisionId)
    .executeTakeFirst();
  if (!owner) throw notFound("standalone Sandbox provision not found");
  const now = Date.now();
  const staged = await stageStandaloneSandboxProvisionCleanup(
    env,
    owner,
    "standalone Sandbox stop requested",
    now,
  );
  if (!staged) throw conflict("standalone Sandbox ownership changed; retry stop");
  await reconcileCredentialPolicyCleanupBatch(env, now, provisionId);
  const remaining = await database(env)
    .selectFrom("standalone_sandbox_provisions")
    .select("state")
    .where("id", "=", provisionId)
    .executeTakeFirst();
  return {
    status: remaining ? "stopping" : "stopped",
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    expiresAt: null,
    expiresAtPresent: true,
    message: remaining ? "standalone Sandbox cleanup pending" : "standalone Sandbox stopped",
  };
}

function standaloneSandboxAttachUrl(env: RuntimeEnv, provisionId: string): string {
  const url = new URL(
    `/api/provision/interactive/${encodeURIComponent(provisionId)}/pty`,
    deploymentConfig(env).canonicalUrl,
  );
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

async function standaloneSandboxPty(
  request: Request,
  env: RuntimeEnv,
  provisionId: string,
): Promise<Response> {
  authorizeProvisionBearerToken(request, env);
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("websocket upgrade required");
  }
  if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
  const owner = await database(env)
    .selectFrom("standalone_sandbox_provisions")
    .selectAll()
    .where("id", "=", provisionId)
    .where("state", "=", "active")
    .executeTakeFirst();
  if (
    !owner?.lease_id ||
    !isCurrentSandboxLease(owner.lease_id) ||
    !owner.expires_at ||
    owner.expires_at <= Date.now() ||
    isManagedInteractiveSessionId(provisionId)
  ) {
    if (owner) {
      const now = Date.now();
      await stageStandaloneSandboxProvisionCleanup(
        env,
        owner,
        isManagedInteractiveSessionId(provisionId)
          ? "standalone provision used the reserved managed session namespace"
          : "standalone Sandbox provision expired",
        now,
      );
      await reconcileCredentialPolicyCleanupBatch(env, now, provisionId);
    }
    throw notFound("standalone Sandbox provision not found");
  }
  const lease = sandboxLeaseInfo({ id: provisionId, leaseId: owner.lease_id });
  if (lease.sandboxId !== owner.sandbox_id) {
    throw serviceUnavailable("standalone Sandbox ownership is inconsistent");
  }
  const policyGeneration = await activeSandboxCredentialPolicyGeneration(
    env,
    provisionId,
    owner.sandbox_id,
  );
  if (!policyGeneration) {
    throw serviceUnavailable("standalone Sandbox credentials are unavailable");
  }
  const terminalOwnership: StandaloneSandboxTerminalOwnership = {
    provisionId,
    requestHash: owner.request_hash,
    sandboxId: owner.sandbox_id,
    leaseId: owner.lease_id,
    expiresAt: owner.expires_at,
    updatedAt: owner.updated_at,
    policyGeneration,
  };
  const terminalGrant = standaloneSandboxTerminalGrant(env, terminalOwnership);
  if (!(await terminalGrant())) {
    throw serviceUnavailable("standalone Sandbox terminal authorization changed");
  }
  const sandbox = getSandbox(env.SANDBOX, owner.sandbox_id);
  let response: Response;
  try {
    const terminalSession = await sandbox.getSession(lease.terminalSessionId);
    const terminalHeaders = new Headers(sanitizeTrustedProxyRequest(request, env).headers);
    terminalHeaders.delete("authorization");
    terminalHeaders.delete("cookie");
    response = await terminalSession.terminal(new Request(request, { headers: terminalHeaders }), {
      cols: terminalSize(request, "cols", 120),
      rows: terminalSize(request, "rows", 34),
      shell: sandboxTerminalShellPath(provisionId),
    });
  } catch (error) {
    throw serviceUnavailable(`standalone Sandbox terminal failed: ${safeProviderError(error)}`);
  }
  if (!response.webSocket || response.status !== 101) {
    throw serviceUnavailable(`standalone Sandbox terminal HTTP ${response.status}`);
  }
  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  response.webSocket.accept();
  bridgeWebSockets(server, response.webSocket, {
    canSendLeft: terminalGrant,
    deniedReason: "standalone Sandbox authorization revoked or expired",
  });
  return new Response(null, { status: 101, webSocket: client });
}

function standaloneSandboxTerminalGrant(
  env: RuntimeEnv,
  ownership: StandaloneSandboxTerminalOwnership,
): () => Promise<boolean> {
  return cachedBooleanGrant(async () => {
    const now = Date.now();
    const owner = await database(env)
      .selectFrom("standalone_sandbox_provisions")
      .select("id")
      .where("id", "=", ownership.provisionId)
      .where("request_hash", "=", ownership.requestHash)
      .where("sandbox_id", "=", ownership.sandboxId)
      .where("state", "=", "active")
      .where("lease_id", "=", ownership.leaseId)
      .where("expires_at", "=", ownership.expiresAt)
      .where("expires_at", ">", now)
      .where("updated_at", "=", ownership.updatedAt)
      .where(
        activeSandboxCredentialPolicyCondition(
          env,
          ownership.provisionId,
          ownership.sandboxId,
          ownership.policyGeneration,
          ownership.updatedAt,
        ),
      )
      .executeTakeFirst();
    return Boolean(owner);
  });
}

function authorizeProvisionBearerToken(request: Request, env: RuntimeEnv): void {
  if (!env.CRABBOX_INTERACTIVE_PROVISION_TOKEN) {
    throw serviceUnavailable("interactive provision token is not configured");
  }
  const expected = `Bearer ${env.CRABBOX_INTERACTIVE_PROVISION_TOKEN}`;
  if (request.headers.get("authorization") !== expected) throw unauthorized();
}

function sandboxProvisionPreflightError(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
): string | null {
  if (!env.SANDBOX) return "Cloudflare Sandbox binding is not configured";
  if (!env.SESSION_CONTROL) return "SESSION_CONTROL Durable Object is not configured";
  if (!env.OPENAI_API_KEY) {
    return "OPENAI_API_KEY is not configured for Cloudflare Sandbox Codex";
  }
  if (session.githubToken && !env.CRABBOX_TOKEN_ENCRYPTION_KEY && !env.GITHUB_CLIENT_SECRET) {
    return "CRABBOX_TOKEN_ENCRYPTION_KEY or GITHUB_CLIENT_SECRET is required for user GitHub tokens";
  }
  return null;
}

async function stageFailedManagedSandboxProvision(
  env: RuntimeEnv,
  sessionId: string,
  ownershipFence: SandboxLeaseRefreshFence,
  message: string,
  now: number,
): Promise<boolean> {
  const staged = await stageTerminalCredentialPolicyCleanupById(
    env,
    sessionId,
    "failed",
    message,
    now,
    message,
    ownershipFence,
  );
  await reconcileCredentialPolicyCleanupBatch(env, now, sessionId);
  return staged;
}

async function provisionWithSandbox(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  agentToken: string | undefined,
  lease: SandboxLease,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<InteractiveProvisionResult> {
  try {
    const preflightError = sandboxProvisionPreflightError(env, session);
    if (preflightError) throw new Error(preflightError);
    const workdir = sandboxWorkdir(session.id);
    const sandbox = getSandbox(env.SANDBOX!, lease.sandboxId);
    if (!("provisionId" in ownershipFence) && !agentToken) {
      throw new Error("managed Sandbox agent token is unavailable");
    }
    await registerSandboxCredentialPolicy(env, session, lease.sandboxId, ownershipFence);
    await setupSandboxTerminalSession(
      sandbox,
      env,
      session,
      workdir,
      lease.terminalSessionId,
      agentToken,
    );
  } catch (error) {
    const message = safeProviderError(error);
    const cleanupMessage = `Cloudflare Sandbox provision failed: ${message}`;
    const failureAt = Date.now();
    if ("provisionId" in ownershipFence) {
      await queueSandboxCredentialPolicyCleanup(env, session.id, lease.sandboxId, failureAt);
    } else {
      await stageTerminalCredentialPolicyCleanupById(
        env,
        session.id,
        "failed",
        cleanupMessage,
        failureAt,
        cleanupMessage,
        ownershipFence,
      );
    }
    await reconcileCredentialPolicyCleanupBatch(env, Date.now(), session.id);
    return {
      status: "stopping",
      leaseId: sandboxLeaseId(lease),
      attachUrl: null,
      vncUrl: null,
      message: `${cleanupMessage}; credential cleanup pending`,
      terminalStatus: "failed",
      createPending: false,
    };
  }

  return {
    status: "ready",
    leaseId: sandboxLeaseId(lease),
    attachUrl:
      "provisionId" in ownershipFence
        ? standaloneSandboxAttachUrl(env, session.id)
        : "/api/terminal/ws",
    vncUrl: null,
    message: `Cloudflare Sandbox ready for ${session.repo}`,
  };
}

async function ensureCurrentSandboxLease(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  session: InteractiveSession & { githubToken?: string },
): Promise<InteractiveSession & { githubToken?: string }> {
  if (!env.SANDBOX) return session;
  if (!isSandboxInteractiveSession(session)) {
    throw serviceUnavailable("session is not backed by a Cloudflare Sandbox lease");
  }
  if (session.runtime === githubActionsRuntime) {
    throw badRequest("GitHub Actions sessions do not use Cloudflare Sandbox leases");
  }
  if (isCurrentSandboxLease(session.leaseId)) {
    await ensureSandboxCredentialPolicy(env, session, sandboxLeaseInfo(session).sandboxId);
    return session;
  }
  const originalLeaseId = session.leaseId;
  if (!originalLeaseId) {
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  const refreshStartedAt = sandboxLeaseRefreshStartedAt(originalLeaseId);
  const now = Date.now();
  if (refreshStartedAt && now - refreshStartedAt < 2 * 60_000) {
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  if (!user || actor(user) !== session.owner) {
    throw serviceUnavailable("session owner must reconnect to refresh Cloudflare Sandbox lease");
  }
  const githubToken = user?.subject.startsWith("github:")
    ? (session.githubToken ?? (await sessionGitHubToken(request, env, user.subject)))
    : undefined;
  if (user.subject.startsWith("github:") && !githubToken) {
    throw forbidden("GitHub PR credentials are not connected; sign in with GitHub again");
  }
  const refreshPayload: InteractiveProvisionRequest = {
    id: session.id,
    parentSessionId: session.parentSessionId,
    rootSessionId: session.rootSessionId ?? session.id,
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
    ...(githubToken ? { githubToken } : {}),
  };
  const preflightError = sandboxProvisionPreflightError(env, refreshPayload);
  if (preflightError) throw serviceUnavailable(preflightError);
  const fallbackLeaseId = sandboxLeaseWithoutRefresh(originalLeaseId);
  const oldSandboxId = originalLeaseId.startsWith(sandboxLeasePrefix)
    ? sandboxLeaseInfo({ id: session.id, leaseId: fallbackLeaseId }).sandboxId
    : null;
  const refreshLeaseId = `${fallbackLeaseId}:refreshing-${now}-${crypto.randomUUID().slice(0, 8)}`;
  const refreshLease = newSandboxLease(session.id);
  const agentToken = newAgentToken();
  const agentTokenHash = await sha256(agentToken);
  const refreshFence: SandboxLeaseRefreshFence = {
    claim: `refresh:${crypto.randomUUID()}`,
    expiresAt: now + credentialPolicyProvisioningStaleMs,
    refreshLeaseId,
    sandboxId: refreshLease.sandboxId,
  };
  const claim = await database(env)
    .updateTable("interactive_sessions")
    .set({
      lease_id: refreshLeaseId,
      sandbox_refresh_sandbox_id: refreshFence.sandboxId,
      sandbox_refresh_claim: refreshFence.claim,
      sandbox_refresh_claim_expires_at: refreshFence.expiresAt,
      agent_token_hash: agentTokenHash,
      last_event: "Cloudflare Sandbox lease refresh started",
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where("id", "=", session.id)
    .where("lease_id", "=", originalLeaseId)
    .where("status", "in", ["ready", "attached", "detached"])
    .executeTakeFirst();
  if ((claim.numUpdatedRows ?? 0n) === 0n) {
    const current = await readInteractiveSession(env, session.id);
    if (current && isSandboxInteractiveSession(current) && isCurrentSandboxLease(current.leaseId)) {
      return current;
    }
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  let provisioned: InteractiveProvisionResult;
  try {
    provisioned = await provisionWithSandbox(
      env,
      refreshPayload,
      agentToken,
      refreshLease,
      refreshFence,
    );
  } catch (error) {
    const message = `Cloudflare Sandbox lease refresh failed: ${safeProviderError(error)}`;
    await stageFailedManagedSandboxProvision(env, session.id, refreshFence, message, Date.now());
    throw serviceUnavailable(message);
  }
  if (provisioned.status !== "ready") {
    await stageFailedManagedSandboxProvision(
      env,
      session.id,
      refreshFence,
      provisioned.message,
      Date.now(),
    );
    throw serviceUnavailable(provisioned.message);
  }
  const refreshedAt = Date.now();
  const expectedLeaseId = sandboxLeaseId(refreshLease);
  if (provisioned.leaseId !== expectedLeaseId) {
    await stageFailedManagedSandboxProvision(
      env,
      session.id,
      refreshFence,
      "Cloudflare Sandbox lease refresh returned an unexpected lease",
      refreshedAt,
    );
    throw serviceUnavailable("Cloudflare Sandbox lease refresh returned an unexpected lease");
  }
  const db = database(env);
  const commitQueries: CompilableQuery[] = [
    db
      .updateTable("interactive_sessions")
      .set({
        status: provisioned.status,
        lease_id: provisioned.leaseId,
        attach_url: provisioned.attachUrl,
        vnc_url: provisioned.vncUrl,
        sandbox_refresh_sandbox_id: null,
        sandbox_refresh_claim: null,
        sandbox_refresh_claim_expires_at: null,
        last_event: "Cloudflare Sandbox lease refreshed",
        updated_at: sql<number>`MAX(updated_at + 1, ${refreshedAt})`,
      })
      .where("id", "=", session.id)
      .where(sql<boolean>`lease_id IS ${refreshFence.refreshLeaseId}`)
      .where("sandbox_refresh_sandbox_id", "=", refreshFence.sandboxId)
      .where("sandbox_refresh_claim", "=", refreshFence.claim)
      .where("sandbox_refresh_claim_expires_at", "=", refreshFence.expiresAt)
      .where("sandbox_refresh_claim_expires_at", ">", refreshedAt)
      .where("agent_token_hash", "=", agentTokenHash)
      .where("status", "in", ["ready", "attached", "detached"]),
  ];
  if (oldSandboxId && oldSandboxId !== refreshLease.sandboxId) {
    commitQueries.push(
      db
        .updateTable("interactive_session_credential_policies")
        .set({
          state: "cleanup_pending",
          cleanup_claim: null,
          cleanup_claim_expires_at: null,
          updated_at: refreshedAt,
        })
        .where("session_id", "=", session.id)
        .where("sandbox_id", "=", oldSandboxId).where(sql<boolean>`
          EXISTS (
            SELECT 1
            FROM interactive_sessions AS session
            WHERE session.id = ${session.id}
              AND session.lease_id = ${provisioned.leaseId}
              AND session.sandbox_refresh_claim IS NULL
          )
        `),
    );
  }
  await executeBatch(env, commitQueries);
  const committed = await db
    .selectFrom("interactive_sessions")
    .select(["lease_id", "status", "credential_cleanup_terminal_status", "agent_token_hash"])
    .where("id", "=", session.id)
    .executeTakeFirst();
  if (
    committed?.lease_id !== provisioned.leaseId ||
    committed.agent_token_hash !== agentTokenHash ||
    committed.credential_cleanup_terminal_status !== null ||
    !["ready", "attached", "detached"].includes(committed.status)
  ) {
    await stageFailedManagedSandboxProvision(
      env,
      session.id,
      refreshFence,
      "Cloudflare Sandbox lease refresh ownership changed",
      refreshedAt,
    );
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  if (oldSandboxId && oldSandboxId !== refreshLease.sandboxId) {
    await reconcileCredentialPolicyCleanupBatch(env, refreshedAt, session.id);
  }
  const current = await readInteractiveSession(env, session.id);
  if (
    !current ||
    current.leaseId !== provisioned.leaseId ||
    !["ready", "attached", "detached"].includes(current.status)
  ) {
    throw serviceUnavailable("previous Cloudflare Sandbox credential cleanup stopped the session");
  }
  await appendInteractiveSessionLog(
    env,
    session.id,
    user,
    "Cloudflare Sandbox lease refreshed",
    refreshedAt,
  );
  const latest = await readInteractiveSession(env, session.id);
  if (
    !latest ||
    latest.leaseId !== provisioned.leaseId ||
    !["ready", "attached", "detached"].includes(latest.status)
  ) {
    throw serviceUnavailable("previous Cloudflare Sandbox credential cleanup stopped the session");
  }
  return { ...latest, ...(githubToken ? { githubToken } : {}) };
}

async function createCard(request: Request, env: RuntimeEnv, user: User): Promise<{ card: Card }> {
  const body = await readJson<{
    title?: string;
    prompt?: string;
    repo?: string;
    source?: string;
    runtime?: string;
    policy?: string;
  }>(request);
  const prompt = clean(body.prompt, 4000);
  const title = clean(body.title, 140) || titleFromPrompt(prompt);
  const repo = normalizeRepo(body.repo);
  if (!prompt || !repo) throw badRequest("prompt and repo are required");
  await requireRepo(env, repo);

  const now = Date.now();
  const workflow = await ensureWorkflowForRepo(env, repo, now);
  const workflowConfig = workflow?.status === "ok" ? workflow.config : undefined;
  const source = oneOf(body.source, ["Prompt", "Issue", "PR"], "Prompt");
  const runtime = oneOf(body.runtime, runtimeOptions, "auto");
  const policy = resolveCardPolicy(body.policy, workflowConfig);
  const owner = user.login ?? user.email ?? user.subject;
  const db = database(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = await nextCardId(env);
    try {
      await db
        .insertInto("cards")
        .values({
          id,
          title,
          prompt,
          repo,
          source,
          runtime,
          policy,
          lane: "Todo",
          owner,
          started_at: null,
          created_at: now,
          updated_at: now,
          last_event: "card created",
          changed_files: "[]",
          diff_patch: "",
          active_run_id: null,
        })
        .execute();
      await db
        .insertInto("events")
        .values([
          { card_id: id, actor: actor(user), message: "card created", created_at: now },
          { card_id: id, actor: actor(user), message: "repo allowlist ok", created_at: now + 1 },
        ])
        .execute();
      return { card: (await readCard(env, id)) as Card };
    } catch (error) {
      if (!isConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("failed to allocate card id");
}

async function claimRunning(
  env: RuntimeEnv,
  user: User,
  card: Card,
  now: number,
): Promise<boolean> {
  await reconcileStalledRuns(env, now);
  const currentCard = (await readCard(env, card.id)) ?? card;
  await requireRepo(env, currentCard.repo);
  const settings = await readSettings(env);
  const cap = numberSetting(settings.cap, 20);
  const db = database(env);
  const existingRun =
    currentCard.run && activeRunStatuses.includes(currentCard.run.status) ? currentCard.run : null;
  if (existingRun) {
    await heartbeatRun(env, existingRun.id, user, now, "heartbeat ok");
    return true;
  }

  const workflow = await ensureWorkflowForRepo(env, currentCard.repo, now);
  const workflowConfig = workflow?.status === "ok" ? workflow.config : undefined;
  const attempt = await nextRunAttempt(env, currentCard.id);
  const runId = `${currentCard.id}-R${attempt}`;
  const descriptor = selectRuntimeDescriptor(currentCard, workflowConfig);
  const transition = await sql`
    UPDATE cards
      SET lane = 'Running',
        active_run_id = ${runId},
        started_at = COALESCE(started_at, ${now}),
        updated_at = ${now},
        last_event = ${"run queued"}
      WHERE id = ${currentCard.id}
        AND (active_run_id IS NULL OR active_run_id = '' OR active_run_id NOT IN (
          SELECT id FROM run_attempts WHERE status IN ('queued', 'leasing', 'running')
        ))
        AND (lane = 'Running' OR (
          SELECT count(*) FROM cards WHERE lane = 'Running' AND id <> ${currentCard.id}
        ) < ${cap})
  `.execute(db);
  if ((transition.numAffectedRows ?? 0n) === 0n) {
    const activeCount = await db
      .selectFrom("cards")
      .select(sql<number>`count(*)`.as("count"))
      .where("lane", "=", "Running")
      .executeTakeFirst();
    const message =
      Number(activeCount?.count ?? 0) >= cap
        ? `capacity blocked at cap ${cap}`
        : "run already active";
    await appendEvent(env, card.id, user, message, now);
    return false;
  }
  await db
    .insertInto("run_attempts")
    .values({
      id: runId,
      card_id: currentCard.id,
      attempt,
      runtime: descriptor.runtime,
      status: "queued",
      control_intent: null,
      lease_id: null,
      attach_url: null,
      vnc_url: null,
      selection_reason: descriptor.reason,
      capabilities_json: JSON.stringify(descriptor.capabilities),
      operator: null,
      last_heartbeat_at: now,
      started_at: now,
      ended_at: null,
      created_at: now,
      updated_at: now,
      error: null,
    })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await appendEvent(env, currentCard.id, user, `scheduler queued ${currentCard.repo}`, now + 1);
  await appendEvent(
    env,
    currentCard.id,
    user,
    `runtime=${descriptor.runtime} policy=${currentCard.policy} workflow=${workflow?.status ?? "unseen"} reason=${descriptor.reason}`,
    now + 2,
  );
  return true;
}

async function mutateCard(
  env: RuntimeEnv,
  user: User,
  id: string,
  action: string,
): Promise<{ card: Card }> {
  const card = await readCard(env, id);
  if (!card) throw notFound("card not found");
  const now = Date.now();

  if (action === "start" || action === "pulse") {
    const wasRunning = card.lane === "Running";
    if (!wasRunning) {
      if (!(await claimRunning(env, user, card, now))) {
        return { card: (await readCard(env, id)) as Card };
      }
    } else if (card.run && activeRunStatuses.includes(card.run.status)) {
      await heartbeatRun(env, card.run.id, user, now + 2, "heartbeat ok");
      return { card: (await readCard(env, id)) as Card };
    } else if (!(await claimRunning(env, user, card, now))) {
      return { card: (await readCard(env, id)) as Card };
    }
    await appendEvent(env, card.id, user, "heartbeat ok", now + 3);
    return { card: (await readCard(env, id)) as Card };
  }

  if (action === "advance") {
    const nextLane = lanes[(lanes.indexOf(card.lane) + 1) % lanes.length] ?? "Todo";
    if (nextLane === "Running") {
      await claimRunning(env, user, card, now);
      return { card: (await readCard(env, id)) as Card };
    }
    const startedAt = nextLane === "Running" ? now : card.startedAt;
    await database(env)
      .updateTable("cards")
      .set({
        lane: nextLane,
        started_at: startedAt,
        updated_at: now,
        last_event: `moved to ${nextLane}`,
      })
      .where("id", "=", card.id)
      .execute();
    if (
      card.run &&
      (activeRunStatuses.includes(card.run.status) ||
        (card.run.status === "review" && nextLane === "Done"))
    ) {
      await finishRunForLane(env, card.run.id, nextLane, user, now + 1);
    }
    await appendEvent(env, card.id, user, `moved to ${nextLane}`, now);
    return { card: (await readCard(env, id)) as Card };
  }

  if (action === "attach") {
    return { card: (await readCard(env, id)) as Card };
  }

  if (action === "watch") {
    await appendEvent(env, card.id, user, "watch attached", now);
    return { card: (await readCard(env, id)) as Card };
  }

  if (action === "takeover") {
    if (!card.run || !activeRunStatuses.includes(card.run.status)) {
      throw badRequest("no active run to take over");
    }
    if (!card.run.capabilities.takeover) throw badRequest("runtime does not support takeover");
    await database(env)
      .updateTable("run_attempts")
      .set({ operator: actor(user), control_intent: "takeover", updated_at: now })
      .where("id", "=", card.run.id)
      .execute();
    await appendEvent(env, card.id, user, "operator takeover granted", now);
    return { card: (await readCard(env, id)) as Card };
  }

  if (action === "stall") {
    if (!card.run || !activeRunStatuses.includes(card.run.status)) {
      throw badRequest("no active run to mark stalled");
    }
    await markCardStalled(env, card, user, now, "operator marked stalled");
    return { card: (await readCard(env, id)) as Card };
  }

  throw badRequest("unknown action");
}

async function updatePolicy(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<Record<string, unknown>> {
  const body = await readJson<{ cap?: number; retention?: string; merge?: string }>(request);
  const cap = Math.min(200, Math.max(1, Number.isFinite(body.cap) ? Number(body.cap) : 20));
  const retention = oneOf(body.retention, ["14", "30", "60"], "30");
  const merge = oneOf(body.merge, ["guarded", "maintainers", "disabled"], "guarded");
  const now = Date.now();
  await database(env)
    .insertInto("settings")
    .values([
      { key: "cap", value: String(cap) },
      { key: "retention", value: retention },
      { key: "merge", value: merge },
    ])
    .onConflict((oc) => oc.column("key").doUpdateSet({ value: sql<string>`excluded.value` }))
    .execute();
  await audit(env, user, `policy updated cap=${cap} retention=${retention} merge=${merge}`, now);
  return readState(request, env, user);
}

async function evaluateWorkflow(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<Record<string, unknown>> {
  const body = await readJson<{ repo?: string }>(request);
  const repo = normalizeRepo(body.repo) || deploymentConfig(env).preferredRepo;
  await requireRepo(env, repo);
  const workflow = await refreshWorkflowForRepo(env, repo, Date.now());
  await audit(env, user, `workflow evaluated ${repo} status=${workflow.status}`, Date.now());
  return readState(request, env, user);
}

async function addAllowEntry(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<Record<string, unknown>> {
  const body = await readJson<{ value?: string; role?: Role }>(request);
  const value = normalizeAllow(body.value);
  if (!value) throw badRequest("allow value is required");
  const role = oneOf(body.role, ["viewer", "maintainer", "owner"], "maintainer") as Role;
  const now = Date.now();
  await database(env)
    .insertInto("allow_entries")
    .values({ value, role, created_at: now, updated_at: now })
    .onConflict((oc) => oc.column("value").doUpdateSet({ role, updated_at: now }))
    .execute();
  await audit(env, user, `allowlist updated ${value} role=${role}`, now);
  return readState(request, env, user);
}

async function removeAllowEntry(
  request: Request,
  env: RuntimeEnv,
  user: User,
  value: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeAllow(value);
  await database(env).deleteFrom("allow_entries").where("value", "=", normalized).execute();
  await audit(env, user, `allowlist removed ${normalized}`, Date.now());
  return readState(request, env, user);
}

async function addRepo(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<Record<string, unknown>> {
  const body = await readJson<{ repo?: string }>(request);
  const repo = normalizeRepo(body.repo);
  if (!repo) throw badRequest("repo is required");
  if (!openClawGitHubRepoParts(repo)) throw badRequest("repo must be a GitHub owner/name");
  const now = Date.now();
  await database(env)
    .insertInto("repos")
    .values({ repo, enabled: 1, created_at: now, updated_at: now })
    .onConflict((oc) => oc.column("repo").doUpdateSet({ enabled: 1, updated_at: now }))
    .execute();
  await audit(env, user, `repo allowlisted ${repo}`, now);
  return readState(request, env, user);
}

async function removeRepo(
  request: Request,
  env: RuntimeEnv,
  user: User,
  repo: string,
): Promise<Record<string, unknown>> {
  const normalized = normalizeRepo(repo);
  await database(env)
    .updateTable("repos")
    .set({ enabled: 0, updated_at: Date.now() })
    .where("repo", "=", normalized)
    .execute();
  await audit(env, user, `repo removed ${normalized}`, Date.now());
  return readState(request, env, user);
}

async function searchGitHubRefs(
  request: Request,
  env: RuntimeEnv,
): Promise<{ matches: GitHubReference[] }> {
  const url = new URL(request.url);
  const number = Number(url.searchParams.get("number"));
  if (!Number.isInteger(number) || number < 1) throw badRequest("issue or PR number is required");

  const rows = await database(env)
    .selectFrom("repos")
    .select("repo")
    .where("enabled", "=", 1)
    .execute();
  const repos = sortRepos(rows.map((row) => row.repo)).slice(0, 160);
  const matches = env.GITHUB_TOKEN
    ? await fetchGitHubReferences(env, repos, number)
    : await fetchPublicGitHubReferences(env, repos, number);
  return { matches };
}

async function fetchGitHubReferences(
  env: RuntimeEnv,
  repos: string[],
  number: number,
): Promise<GitHubReference[]> {
  const targets = repos.flatMap((repo) => {
    const [owner, name] = repo.split("/");
    return owner && name ? [{ repo, owner, name }] : [];
  });
  if (!targets.length) return [];
  const selections = targets
    .map((target, index) => {
      const { owner, name } = target;
      return `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {
        issueOrPullRequest(number: $number) {
          __typename
          ... on Issue { number title state url body author { login } updatedAt }
          ... on PullRequest { number title state url body author { login } updatedAt }
        }
      }`;
    })
    .join("\n");
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      ...githubHeaders(env),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      query: `query CrabfleetRefs($number: Int!) { ${selections} }`,
      variables: { number },
    }),
  });
  if (response.status === 403 || response.status === 429) {
    throw serviceUnavailable("GitHub lookup rate limited; retry later");
  }
  if (!response.ok) throw serviceUnavailable("GitHub lookup failed; retry later");

  const payload = await response.json<{
    data?: Record<string, { issueOrPullRequest?: GitHubGraphqlRefPayload | null } | null>;
    errors?: { type?: string; message?: string }[];
  }>();
  if (
    payload.errors?.some((error) =>
      /rate|limit/i.test(`${error.type ?? ""} ${error.message ?? ""}`),
    )
  ) {
    throw serviceUnavailable("GitHub lookup rate limited; retry later");
  }
  return targets
    .flatMap((target, index) => {
      const item = payload.data?.[`r${index}`]?.issueOrPullRequest;
      return item ? [githubReferenceFromGraphql(target.repo, item)] : [];
    })
    .sort((left, right) =>
      sortRepoNames(left.repo, right.repo, deploymentConfig(env).preferredRepo),
    );
}

async function fetchPublicGitHubReferences(
  env: RuntimeEnv,
  repos: string[],
  number: number,
): Promise<GitHubReference[]> {
  const preferred = deploymentConfig(env).preferredRepo;
  const repo = repos.includes(preferred) ? preferred : repos[0];
  if (!repo) return [];
  const match = await fetchGitHubReference(env, repo, number);
  return match ? [match] : [];
}

async function fetchGitHubReference(
  env: RuntimeEnv,
  repo: string,
  number: number,
): Promise<GitHubReference | null> {
  const response = await fetch(`https://api.github.com/repos/${repo}/issues/${number}`, {
    headers: githubHeaders(env),
  });
  if (response.status === 404 || response.status === 410) return null;
  if (response.status === 403 || response.status === 429) {
    throw serviceUnavailable("GitHub search rate limited; retry later");
  }
  if (!response.ok) return null;

  const item = await response.json<GitHubIssuePayload>();
  return {
    repo,
    number: item.number,
    title: item.title,
    source: item.pull_request ? "PR" : "Issue",
    state: item.state,
    url: item.html_url,
    author: item.user?.login ?? null,
    updatedAt: item.updated_at,
    body: item.body ?? "",
  };
}

async function ensureWorkflowForRepo(
  env: RuntimeEnv,
  repo: string,
  now: number,
): Promise<RepoWorkflow | null> {
  const existing = await readWorkflowForRepo(env, repo);
  if (existing && now - existing.evaluatedAt < workflowCacheMs) return existing;
  try {
    return await refreshWorkflowForRepo(env, repo, now);
  } catch {
    return existing;
  }
}

async function refreshWorkflowForRepo(
  env: RuntimeEnv,
  repo: string,
  now: number,
): Promise<RepoWorkflow> {
  const response = await fetch(`https://api.github.com/repos/${repo}/contents/CRABBOX.md`, {
    headers: githubHeaders(env),
  });
  if (response.status === 404) {
    return writeWorkflowRow(env, {
      repo,
      status: "missing",
      sourcePath: "CRABBOX.md",
      sourceSha: null,
      config: {},
      prompt: "",
      error: "CRABBOX.md not found",
      evaluatedAt: now,
      updatedAt: now,
    });
  }
  if (response.status === 403 || response.status === 429) {
    throw serviceUnavailable("GitHub workflow lookup rate limited; retry later");
  }
  if (!response.ok) throw serviceUnavailable("GitHub workflow lookup failed; retry later");

  const payload = await response.json<GitHubContentPayload>();
  if (payload.encoding !== "base64" || !payload.content) {
    return writeWorkflowRow(env, {
      repo,
      status: "invalid",
      sourcePath: "CRABBOX.md",
      sourceSha: payload.sha ?? null,
      config: {},
      prompt: "",
      error: "unsupported CRABBOX.md encoding",
      evaluatedAt: now,
      updatedAt: now,
    });
  }

  const decoded = decodeBase64Text(payload.content);
  const parsed = parseWorkflowMarkdown(decoded);
  return writeWorkflowRow(env, {
    repo,
    status: parsed.error ? "invalid" : "ok",
    sourcePath: "CRABBOX.md",
    sourceSha: payload.sha ?? null,
    config: parsed.error ? {} : parsed.config,
    prompt: parsed.prompt,
    error: parsed.error,
    evaluatedAt: now,
    updatedAt: now,
  });
}

async function readWorkflowForRepo(env: RuntimeEnv, repo: string): Promise<RepoWorkflow | null> {
  const row = await database(env)
    .selectFrom("repo_workflows")
    .selectAll()
    .where("repo", "=", repo)
    .executeTakeFirst();
  return row ? repoWorkflow(row) : null;
}

async function readWorkflowSummaries(env: RuntimeEnv): Promise<RepoWorkflow[]> {
  const rows = await database(env)
    .selectFrom("repo_workflows")
    .select([
      "repo",
      "status",
      "source_path",
      "source_sha",
      "config_json",
      "error",
      "evaluated_at",
      "updated_at",
    ])
    .orderBy("updated_at", "desc")
    .limit(80)
    .execute();
  return rows.map((row) => repoWorkflow({ ...row, prompt: "" }));
}

async function writeWorkflowRow(env: RuntimeEnv, workflow: RepoWorkflow): Promise<RepoWorkflow> {
  await database(env)
    .insertInto("repo_workflows")
    .values({
      repo: workflow.repo,
      status: workflow.status,
      source_path: workflow.sourcePath,
      source_sha: workflow.sourceSha,
      config_json: JSON.stringify(workflow.config),
      prompt: workflow.prompt,
      error: workflow.error,
      evaluated_at: workflow.evaluatedAt,
      updated_at: workflow.updatedAt,
    })
    .onConflict((oc) =>
      oc.column("repo").doUpdateSet({
        status: workflow.status,
        source_path: workflow.sourcePath,
        source_sha: workflow.sourceSha,
        config_json: JSON.stringify(workflow.config),
        prompt: workflow.prompt,
        error: workflow.error,
        evaluated_at: workflow.evaluatedAt,
        updated_at: workflow.updatedAt,
      }),
    )
    .execute();
  return workflow;
}

function githubReferenceFromGraphql(repo: string, item: GitHubGraphqlRefPayload): GitHubReference {
  return {
    repo,
    number: item.number,
    title: item.title,
    source: item.__typename === "PullRequest" ? "PR" : "Issue",
    state: item.state.toLowerCase(),
    url: item.url,
    author: item.author?.login ?? null,
    updatedAt: item.updatedAt,
    body: item.body ?? "",
  };
}

async function readCards(env: RuntimeEnv): Promise<Card[]> {
  const db = database(env);
  const cards = await db
    .selectFrom("cards")
    .select([
      "id",
      "title",
      "prompt",
      "repo",
      "source",
      "runtime",
      "policy",
      "lane",
      "owner",
      "started_at",
      "created_at",
      "changed_files",
      "active_run_id",
    ])
    .orderBy("updated_at", "desc")
    .orderBy("created_at", "desc")
    .execute();
  if (!cards.length) return [];
  const runs = await readActiveRunsForCards(env);
  const eventRows = (
    await sql<{ card_id: string; message: string; created_at: number }>`
      SELECT card_id, message, created_at
      FROM (
        SELECT card_id, message, created_at, id,
          row_number() OVER (PARTITION BY card_id ORDER BY created_at DESC, id DESC) AS rank
        FROM events
        WHERE card_id IN (SELECT id FROM cards)
      )
      WHERE rank <= 80
      ORDER BY card_id ASC, created_at ASC, id ASC
    `.execute(db)
  ).rows;
  const logs = new Map<string, string[]>();
  for (const row of eventRows) {
    const line = `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`;
    logs.set(row.card_id, [...(logs.get(row.card_id) ?? []), line]);
  }
  return cards.map((card) => ({
    id: card.id,
    title: card.title,
    prompt: card.prompt,
    repo: card.repo,
    source: card.source,
    runtime: card.runtime,
    policy: card.policy,
    lane: card.lane,
    owner: card.owner,
    startedAt: card.started_at,
    createdAt: card.created_at,
    logs: logs.get(card.id) ?? [],
    changes: cardChanges(card.changed_files, ""),
    run: card.active_run_id ? (runs.get(card.active_run_id) ?? null) : null,
  }));
}

async function readCard(env: RuntimeEnv, id: string): Promise<Card | null> {
  const db = database(env);
  const card = await db
    .selectFrom("cards")
    .select([
      "id",
      "title",
      "prompt",
      "repo",
      "source",
      "runtime",
      "policy",
      "lane",
      "owner",
      "started_at",
      "created_at",
      "changed_files",
      "diff_patch",
      "active_run_id",
    ])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!card) return null;
  const runs = await readRunsByIds(env, card.active_run_id ? [card.active_run_id] : []);
  const eventRows = (
    await sql<{ message: string; created_at: number }>`
      SELECT message, created_at
      FROM (
        SELECT message, created_at, id
        FROM events
        WHERE card_id = ${card.id}
        ORDER BY created_at DESC, id DESC
        LIMIT 80
      )
      ORDER BY created_at ASC, id ASC
    `.execute(db)
  ).rows;
  return {
    id: card.id,
    title: card.title,
    prompt: card.prompt,
    repo: card.repo,
    source: card.source,
    runtime: card.runtime,
    policy: card.policy,
    lane: card.lane,
    owner: card.owner,
    startedAt: card.started_at,
    createdAt: card.created_at,
    logs: eventRows.map(
      (row) => `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`,
    ),
    changes: cardChanges(card.changed_files, card.diff_patch),
    run: card.active_run_id ? (runs.get(card.active_run_id) ?? null) : null,
  };
}

async function readRunsByIds(env: RuntimeEnv, ids: string[]): Promise<Map<string, RunAttempt>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return new Map();
  const rows = await database(env)
    .selectFrom("run_attempts")
    .selectAll()
    .where("id", "in", uniqueIds)
    .execute();
  return new Map(rows.map((row) => [row.id, runAttempt(row)]));
}

async function readActiveRunsForCards(env: RuntimeEnv): Promise<Map<string, RunAttempt>> {
  const rows = (
    await sql<RunAttemptTable>`
      SELECT run_attempts.*
      FROM run_attempts
      INNER JOIN cards ON cards.active_run_id = run_attempts.id
    `.execute(database(env))
  ).rows;
  return new Map(rows.map((row) => [row.id, runAttempt(row)]));
}

async function readRunsForCard(env: RuntimeEnv, cardId: string): Promise<RunAttempt[]> {
  const rows = await database(env)
    .selectFrom("run_attempts")
    .selectAll()
    .where("card_id", "=", cardId)
    .orderBy("attempt", "desc")
    .execute();
  return rows.map(runAttempt);
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
  const store: GitHubActionsWorkStateStore = {
    now: () => Date.now(),
    readRow: async (sessionId) =>
      (await database(env)
        .selectFrom("interactive_sessions")
        .selectAll()
        .where("id", "=", sessionId)
        .executeTakeFirst()) ?? null,
    persist: async (sessionId, values) => {
      await database(env)
        .updateTable("interactive_sessions")
        .set(values)
        .where("id", "=", sessionId)
        .execute();
    },
    appendEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
    disconnectRunner: (sessionId) => disconnectGitHubActionsRunner(env, sessionId),
    readSession: (sessionId) => readInteractiveSession(env, sessionId),
  };
  const current = await new GitHubActionsWorkStateService(store).update(session, body);
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
  const store: GitHubActionsRunnerConnectionStore = {
    now: () => Date.now(),
    persist: async (sessionId, values) => {
      await database(env)
        .updateTable("interactive_sessions")
        .set(values)
        .where("id", "=", sessionId)
        .execute();
    },
    appendEvent: (sessionId, message, now) =>
      appendInteractiveSessionEvent(env, sessionId, user, message, now),
  };
  await new GitHubActionsRunnerConnectionService(store).connect(session);
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

async function appendInteractiveSessionLog(
  env: RuntimeEnv,
  id: string,
  user: User | null,
  message: string,
  now = Date.now(),
): Promise<void> {
  await appendInteractiveSessionEventRecord(env, {
    sessionId: id,
    actor: user ? actor(user) : "system",
    message,
    now,
  });
}

async function readSettings(env: RuntimeEnv): Promise<Record<string, string>> {
  const rows = await database(env).selectFrom("settings").select(["key", "value"]).execute();
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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

async function nextCardId(env: RuntimeEnv): Promise<string> {
  const row = await database(env)
    .selectFrom("cards")
    .select(sql<number | null>`max(CAST(substr(id, 4) AS INTEGER))`.as("max_id"))
    .where("id", "like", "CY-%")
    .executeTakeFirst();
  return `CY-${String((row?.max_id ?? 100) + 1)}`;
}

async function nextRunAttempt(env: RuntimeEnv, cardId: string): Promise<number> {
  const row = await database(env)
    .selectFrom("run_attempts")
    .select(sql<number | null>`max(attempt)`.as("max_attempt"))
    .where("card_id", "=", cardId)
    .executeTakeFirst();
  return (row?.max_attempt ?? 0) + 1;
}

async function nextInteractiveSessionId(env: RuntimeEnv): Promise<string> {
  const db = database(env);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await sql.raw<{ next_id: number }>(allocateInteractiveSessionIdSql).execute(db);
    const id = formatInteractiveSessionId(Number(result.rows[0]?.next_id));
    if (!id) throw new Error("failed to allocate interactive session id");
    const standalone = await db
      .selectFrom("standalone_sandbox_provisions")
      .select("id")
      .where(sql<boolean>`id = ${id} COLLATE NOCASE`)
      .executeTakeFirst();
    if (!standalone) return id;
  }
  throw new Error("failed to allocate an unreserved interactive session id");
}

async function requireRepo(env: RuntimeEnv, repo: string): Promise<void> {
  const row = await database(env)
    .selectFrom("repos")
    .select("repo")
    .where("repo", "=", repo)
    .where("enabled", "=", 1)
    .executeTakeFirst();
  if (!row) throw forbidden(`repo blocked by allowlist: ${repo}`);
}

async function reconcileStalledRuns(env: RuntimeEnv, now: number): Promise<void> {
  const threshold = now - stallThresholdMs(await readSettings(env));
  const staleRuns = await database(env)
    .selectFrom("run_attempts")
    .select(["id", "card_id"])
    .where("status", "in", activeRunStatuses)
    .where("last_heartbeat_at", "<", threshold)
    .limit(25)
    .execute();
  if (!staleRuns.length) return;

  const db = database(env);
  const system = systemUser();
  for (const run of staleRuns) {
    const runUpdate = await db
      .updateTable("run_attempts")
      .set({
        status: "stalled",
        ended_at: now,
        updated_at: now,
        error: "heartbeat timeout",
      })
      .where("id", "=", run.id)
      .where("status", "in", activeRunStatuses)
      .where("last_heartbeat_at", "<", threshold)
      .executeTakeFirst();
    if ((runUpdate.numUpdatedRows ?? 0n) === 0n) continue;

    await executeBatch(env, [
      db
        .updateTable("cards")
        .set({
          lane: "Human Review",
          updated_at: now,
          last_event: "stalled; heartbeat timeout",
        })
        .where("id", "=", run.card_id)
        .where("active_run_id", "=", run.id),
      eventInsert(db, run.card_id, actor(system), "stalled; heartbeat timeout", now),
    ]);
  }
}

async function heartbeatRun(
  env: RuntimeEnv,
  runId: string,
  user: User,
  now: number,
  message: string,
): Promise<void> {
  const run = await database(env)
    .selectFrom("run_attempts")
    .select(["id", "card_id"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) return;
  const db = database(env);
  await executeBatch(env, [
    db
      .updateTable("run_attempts")
      .set({ status: "running", last_heartbeat_at: now, updated_at: now })
      .where("id", "=", runId)
      .where("status", "in", activeRunStatuses),
    eventInsert(db, run.card_id, actor(user), message, now),
    db
      .updateTable("cards")
      .set({ updated_at: now, last_event: message })
      .where("id", "=", run.card_id),
  ]);
}

async function finishRunForLane(
  env: RuntimeEnv,
  runId: string,
  lane: string,
  user: User,
  now: number,
): Promise<void> {
  const status: RunStatus =
    lane === "Done" ? "completed" : lane === "Human Review" ? "review" : "canceled";
  const run = await database(env)
    .selectFrom("run_attempts")
    .select(["id", "card_id"])
    .where("id", "=", runId)
    .executeTakeFirst();
  if (!run) return;
  const db = database(env);
  await executeBatch(env, [
    db
      .updateTable("run_attempts")
      .set({
        status,
        ended_at: now,
        updated_at: now,
        control_intent: status === "canceled" ? "cancel" : null,
      })
      .where("id", "=", runId),
    eventInsert(db, run.card_id, actor(user), `run ${status}`, now),
  ]);
}

async function markCardStalled(
  env: RuntimeEnv,
  card: Card,
  user: User,
  now: number,
  reason: string,
): Promise<void> {
  const db = database(env);
  if (!card.run) throw badRequest("no active run to mark stalled");
  const runUpdate = await db
    .updateTable("run_attempts")
    .set({
      status: "stalled",
      ended_at: now,
      updated_at: now,
      error: reason,
    })
    .where("id", "=", card.run.id)
    .where("card_id", "=", card.id)
    .where("status", "in", activeRunStatuses)
    .executeTakeFirst();
  if ((runUpdate.numUpdatedRows ?? 0n) === 0n) {
    throw badRequest("run is no longer active");
  }
  await executeBatch(env, [
    db
      .updateTable("cards")
      .set({
        lane: "Human Review",
        updated_at: now,
        last_event: "stalled; workspace preserved",
      })
      .where("id", "=", card.id)
      .where("active_run_id", "=", card.run.id),
    eventInsert(db, card.id, actor(user), reason, now),
  ]);
}

async function appendEvent(
  env: RuntimeEnv,
  cardId: string,
  user: User,
  message: string,
  now: number,
): Promise<void> {
  const db = database(env);
  await executeBatch(env, [
    eventInsert(db, cardId, actor(user), message, now),
    db.updateTable("cards").set({ updated_at: now, last_event: message }).where("id", "=", cardId),
  ]);
}

async function audit(env: RuntimeEnv, user: User, message: string, now: number): Promise<void> {
  await database(env)
    .insertInto("audit_events")
    .values({ actor: actor(user), message, created_at: now })
    .execute();
}

function eventInsert(
  db: Kysely<Database>,
  cardId: string,
  actorName: string,
  message: string,
  now: number,
): CompilableQuery {
  return db
    .insertInto("events")
    .values({ card_id: cardId, actor: actorName, message, created_at: now });
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function cardChanges(filesJson: string, patch: string): CardChanges {
  const files = parseJson<ChangedFile[]>(filesJson, []).filter(isChangedFile);
  return {
    files,
    patch,
    totals: {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files: files.length,
    },
  };
}

function isChangedFile(value: unknown): value is ChangedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ChangedFile>;
  return (
    typeof file.path === "string" &&
    ["added", "deleted", "modified", "renamed"].includes(String(file.status)) &&
    typeof file.additions === "number" &&
    typeof file.deletions === "number"
  );
}

function runAttempt(row: RunAttemptTable): RunAttempt {
  const capabilities = runtimeCapabilities(row.runtime, row.capabilities_json);
  return {
    id: row.id,
    cardId: row.card_id,
    attempt: row.attempt,
    runtime: row.runtime,
    status: row.status,
    controlIntent: row.control_intent,
    leaseId: row.lease_id,
    attachUrl: capabilities.terminal ? row.attach_url : null,
    vncUrl: row.vnc_url,
    ptyAvailable: false,
    selectionReason: row.selection_reason,
    capabilities,
    operator: row.operator,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
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

async function canControlInteractiveSessionById(
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<boolean> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return false;
  const session = interactiveSession(row, []);
  if (!session.capabilities.terminal) return false;
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) return false;
  return canControlInteractiveSession(
    user,
    session,
    Date.now(),
    canGrantDelegatedControl(env, session),
  );
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

function repoWorkflow(row: RepoWorkflowTable): RepoWorkflow {
  return {
    repo: row.repo,
    status: row.status,
    sourcePath: row.source_path,
    sourceSha: row.source_sha,
    config: parseJson<WorkflowConfig>(row.config_json, {}),
    prompt: row.prompt,
    error: row.error,
    evaluatedAt: row.evaluated_at,
    updatedAt: row.updated_at,
  };
}

function parseWorkflowMarkdown(markdown: string): {
  config: WorkflowConfig;
  prompt: string;
  error: string | null;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { config: {}, prompt: markdown.trim().slice(0, 8000), error: null };
  const raw = parseFrontmatter(match[1] ?? "");
  const config: WorkflowConfig = {};
  const runtime = optionalOneOf(
    raw.runtime ?? raw.runtime_default ?? raw["runtime.default"],
    runtimeOptions,
  );
  const policy = optionalOneOf(
    raw.policy ??
      raw.merge_policy ??
      raw.merge_default_policy ??
      raw["merge.default_policy"] ??
      raw["merge.policy"],
    mergePolicyOptions,
  );
  const stallMs = numberConfig(raw.stall_ms ?? raw.stallMs ?? raw["runtime.stall_ms"]);
  const cap = numberConfig(raw.cap);
  if (runtime) config.runtime = runtime;
  if (policy) config.policy = policy;
  if (stallMs) config.stallMs = stallMs;
  if (cap) config.cap = cap;
  if (raw.prompt_prefix) config.promptPrefix = clean(raw.prompt_prefix, 1000);
  const errors = workflowConfigErrors(raw, { runtime, policy, stallMs, cap });
  return {
    config,
    prompt: (match[2] ?? "").trim().slice(0, 8000),
    error: errors.length ? errors.join("; ") : null,
  };
}

function parseFrontmatter(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = match[1] ?? "";
    const key = match[2] ?? "";
    const value = scalar(match[3] ?? "");
    if (!indent && !value) {
      section = key;
      continue;
    }
    const normalized = indent && section ? `${section}.${key}` : key;
    result[normalized] = value;
    if (!indent) section = "";
  }
  return result;
}

function scalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function optionalOneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined;
}

function numberConfig(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveCardPolicy(value: unknown, workflow?: WorkflowConfig): string {
  const workflowPolicy = optionalOneOf(workflow?.policy, mergePolicyOptions);
  const fallback = workflowPolicy ?? "open_pr";
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "default" ||
    value === "repo_default"
  ) {
    return fallback;
  }
  const policy = optionalOneOf(value, mergePolicyOptions);
  if (!policy) throw badRequest("invalid merge policy");
  return policy;
}

function workflowConfigErrors(
  raw: Record<string, string>,
  parsed: {
    runtime: string | undefined;
    policy: string | undefined;
    stallMs: number | undefined;
    cap: number | undefined;
  },
): string[] {
  const errors: string[] = [];
  const runtime = raw.runtime ?? raw.runtime_default ?? raw["runtime.default"];
  const policy =
    raw.policy ??
    raw.merge_policy ??
    raw.merge_default_policy ??
    raw["merge.default_policy"] ??
    raw["merge.policy"];
  const stallMs = raw.stall_ms ?? raw.stallMs ?? raw["runtime.stall_ms"];
  const cap = raw.cap;
  if (runtime && !parsed.runtime) errors.push(`unsupported runtime ${runtime}`);
  if (policy && !parsed.policy) errors.push(`unsupported merge policy ${policy}`);
  if (stallMs && !parsed.stallMs) errors.push(`invalid stall_ms ${stallMs}`);
  if (cap && !parsed.cap) errors.push(`invalid cap ${cap}`);
  return errors;
}

function selectRuntimeDescriptor(
  card: Pick<Card, "runtime" | "prompt">,
  workflow?: WorkflowConfig,
): RuntimeDescriptor {
  if (card.runtime === "crabbox") {
    return runtimeDescriptor("crabbox", "card runtime override");
  }
  if (card.runtime === "container") {
    return runtimeDescriptor("container", "card runtime override");
  }
  const needsCrabbox = /\b(vnc|manual|takeover|gpu|perf|performance)\b/i.test(card.prompt);
  if (needsCrabbox) {
    return runtimeDescriptor("crabbox", "prompt requires desktop/manual/perf capability");
  }
  if (workflow?.runtime === "crabbox") {
    return runtimeDescriptor("crabbox", "repo CRABBOX.md runtime default");
  }
  if (workflow?.runtime === "container") {
    return runtimeDescriptor("container", "repo CRABBOX.md runtime default");
  }
  return runtimeDescriptor("container", "default container runtime");
}

function runtimeDescriptor(
  runtime: RuntimeDescriptor["runtime"],
  reason: string,
): RuntimeDescriptor {
  return {
    runtime,
    reason,
    capabilities: runtime === "crabbox" ? crabboxCapabilities : containerCapabilities,
  };
}

function stallThresholdMs(settings: Record<string, string>): number {
  const parsed = Number(settings.stall_ms);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : defaultStallMs;
}

function systemUser(): User {
  return {
    subject: "system:crabfleet",
    login: "system",
    email: null,
    name: "Crabfleet",
    role: "owner",
    allowed: true,
    teams: [],
  };
}

function normalizeAllow(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (raw.includes("@")) return raw.toLowerCase();
  return `@${raw.toLowerCase()}`;
}

function clean(value: unknown, max: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, max);
}

function decodeHeaderValue(value: string | null): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeClipboardFilename(value: unknown, mediaType: string): string {
  const raw =
    String(value ?? "")
      .split(/[\\/]/)
      .pop() || "";
  const base = clean(raw || `clipboard${clipboardExtension(mediaType)}`, 90)
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/^-+/, "")
    .replace(/-+/g, "-");
  const fallback = `clipboard${clipboardExtension(mediaType)}`;
  const name = base || fallback;
  return name.includes(".") ? name : `${name}${clipboardExtension(mediaType)}`;
}

function clipboardExtension(mediaType: string): string {
  const normalized = (mediaType.toLowerCase().split(";")[0] ?? "").trim();
  return (
    {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "text/plain": ".txt",
      "text/markdown": ".md",
      "application/json": ".json",
      "application/pdf": ".pdf",
    }[normalized] || ".bin"
  );
}

function titleFromPrompt(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return clean(line?.replace(/^#+\s*/, ""), 140) || "Untitled card";
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function decodeBase64Text(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function sortRepos(repos: string[], preferred = defaultPreferredRepo): string[] {
  return [...repos].sort((left, right) => sortRepoNames(left, right, preferred));
}

function sortRepoNames(left: string, right: string, preferred = defaultPreferredRepo): number {
  if (left === preferred) return -1;
  if (right === preferred) return 1;
  return left.localeCompare(right);
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
