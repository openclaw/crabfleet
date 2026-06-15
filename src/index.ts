import { sql, type Kysely, type RawBuilder, type Selectable, type UpdateObject } from "kysely";
import {
  ContainerProxy,
  Sandbox as CloudflareSandboxBase,
  getSandbox,
  type BackupOptions,
  type DirectoryBackup,
  type Sandbox as CloudflareSandbox,
  type SessionTerminatedError as CloudflareSandboxSessionError,
} from "@cloudflare/sandbox";
import { DurableObject } from "cloudflare:workers";
import {
  TerminalMessageType,
  TerminalSubscribeFlags,
  decodeAckPayload,
  decodeTerminalFrame,
  decodeResizePayload,
  decodeSubscribePayload,
  encodeJsonPayload,
  encodeTerminalFrame,
} from "./terminal-protocol";
import {
  attributedTerminalInputPayloads,
  newTerminalInputState,
  terminalSubmittedLine,
  type TerminalInputState,
} from "./terminal-multiplayer";
import {
  buildFleetState,
  ptyRouteKind,
  type FleetSandboxPolicySummary,
  type FleetState,
  type PtyRouteKind,
} from "./fleet-state";
import {
  buildGitHubActionsRunnerPtyUrl,
  forwardGitHubActionsRelayMessage,
  gitHubActionsSessionStatus,
  gitHubActionsWorkEvent,
  githubActionsRelayRole,
  githubActionsRuntime,
  isTerminalGitHubActionsWorkState,
  notifyGitHubActionsViewers,
  parseGitHubActionsWorkState,
  replaceGitHubActionsRunner,
  githubActionsCapabilities,
} from "./github-actions-runtime";
import { githubRequestCanUseRepoCredential, matchesAnyHost } from "./sandbox-security";
import { githubOAuthCanonicalSshLinkUrl, githubOAuthRedirectUri } from "./oauth";
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
import {
  appCanonicalHost,
  appCanonicalOrigin,
  appRedirectHosts,
  canonicalAppRedirect,
  productHostResponse,
} from "./canonical-host";
import {
  adapterFailureReleaseState,
  adapterWorkspaceIdMatches,
  clearedAdapterCapabilities,
  createOnlyAdapterStatus,
  definitiveRuntimeAdapterCreateFailure,
  effectiveAdapterCapabilities,
  currentAdapterDesktopConnection,
  legacyLeaseIdForAdapter,
  namespacedAdapterWorkspaceId,
  normalizeAdapterNamespace,
  normalizeAdapterWorkspaceId,
  parseAdapterWorkspaceResult,
  redactedAdapterMessage,
  redactedAdapterResponseMessage,
  runtimeAdapterCreatePayload,
  runtimeAdapterCollectionUrl,
  runtimeAdapterControlPlaneForProfile,
  runtimeAdapterControlPlaneIdentity,
  runtimeAdapterBrowserVncUrl,
  runtimeAdapterDesktopUrl,
  runtimeAdapterName,
  runtimeAdapterReplayRequest,
  retainedRuntimeAdapterFailureMessage,
  runtimeAdapterStopOutcome,
  runtimeAdapterTerminalFailureStatus,
  runtimeAdapterTerminalOriginMatches,
  runtimeAdapterWorkspaceIdConflict,
  runtimeAdapterWorkspaceUrl,
  resolveCreateAfterStopRace,
  safeDesktopUrl,
  safeWebSocketUrl,
  shouldReplayRuntimeAdapterCreate,
  validatedRuntimeAdapterCreatePayloadJson,
  type AdapterProvisionRecord,
  type AdapterWorkspaceResult,
} from "./runtime-adapter";
import { allocateInteractiveSessionIdSql, formatInteractiveSessionId } from "./session-id";
import { preferredEnabledRepo } from "./repo-selection";
import { sandboxGitAuthorEmail } from "./git-identity";
import { completeTerminalFinalization } from "./terminal-finalization";
import { sizedTerminalTargetUrl } from "./terminal-target";
import { cachedBooleanGrant } from "./terminal-authorization";
import { obsoleteSessionArchiveObjectKeys, sessionArchiveAttemptKeys } from "./session-archive";
import { readBoundedResponseText } from "./bounded-response";
import {
  openClawBranchPreparationCanDefer,
  openClawGitBranchAllowed,
  openClawGitHubRepoParts,
  openClawRoomMaxSessions,
  openClawServiceAuthorized,
} from "./openclaw-service";
import {
  sanitizeTrustedProxyRequest,
  trustedProxyPublicOrigin,
  type TrustedProxyAuthResult,
} from "./trusted-proxy-auth";
import {
  credentialPolicyCleanupMatches,
  credentialPolicyMigrationCleanupMatches,
  credentialPolicyRegistrationAccepted,
  credentialPolicySandboxIsExpected,
  migratedCredentialPolicyRecord,
  type CredentialPolicyGenerationRecord,
  type CredentialPolicyGenerationTombstone,
  type CredentialPolicyLegacyMigration,
} from "./credential-policy-fence";
import {
  resolveRuntimeProfileCodexSsh,
  runtimeProfileByID,
  runtimeProfileCapabilities,
} from "./runtime-profiles";
import {
  browserAppOrigin,
  clientDeploymentConfig,
  defaultPreferredRepo,
  deploymentConfig,
  publicDeploymentConfig,
  selectedRuntimeProfile,
} from "./worker/deployment";
import type { RuntimeEnv } from "./worker/env";
import {
  database,
  executeBatch,
  type CompilableQuery,
  type Database,
  type InteractiveSessionCredentialPolicyTable,
  type InteractiveSessionLogArchiveTable,
  type InteractiveSessionRow,
  type RepoWorkflowTable,
  type RunAttemptTable,
  type StandaloneSandboxProvisionTable,
} from "./worker/database";
import {
  deadInteractiveSessionStatuses,
  type InteractiveRuntime,
  type InteractiveSessionStatus,
  type Role,
  type RunStatus,
  type User,
  type WorkflowStatus,
} from "./worker/models";
import {
  badRequest,
  bearer,
  bearerToken,
  conflict,
  cookie,
  forbidden,
  json,
  notFound,
  readJson,
  redirect,
  securityHeaders,
  serviceUnavailable,
  text,
  tooManyRequests,
  unauthorized,
  wantsMarkdown,
} from "./worker/http";
import { enforceWorkerIngressAuth, prepareWorkerIngress } from "./worker/ingress";
import {
  actor,
  authMethods,
  authorize,
  bootstrapSubject,
  createSession,
  devIdentityEnabled,
  devIdentityId,
  logout,
  optionalUser,
  parseRole,
  requireRole,
  requireUser,
  sessionGitHubToken,
  upsertUser,
} from "./worker/auth";
import { base64FromBytes, openSecret, sealSecret, sha256 } from "./worker/crypto";
import { githubCallback, githubLogin, sshLinkCookie } from "./worker/github-auth";
import { GitHubApiError, githubFetch, githubHeaders, refreshGitHubUser } from "./worker/github";
import {
  containerCapabilities,
  crabboxCapabilities,
  interactiveSession,
  interactiveSessionAdapterControlPlane,
  interactiveSessionEvent,
  interactiveSessionLogArchive,
  runtimeCapabilities,
  type InteractiveSession,
  type InteractiveSessionEvent,
  type InteractiveSessionEventRow,
  type InteractiveSessionLogArchive,
  type RuntimeCapabilities,
} from "./worker/session-model";
import { normalizeRepo } from "./worker/repositories";
import {
  openClawCrabboxRequestHash,
  openClawRequestId,
  readOpenClawRequestSession,
} from "./worker/openclaw-request";
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
import {
  buildOpenClawTranscript,
  openClawSessionSummary,
  openClawTranscriptEventWindow,
  openClawVisibleRoomSessions,
} from "./worker/openclaw-queries";
import { OpenClawMutationService, type OpenClawMutationStore } from "./worker/openclaw-mutations";

const defaultInteractiveCommand = "codex --yolo";

const sandboxPlaceholderOpenAIKey = "crabfleet-worker-injected";
const sandboxPlaceholderGitHubToken = "crabfleet-worker-injected";

type SandboxOutboundContext = {
  containerId: string;
};

type SandboxOutboundHandler = (
  request: Request,
  env: RuntimeEnv,
  context: SandboxOutboundContext,
) => Promise<Response> | Response;

type SandboxClassWithOutbound = {
  outbound?: SandboxOutboundHandler;
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

type SandboxRuntimeSession = (InteractiveProvisionRequest | InteractiveSession) & {
  githubToken?: string;
};

type SandboxLease = {
  sandboxId: string;
  terminalSessionId: string;
};

type SandboxLeaseRefreshFence = {
  claim: string;
  expiresAt: number;
  refreshLeaseId: string | null;
  sandboxId: string;
};

type SandboxCurrentLeaseFence = {
  leaseId: string;
  sandboxId: string;
};

type StandaloneSandboxProvisionFence = {
  claim: string;
  provisionId: string;
  sandboxId: string;
};

type SandboxManagedOwnershipFence = SandboxCurrentLeaseFence | SandboxLeaseRefreshFence;

type SandboxTerminalCleanupOwnership = {
  fence: SandboxManagedOwnershipFence;
  sandboxIds: string[];
  terminalLeaseId: string;
};

type SandboxCredentialPolicyOwnershipFence =
  | SandboxManagedOwnershipFence
  | StandaloneSandboxProvisionFence;

type InteractiveProvisionRequest = {
  id: string;
  adapterWorkspaceId?: string | null;
  adapterControlPlane?: string | null;
  adapterTtlSeconds?: number | null;
  adapterIdleTimeoutSeconds?: number | null;
  adapterRequestedCapabilities?: RuntimeCapabilities | null;
  adapterCreatePayloadJson?: string | null;
  parentSessionId: string | null;
  rootSessionId: string | null;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  profile: string;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
  githubToken?: string;
};

type InteractiveProvisionResult = {
  status: InteractiveSessionStatus;
  leaseId: string | null;
  attachUrl: string | null;
  attachUrlPresent?: boolean;
  vncUrl: string | null;
  message: string;
  adapter?: string | null;
  profile?: string;
  adapterWorkspaceId?: string | null;
  providerResourceId?: string | null;
  capabilities?: RuntimeCapabilities | null;
  capabilitiesPresent?: boolean;
  expiresAt?: number | null;
  expiresAtPresent?: boolean;
  reconciledAt?: number | null;
  reconcileError?: string | null;
  terminalStatus?: "failed" | null;
  createPending?: boolean;
};

type SandboxCredentialPolicy = {
  allowedHosts: string[];
  expiresAt?: number;
  githubCredentialSource?: "none" | "session" | "worker";
  githubRepo: string;
  githubRepoNodeId?: string;
  githubTokenCiphertext?: string;
  openAIBaseUrl?: string;
  openAIOrgId?: string;
  owner: string;
  sandboxId: string;
  sessionId: string;
};

type StoredSandboxCredentialPolicy = CredentialPolicyGenerationRecord<SandboxCredentialPolicy>;

type SandboxCredentialPolicyLegacyMigration = CredentialPolicyLegacyMigration & {
  sandboxIds: string[];
};

type SandboxCredentialPolicyRegistration = {
  generation: string;
  claim: string;
  lookupIds: string[];
};

type SandboxFleetPolicyResult = {
  available: boolean;
  policies: FleetSandboxPolicySummary[];
};

type SandboxCheckpoint = {
  backup: DirectoryBackup;
  createdAt: number;
  id: string;
  name: string;
  sessionId: string;
  workdir: string;
};

type InteractiveTerminalTarget = {
  url: string;
  authorization: string | null;
};

type TerminalHubSubscription = {
  session: InteractiveSession;
  upstream: WebSocket;
  canView: () => Promise<boolean>;
  canInput: () => Promise<boolean>;
  markClosing: (reason: string) => void;
  viewCheck: ReturnType<typeof setInterval> | null;
  cols: number;
  rows: number;
  outputAcknowledgements: boolean;
  outputAcknowledgementBytes: number;
};

type PendingTerminalSubscription = {
  unsubscribeRequested: boolean;
};

type TerminalUpstream = {
  socket: WebSocket;
  markConnected: () => Promise<void>;
  outputAcknowledgements: boolean;
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

type SandboxExecutionSession = Awaited<ReturnType<CloudflareSandbox["createSession"]>>;
type SandboxSessionTarget = Pick<SandboxExecutionSession, "exec" | "mkdir" | "setEnvVars">;

type ClawFleetInstancePayload = {
  name?: string;
  status?: string;
  novnc_port?: number;
  gateway_port?: number;
};

type CloudflareSandboxPayload = {
  id?: string;
  state?: string;
  workdir?: string;
  instanceType?: string;
  labels?: Record<string, string>;
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

const encoder = new TextEncoder();
const terminalInputStates = new Map<string, TerminalInputState>();
const sshLinkSeconds = 5 * 60;
const terminalClipboardMaxBytes = 10 * 1024 * 1024;
const lanes = ["Todo", "Running", "Human Review", "Done"];
const sandboxLeasePrefix = "sandbox:";
const sandboxLeaseProfile = "autostart-v4";
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
const terminalCleanupDeletePending = 2;
const credentialPolicyCleanupLimit = 8;
const credentialPolicyScanLimit = 32;
const credentialPolicyCleanupClaimMs = 30_000;
const credentialPolicyRegistrationClaimMs = 60_000;
const credentialPolicyProvisioningStaleMs = 15 * 60_000;
const credentialPolicyLegacyGenerationPrefix = "legacy:";
const credentialPolicyLegacyRepairClaimPrefix = "legacy-repair:";
const standaloneSandboxDefaultTtlSeconds = 14_400;
function runtimeAdapterCreateSettings(
  env: RuntimeEnv,
  capabilities: RuntimeCapabilities,
): {
  ttlSeconds: number;
  idleTimeoutSeconds: number;
  capabilities: RuntimeCapabilities;
} {
  return {
    ttlSeconds: clampedSeconds(env.CRABBOX_RUNTIME_ADAPTER_TTL_SECONDS, 14_400),
    idleTimeoutSeconds: clampedSeconds(env.CRABBOX_RUNTIME_ADAPTER_IDLE_SECONDS, 1_800),
    capabilities,
  };
}

const defaultSandboxEgressHosts = [
  "api.github.com",
  "api.openai.com",
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "uploads.github.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "*.githubusercontent.com",
  "*.npmjs.org",
  "*.nodejs.org",
  "*.openai.com",
  "*.yarnpkg.com",
];

const sandboxControlObjectName = "__session-control";
const sandboxPolicyKey = (sandboxId: string) => `sandbox:${sandboxId}`;
const sandboxPolicyTombstoneKey = (sandboxId: string, generation: string) =>
  `sandbox-tombstone:${encodeURIComponent(sandboxId)}:${encodeURIComponent(generation)}`;
const sandboxCheckpointListKey = (sessionId: string) => `checkpoints:${sessionId}`;
const sandboxCheckpointKey = (sessionId: string, checkpointId: string) =>
  `checkpoint:${sessionId}:${checkpointId}`;

function withAuthorization(request: Request, authorization?: string): Request {
  const next = new Request(request);
  if (authorization) {
    next.headers.set("authorization", authorization);
  } else {
    next.headers.delete("authorization");
  }
  return next;
}

function githubBasicAuth(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

function isGitHubHost(host: string): boolean {
  return (
    host === "api.github.com" ||
    host === "github.com" ||
    host === "codeload.github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "uploads.github.com"
  );
}

function withoutSandboxPlaceholderAuthorization(request: Request): Request {
  const authorization = request.headers.get("authorization");
  if (
    authorization !== `Bearer ${sandboxPlaceholderGitHubToken}` &&
    authorization !== `token ${sandboxPlaceholderGitHubToken}` &&
    authorization !== githubBasicAuth(sandboxPlaceholderGitHubToken)
  ) {
    return request;
  }
  return withAuthorization(request, undefined);
}

function sandboxControlStub(env: RuntimeEnv): DurableObjectStub<SessionControlDO> | null {
  if (!env.SESSION_CONTROL) return null;
  const id = env.SESSION_CONTROL.idFromName(sandboxControlObjectName);
  return env.SESSION_CONTROL.get(id);
}

function githubActionsRelayStub(
  env: RuntimeEnv,
  sessionId: string,
): DurableObjectStub<SessionControlDO> | null {
  if (!env.SESSION_CONTROL) return null;
  const id = env.SESSION_CONTROL.idFromName(`github-actions:${sessionId}`);
  return env.SESSION_CONTROL.get(id);
}

async function sandboxCredentialPolicy(
  env: RuntimeEnv,
  sandboxId: string,
): Promise<SandboxCredentialPolicy | null> {
  const stub = sandboxControlStub(env);
  if (!stub) return null;
  const policyUrl = `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(sandboxId)}`;
  let response = await stub.fetch(policyUrl);
  if (response.status === 409) {
    const legacy = (await response.json().catch(() => null)) as { sessionId?: unknown } | null;
    const legacySessionId = clean(legacy?.sessionId, 120);
    if (legacySessionId) {
      await repairLegacySandboxCredentialPolicyBatch(env, Date.now(), legacySessionId);
      response = await stub.fetch(policyUrl);
    }
  }
  if (!response.ok) return null;
  const generation = response.headers.get("x-crabfleet-policy-generation");
  const policy = (await response.json().catch(() => null)) as SandboxCredentialPolicy | null;
  if (
    !generation ||
    !policy ||
    !(await sandboxCredentialPolicyHasDurableOwner(env, sandboxId, generation, policy, Date.now()))
  ) {
    return null;
  }
  return policy;
}

async function sandboxCredentialPolicyHasDurableOwner(
  env: RuntimeEnv,
  lookupId: string,
  generation: string,
  policy: SandboxCredentialPolicy,
  now: number,
): Promise<boolean> {
  if (
    !generation ||
    policy.sandboxId !== lookupId ||
    typeof policy.sessionId !== "string" ||
    !policy.sessionId ||
    !Array.isArray(policy.allowedHosts) ||
    typeof policy.githubRepo !== "string" ||
    typeof policy.owner !== "string" ||
    (policy.expiresAt !== undefined &&
      (!Number.isFinite(policy.expiresAt) || policy.expiresAt <= now))
  ) {
    return false;
  }
  const db = database(env);
  const refs = await db
    .selectFrom("interactive_session_credential_policies")
    .select("sandbox_id")
    .where("session_id", "=", policy.sessionId)
    .where("lookup_id", "=", lookupId)
    .where("state", "=", "active")
    .where("registration_generation", "=", generation)
    .where("registration_claim", "is", null)
    .execute();
  if (refs.length !== 1) return false;
  const canonicalSandboxId = refs[0]?.sandbox_id;
  if (
    !canonicalSandboxId ||
    (await activeSandboxCredentialPolicyGeneration(env, policy.sessionId, canonicalSandboxId)) !==
      generation
  ) {
    return false;
  }
  const standalone = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "ownership_claim", "ownership_claim_expires_at", "expires_at"])
    .where("id", "=", policy.sessionId)
    .where("sandbox_id", "=", canonicalSandboxId)
    .executeTakeFirst();
  if (standalone) {
    const ownerActive =
      standalone.state === "active" ||
      (standalone.state === "provisioning" &&
        Boolean(standalone.ownership_claim) &&
        (standalone.ownership_claim_expires_at ?? 0) > now);
    return Boolean(
      ownerActive &&
      policy.expiresAt !== undefined &&
      policy.expiresAt === standalone.expires_at &&
      policy.expiresAt > now,
    );
  }
  const owner = await sql<{ expected: number }>`
    SELECT CASE
      WHEN ${sandboxCredentialPolicyCleanupAuthorizedCondition(
        policy.sessionId,
        canonicalSandboxId,
        now,
      )}
      THEN 0
      ELSE 1
    END AS expected
  `.execute(db);
  return owner.rows[0]?.expected === 1;
}

async function sandboxOutbound(
  request: Request,
  env: RuntimeEnv,
  context: SandboxOutboundContext,
): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const policy = await sandboxCredentialPolicy(env, context.containerId);
  if (policy?.expiresAt !== undefined && policy.expiresAt <= Date.now()) {
    return new Response("Crabfleet standalone Sandbox credentials expired.\n", { status: 403 });
  }
  const openAIHost = policy?.openAIBaseUrl
    ? new URL(policy.openAIBaseUrl).hostname.toLowerCase()
    : "api.openai.com";
  const allowedHosts = [
    ...defaultSandboxEgressHosts,
    ...(policy?.openAIBaseUrl ? [openAIHost] : []),
    ...(policy?.allowedHosts ?? []),
  ];
  if (!matchesAnyHost(host, allowedHosts)) {
    return new Response(`Crabfleet blocked sandbox outbound access to ${host}.\n`, {
      status: 403,
    });
  }

  if (policy && openAIRequestMatchesPolicy(url, policy)) {
    const authorization = env.OPENAI_API_KEY ? `Bearer ${env.OPENAI_API_KEY}` : undefined;
    const next = withAuthorization(request, authorization);
    if (policy.openAIOrgId) next.headers.set("openai-organization", policy.openAIOrgId);
    return fetch(next);
  }

  const githubToken = policy?.githubTokenCiphertext
    ? await openSecret(env, policy.githubTokenCiphertext)
    : env.GITHUB_TOKEN;
  if (
    githubToken &&
    policy &&
    (await githubRequestCanUseRepoCredential(request, url, policy.githubRepo, {
      nodeBelongsToRepo: (nodeId) =>
        githubNodeBelongsToRepo(nodeId, policy.githubRepo, githubToken),
      ...(policy.githubRepoNodeId ? { repoNodeId: policy.githubRepoNodeId } : {}),
    }))
  ) {
    const authorization =
      host === "api.github.com" || host === "uploads.github.com"
        ? `Bearer ${githubToken}`
        : githubBasicAuth(githubToken);
    return fetch(withAuthorization(request, authorization));
  }

  if (isGitHubHost(host)) {
    return fetch(withoutSandboxPlaceholderAuthorization(request));
  }

  return fetch(request);
}

function openAIRequestMatchesPolicy(url: URL, policy: SandboxCredentialPolicy): boolean {
  const baseUrl = new URL(policy.openAIBaseUrl ?? "https://api.openai.com");
  if (url.origin !== baseUrl.origin) return false;
  if (baseUrl.pathname === "/" || baseUrl.pathname === "") return true;
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  return url.pathname === baseUrl.pathname || url.pathname.startsWith(basePath);
}

export class SessionControlDO extends DurableObject<RuntimeEnv> {
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (
        request.method === "GET" &&
        url.pathname === "/api/session-control/github-actions/runner"
      ) {
        return this.openGitHubActionsRelay("runner");
      }

      if (
        request.method === "GET" &&
        url.pathname === "/api/session-control/github-actions/viewer"
      ) {
        return this.openGitHubActionsRelay("viewer");
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/session-control/github-actions/disconnect-runner"
      ) {
        const disconnected = replaceGitHubActionsRunner(
          this.ctx.getWebSockets("github-actions-runner"),
          1000,
          "runner disconnected",
        );
        return json({ disconnected });
      }

      if (request.method === "POST" && url.pathname === "/api/session-control/register") {
        const registration = (await request.json()) as StoredSandboxCredentialPolicy;
        if (!validSandboxCredentialPolicyRegistration(registration)) {
          return json({ error: "invalid credential policy registration" }, { status: 400 });
        }
        const outcome = await this.ctx.storage.transaction(async (transaction) => {
          const [stored, tombstone] = await Promise.all([
            transaction.get<StoredSandboxCredentialPolicy | SandboxCredentialPolicy>(
              sandboxPolicyKey(registration.policy.sandboxId),
            ),
            transaction.get<CredentialPolicyGenerationTombstone>(
              sandboxPolicyTombstoneKey(registration.policy.sandboxId, registration.generation),
            ),
          ]);
          const current = storedSandboxCredentialPolicy(stored);
          const legacy = legacySandboxCredentialPolicy(stored);
          if (legacy && legacy.sessionId !== registration.policy.sessionId) return "conflict";
          if (!credentialPolicyRegistrationAccepted(current, tombstone, registration, Date.now())) {
            return tombstone ? "tombstoned" : "conflict";
          }
          await transaction.put(sandboxPolicyKey(registration.policy.sandboxId), registration);
          return "stored";
        });
        if (outcome !== "stored") {
          return json({ error: `credential policy generation ${outcome}` }, { status: 409 });
        }
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/session-control/migrate-legacy") {
        const migration = (await request.json()) as SandboxCredentialPolicyLegacyMigration;
        if (!validSandboxCredentialPolicyLegacyMigration(migration)) {
          return json({ error: "invalid legacy credential policy migration" }, { status: 400 });
        }
        const outcome = await this.ctx.storage.transaction(async (transaction) => {
          const records = await Promise.all(
            migration.sandboxIds.map(async (sandboxId) => ({
              sandboxId,
              stored: await transaction.get<
                StoredSandboxCredentialPolicy | SandboxCredentialPolicy
              >(sandboxPolicyKey(sandboxId)),
              tombstone: await transaction.get<CredentialPolicyGenerationTombstone>(
                sandboxPolicyTombstoneKey(sandboxId, migration.generation),
              ),
            })),
          );
          const sourcePolicy = records
            .map(
              ({ stored }) =>
                storedSandboxCredentialPolicy(stored)?.policy ??
                legacySandboxCredentialPolicy(stored),
            )
            .find((policy) => policy?.sessionId === migration.sessionId);
          if (!sourcePolicy) return "conflict";
          const migratedRecords: Array<{
            sandboxId: string;
            policy: StoredSandboxCredentialPolicy;
          }> = [];
          for (const record of records) {
            const current = storedSandboxCredentialPolicy(record.stored);
            const legacy =
              legacySandboxCredentialPolicy(record.stored) ??
              (!current ? { ...sourcePolicy, sandboxId: record.sandboxId } : undefined);
            const migrated = migratedCredentialPolicyRecord(
              current,
              legacy,
              record.tombstone,
              migration,
              Date.now(),
            );
            if (!migrated || migrated.policy.sandboxId !== record.sandboxId) {
              return record.tombstone ? "tombstoned" : "conflict";
            }
            migratedRecords.push({ sandboxId: record.sandboxId, policy: migrated });
          }
          for (const record of migratedRecords) {
            await transaction.put(sandboxPolicyKey(record.sandboxId), record.policy);
          }
          return "stored";
        });
        if (outcome !== "stored") {
          return json({ error: `legacy credential policy migration ${outcome}` }, { status: 409 });
        }
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/session-control/policies") {
        const entries = await this.ctx.storage.list<
          StoredSandboxCredentialPolicy | SandboxCredentialPolicy
        >({
          prefix: "sandbox:",
        });
        const policies = dedupeSandboxPolicies(
          [...entries.values()]
            .map((stored) => sandboxCredentialPolicyFromStorage(stored))
            .filter((policy): policy is SandboxCredentialPolicy => Boolean(policy)),
        ).map((policy) => redactSandboxPolicy(policy, Boolean(this.env.GITHUB_TOKEN)));
        return json({ policies });
      }

      const egressMatch = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (request.method === "GET" && egressMatch) {
        const sandboxId = decodeURIComponent(egressMatch[1] ?? "");
        const key = sandboxPolicyKey(sandboxId);
        const stored = await this.ctx.storage.get<
          StoredSandboxCredentialPolicy | SandboxCredentialPolicy
        >(key);
        const current = storedSandboxCredentialPolicy(stored);
        const legacy = legacySandboxCredentialPolicy(stored);
        const policy = sandboxCredentialPolicyFromStorage(stored);
        if (!current || !policy) {
          if (legacy) {
            return json(
              { error: "legacy credential policy migration required", sessionId: legacy.sessionId },
              { status: 409 },
            );
          }
          return json({ error: "not found" }, { status: 404 });
        }
        return json(policy, {
          headers: { "x-crabfleet-policy-generation": current.generation },
        });
      }

      const sandboxMatch = url.pathname.match(/^\/api\/session-control\/sandbox\/([^/]+)$/);
      if (request.method === "DELETE" && sandboxMatch) {
        const sandboxId = decodeURIComponent(sandboxMatch[1] ?? "");
        const tombstone = (await request.json()) as CredentialPolicyGenerationTombstone;
        if (!validCredentialPolicyTombstone(tombstone)) {
          return json({ error: "invalid credential policy tombstone" }, { status: 400 });
        }
        await this.ctx.storage.transaction(async (transaction) => {
          const key = sandboxPolicyKey(sandboxId);
          const stored = await transaction.get<
            StoredSandboxCredentialPolicy | SandboxCredentialPolicy
          >(key);
          const current = storedSandboxCredentialPolicy(stored);
          const legacy = legacySandboxCredentialPolicy(stored);
          await transaction.put(
            sandboxPolicyTombstoneKey(sandboxId, tombstone.generation),
            tombstone,
          );
          if (
            credentialPolicyCleanupMatches(current, tombstone.generation, tombstone.sessionId) ||
            credentialPolicyMigrationCleanupMatches(
              current,
              tombstone.generation,
              tombstone.sessionId,
            ) ||
            legacy?.sessionId === tombstone.sessionId
          ) {
            await transaction.delete(key);
          }
        });
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/api/session-control/checkpoints") {
        const checkpoint = (await request.json()) as SandboxCheckpoint;
        await this.ctx.storage.put(
          sandboxCheckpointKey(checkpoint.sessionId, checkpoint.id),
          checkpoint,
        );
        const listKey = sandboxCheckpointListKey(checkpoint.sessionId);
        const list = (await this.ctx.storage.get<SandboxCheckpoint[]>(listKey)) ?? [];
        const next = [checkpoint, ...list.filter((item) => item.id !== checkpoint.id)].slice(0, 20);
        await this.ctx.storage.put(listKey, next);
        return json({ checkpoint });
      }

      const checkpointsMatch = url.pathname.match(/^\/api\/session-control\/checkpoints\/([^/]+)$/);
      if (request.method === "GET" && checkpointsMatch) {
        const sessionId = decodeURIComponent(checkpointsMatch[1] ?? "");
        const checkpoints =
          (await this.ctx.storage.get<SandboxCheckpoint[]>(sandboxCheckpointListKey(sessionId))) ??
          [];
        return json({ checkpoints });
      }

      const checkpointMatch = url.pathname.match(
        /^\/api\/session-control\/checkpoints\/([^/]+)\/([^/]+)$/,
      );
      if (request.method === "GET" && checkpointMatch) {
        const sessionId = decodeURIComponent(checkpointMatch[1] ?? "");
        const checkpointId = decodeURIComponent(checkpointMatch[2] ?? "");
        const checkpoint = await this.ctx.storage.get<SandboxCheckpoint>(
          sandboxCheckpointKey(sessionId, checkpointId),
        );
        return checkpoint ? json({ checkpoint }) : json({ error: "not found" }, { status: 404 });
      }
    } catch (error) {
      return json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 500 },
      );
    }
    return json({ error: "not found" }, { status: 404 });
  }

  override webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    const role = githubActionsRelayRole(this.ctx.getTags(socket));
    if (!role) {
      socket.close(1008, "unknown relay peer");
      return;
    }
    forwardGitHubActionsRelayMessage(
      role,
      message,
      this.ctx.getWebSockets("github-actions-runner"),
      this.ctx.getWebSockets("github-actions-viewer"),
    );
  }

  override webSocketClose(socket: WebSocket): void {
    const role = githubActionsRelayRole(this.ctx.getTags(socket));
    if (role === "runner" && this.ctx.getWebSockets("github-actions-runner").length === 0) {
      notifyGitHubActionsViewers(
        this.ctx.getWebSockets("github-actions-viewer"),
        "runner_disconnected",
      );
    }
  }

  override webSocketError(socket: WebSocket): void {
    socket.close(1011, "relay peer error");
  }

  private openGitHubActionsRelay(role: "runner" | "viewer"): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    if (role === "runner") {
      replaceGitHubActionsRunner(this.ctx.getWebSockets("github-actions-runner"));
      this.ctx.acceptWebSocket(server, ["github-actions-runner"]);
      notifyGitHubActionsViewers(
        this.ctx.getWebSockets("github-actions-viewer"),
        "runner_connected",
      );
    } else {
      this.ctx.acceptWebSocket(server, ["github-actions-viewer"]);
      if (this.ctx.getWebSockets("github-actions-runner").length === 0) {
        server.send(JSON.stringify({ type: "runner_waiting" }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }
}

function storedSandboxCredentialPolicy(
  value: StoredSandboxCredentialPolicy | SandboxCredentialPolicy | undefined,
): StoredSandboxCredentialPolicy | undefined {
  if (
    value &&
    "policy" in value &&
    typeof value.generation === "string" &&
    typeof value.registrationClaim === "string" &&
    typeof value.registrationExpiresAt === "number"
  ) {
    return value;
  }
  return undefined;
}

function legacySandboxCredentialPolicy(
  value: StoredSandboxCredentialPolicy | SandboxCredentialPolicy | undefined,
): SandboxCredentialPolicy | undefined {
  return value && !("policy" in value) ? value : undefined;
}

function sandboxCredentialPolicyFromStorage(
  value: StoredSandboxCredentialPolicy | SandboxCredentialPolicy | undefined,
): SandboxCredentialPolicy | undefined {
  const current = storedSandboxCredentialPolicy(value);
  if (!current) return undefined;
  if (
    current.policy.expiresAt !== undefined &&
    (!Number.isFinite(current.policy.expiresAt) || current.policy.expiresAt <= Date.now())
  ) {
    return undefined;
  }
  return current.policy;
}

function validSandboxCredentialPolicyRegistration(value: StoredSandboxCredentialPolicy): boolean {
  return Boolean(
    value &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    value.generation.length <= 200 &&
    typeof value.registrationClaim === "string" &&
    value.registrationClaim.length > 0 &&
    value.registrationClaim.length <= 200 &&
    Number.isFinite(value.registrationExpiresAt) &&
    value.policy &&
    typeof value.policy.sandboxId === "string" &&
    typeof value.policy.sessionId === "string" &&
    (value.policy.expiresAt === undefined ||
      (Number.isFinite(value.policy.expiresAt) && value.policy.expiresAt > Date.now())),
  );
}

function validSandboxCredentialPolicyLegacyMigration(
  value: SandboxCredentialPolicyLegacyMigration,
): boolean {
  return Boolean(
    value &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    value.generation.length <= 200 &&
    !value.generation.startsWith(credentialPolicyLegacyGenerationPrefix) &&
    typeof value.registrationClaim === "string" &&
    value.registrationClaim.startsWith(credentialPolicyLegacyRepairClaimPrefix) &&
    value.registrationClaim.length <= 200 &&
    Number.isFinite(value.registrationExpiresAt) &&
    Array.isArray(value.sandboxIds) &&
    value.sandboxIds.length > 0 &&
    value.sandboxIds.length <= 8 &&
    new Set(value.sandboxIds).size === value.sandboxIds.length &&
    value.sandboxIds.every(
      (sandboxId) =>
        typeof sandboxId === "string" && sandboxId.length > 0 && sandboxId.length <= 200,
    ) &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 200,
  );
}

function validCredentialPolicyTombstone(value: CredentialPolicyGenerationTombstone): boolean {
  return Boolean(
    value &&
    typeof value.generation === "string" &&
    value.generation.length > 0 &&
    value.generation.length <= 200 &&
    typeof value.sessionId === "string" &&
    value.sessionId.length > 0 &&
    value.sessionId.length <= 200 &&
    Number.isFinite(value.tombstonedAt),
  );
}

function dedupeSandboxPolicies(policies: SandboxCredentialPolicy[]): SandboxCredentialPolicy[] {
  const seen = new Set<string>();
  const result: SandboxCredentialPolicy[] = [];
  for (const policy of policies.sort((a, b) => a.sandboxId.localeCompare(b.sandboxId))) {
    const key = `${policy.sessionId}:${policy.owner}:${policy.githubRepo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(policy);
  }
  return result;
}

function redactSandboxPolicy(
  policy: SandboxCredentialPolicy,
  workerCredentialAvailable = false,
): FleetSandboxPolicySummary {
  const githubCredentialSource =
    policy.githubCredentialSource ??
    (policy.githubTokenCiphertext ? "session" : workerCredentialAvailable ? "worker" : "none");
  return {
    allowedHostCount: policy.allowedHosts.length,
    allowedHosts: [...policy.allowedHosts].sort(),
    githubCredentialSource,
    githubRepo: policy.githubRepo,
    hasGithubRepoNodeId: Boolean(policy.githubRepoNodeId),
    hasGithubToken: githubCredentialSource !== "none",
    openAIBaseUrlHost: urlHost(policy.openAIBaseUrl),
    openAIOrgConfigured: Boolean(policy.openAIOrgId),
    owner: policy.owner,
    sandboxId: policy.sandboxId,
    sessionId: policy.sessionId,
  };
}

function urlHost(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

async function readSandboxFleetPolicies(env: RuntimeEnv): Promise<SandboxFleetPolicyResult> {
  const stub = sandboxControlStub(env);
  if (!stub) return { available: false, policies: [] };
  try {
    const response = await stub.fetch("https://crabfleet.internal/api/session-control/policies");
    if (!response.ok) return { available: false, policies: [] };
    const body = (await response.json()) as { policies?: FleetSandboxPolicySummary[] };
    return {
      available: true,
      policies: Array.isArray(body.policies) ? body.policies : [],
    };
  } catch {
    return { available: false, policies: [] };
  }
}

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

      if (url.pathname === "/login/github") {
        return await githubLogin(request, env);
      }

      if (url.pathname === "/auth/github/callback") {
        return await githubCallback(request, env);
      }

      const sshLinkMatch = url.pathname.match(/^\/ssh\/link\/([^/]+)$/);
      if (sshLinkMatch && (request.method === "GET" || request.method === "POST")) {
        return await sshLink(request, env, decodeURIComponent(sshLinkMatch[1] ?? ""), trustedProxy);
      }

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
    context.waitUntil(
      reconcileInteractiveSessionLifecycleBatch(env, Date.now()).catch((error) => {
        console.error("scheduled interactive session reconciliation failed", error);
      }),
    );
  },
} satisfies ExportedHandler<RuntimeEnv>;

async function api(
  request: Request,
  env: RuntimeEnv,
  context: ExecutionContext,
  requestAuth: TrustedProxyAuthResult,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "POST" && url.pathname === "/api/login/token") {
    return tokenLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/login/dev") {
    return devIdentityLogin(request, env);
  }

  if (request.method === "POST" && url.pathname === "/api/logout") {
    return logout(request, env);
  }

  if (request.method === "GET" && url.pathname === "/api/auth") {
    return json({ auth: authMethods(env, request), deployment: publicDeploymentConfig(env) });
  }

  const standaloneProvisionPtyMatch = url.pathname.match(
    /^\/api\/provision\/interactive\/([^/]+)\/pty$/,
  );
  if (request.method === "GET" && standaloneProvisionPtyMatch) {
    return standaloneSandboxPty(
      request,
      env,
      decodeURIComponent(standaloneProvisionPtyMatch[1] ?? ""),
    );
  }

  const standaloneProvisionStopMatch = url.pathname.match(
    /^\/api\/provision\/interactive\/([^/]+)\/stop$/,
  );
  if (request.method === "POST" && standaloneProvisionStopMatch) {
    return json(
      await stopStandaloneSandboxProvision(
        request,
        env,
        decodeURIComponent(standaloneProvisionStopMatch[1] ?? ""),
      ),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/provision/interactive") {
    return json(await provisionInteractiveEndpoint(request, env));
  }

  if (request.method === "POST" && url.pathname === "/api/ssh/auth") {
    return json(await sshAuth(request, env));
  }

  if (request.method === "GET" && url.pathname === "/api/ssh/state") {
    return json(await sshState(request, env));
  }

  if (request.method === "GET" && url.pathname === "/api/agent/state") {
    return json(await agentState(request, env));
  }

  if (request.method === "POST" && url.pathname === "/api/ssh/interactive-sessions") {
    return json(await sshCreateInteractiveSession(request, env), { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/agent/interactive-sessions") {
    return json(await agentCreateInteractiveSession(request, env), { status: 201 });
  }

  const agentInteractiveWorkStateMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)\/work-state$/,
  );
  if (request.method === "POST" && agentInteractiveWorkStateMatch) {
    return json(
      await updateGitHubActionsWorkState(
        request,
        env,
        decodeURIComponent(agentInteractiveWorkStateMatch[1] ?? ""),
      ),
    );
  }

  const agentInteractiveRunnerPtyMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)\/runner-pty$/,
  );
  if (request.method === "GET" && agentInteractiveRunnerPtyMatch) {
    return githubActionsRunnerPty(
      request,
      env,
      decodeURIComponent(agentInteractiveRunnerPtyMatch[1] ?? ""),
    );
  }

  const sshInteractiveReadMatch = url.pathname.match(/^\/api\/ssh\/interactive-sessions\/([^/]+)$/);
  if (request.method === "GET" && sshInteractiveReadMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    const session = await readFreshInteractiveSession(
      env,
      decodeURIComponent(sshInteractiveReadMatch[1] ?? ""),
    );
    if (!session) throw notFound("interactive session not found");
    return json({ session: decorateInteractiveSession(session, user, env) });
  }

  const agentInteractiveReadMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)$/,
  );
  if (request.method === "GET" && agentInteractiveReadMatch) {
    const { user } = await requireAgentSession(request, env);
    const session = await readFreshInteractiveSession(
      env,
      decodeURIComponent(agentInteractiveReadMatch[1] ?? ""),
    );
    if (!session) throw notFound("interactive session not found");
    return json({ session: decorateInteractiveSession(session, user, env) });
  }

  const sshInteractiveActionMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/actions$/,
  );
  if (request.method === "POST" && sshInteractiveActionMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    const body = await readJson<{ action?: string }>(request);
    return json(
      await mutateInteractiveSession(
        request,
        env,
        user,
        decodeURIComponent(sshInteractiveActionMatch[1] ?? ""),
        body.action ?? "",
      ),
    );
  }

  const sshInteractiveCheckpointsMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/checkpoints$/,
  );
  if (sshInteractiveCheckpointsMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    const id = decodeURIComponent(sshInteractiveCheckpointsMatch[1] ?? "");
    if (request.method === "GET")
      return json(await listInteractiveSessionCheckpoints(env, user, id));
    if (request.method === "POST") {
      return json(await checkpointInteractiveSession(env, user, id), { status: 201 });
    }
  }

  const sshInteractiveRestoreMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/checkpoints\/([^/]+)\/restore$/,
  );
  if (request.method === "POST" && sshInteractiveRestoreMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    return json(
      await restoreInteractiveSessionCheckpoint(
        env,
        user,
        decodeURIComponent(sshInteractiveRestoreMatch[1] ?? ""),
        decodeURIComponent(sshInteractiveRestoreMatch[2] ?? ""),
      ),
    );
  }

  const sshInteractiveLogsMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/logs$/,
  );
  if (request.method === "GET" && sshInteractiveLogsMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    return json(
      await readInteractiveSessionLogBundle(
        env,
        user,
        decodeURIComponent(sshInteractiveLogsMatch[1] ?? ""),
      ),
    );
  }

  const agentInteractiveLogsMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)\/logs$/,
  );
  if (request.method === "GET" && agentInteractiveLogsMatch) {
    const { user } = await requireAgentSession(request, env);
    return json(
      await readInteractiveSessionLogBundle(
        env,
        user,
        decodeURIComponent(agentInteractiveLogsMatch[1] ?? ""),
      ),
    );
  }

  const sshInteractiveTranscriptMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && sshInteractiveTranscriptMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    return interactiveSessionTranscriptResponse(
      env,
      user,
      decodeURIComponent(sshInteractiveTranscriptMatch[1] ?? ""),
    );
  }

  const agentInteractiveTranscriptMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && agentInteractiveTranscriptMatch) {
    const { user } = await requireAgentSession(request, env);
    return interactiveSessionTranscriptResponse(
      env,
      user,
      decodeURIComponent(agentInteractiveTranscriptMatch[1] ?? ""),
    );
  }

  const sshInteractiveSummaryMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/summary$/,
  );
  if (request.method === "POST" && sshInteractiveSummaryMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    return json(
      await updateInteractiveSessionSummary(
        request,
        env,
        user,
        decodeURIComponent(sshInteractiveSummaryMatch[1] ?? ""),
      ),
    );
  }

  const agentInteractiveSummaryMatch = url.pathname.match(
    /^\/api\/agent\/interactive-sessions\/([^/]+)\/summary$/,
  );
  if (request.method === "POST" && agentInteractiveSummaryMatch) {
    const { user } = await requireAgentSession(request, env);
    return json(
      await updateInteractiveSessionSummary(
        request,
        env,
        user,
        decodeURIComponent(agentInteractiveSummaryMatch[1] ?? ""),
      ),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/openclaw/action-sessions") {
    return json(await openClawRegisterActionSession(request, env), { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/openclaw/crabboxes") {
    return json(await openClawCreateCrabbox(request, env), { status: 201 });
  }

  const openClawSessionRootMatch = url.pathname.match(/^\/api\/openclaw\/session-roots\/([^/]+)$/);
  if (request.method === "GET" && openClawSessionRootMatch) {
    return json(
      await openClawReadSessionRoot(
        request,
        env,
        decodeURIComponent(openClawSessionRootMatch[1] ?? ""),
      ),
    );
  }

  const openClawSessionRootActionMatch = url.pathname.match(
    /^\/api\/openclaw\/session-roots\/([^/]+)\/actions$/,
  );
  if (request.method === "POST" && openClawSessionRootActionMatch) {
    return json(
      await openClawMutateSessionRoot(
        request,
        env,
        decodeURIComponent(openClawSessionRootActionMatch[1] ?? ""),
      ),
    );
  }

  const openClawCrabboxTranscriptMatch = url.pathname.match(
    /^\/api\/openclaw\/crabboxes\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && openClawCrabboxTranscriptMatch) {
    return json(
      await openClawReadCrabboxTranscript(
        request,
        env,
        decodeURIComponent(openClawCrabboxTranscriptMatch[1] ?? ""),
      ),
    );
  }

  const openClawCrabboxMessageMatch = url.pathname.match(
    /^\/api\/openclaw\/crabboxes\/([^/]+)\/message$/,
  );
  if (request.method === "POST" && openClawCrabboxMessageMatch) {
    return json(
      await openClawMessageCrabbox(
        request,
        env,
        decodeURIComponent(openClawCrabboxMessageMatch[1] ?? ""),
      ),
    );
  }

  const openClawCrabboxActionMatch = url.pathname.match(
    /^\/api\/openclaw\/crabboxes\/([^/]+)\/actions$/,
  );
  if (request.method === "POST" && openClawCrabboxActionMatch) {
    return json(
      await openClawMutateCrabbox(
        request,
        env,
        decodeURIComponent(openClawCrabboxActionMatch[1] ?? ""),
      ),
    );
  }

  const openClawCrabboxReadMatch = url.pathname.match(/^\/api\/openclaw\/crabboxes\/([^/]+)$/);
  if (request.method === "GET" && openClawCrabboxReadMatch) {
    return json(
      await openClawReadCrabbox(
        request,
        env,
        decodeURIComponent(openClawCrabboxReadMatch[1] ?? ""),
      ),
    );
  }

  const sharedSessionMatch = url.pathname.match(/^\/api\/shared-sessions\/([^/]+)$/);
  if (request.method === "GET" && sharedSessionMatch) {
    return json(
      await readSharedInteractiveSession(
        env,
        decodeURIComponent(sharedSessionMatch[1] ?? ""),
        url.searchParams.get("token") ?? "",
      ),
    );
  }

  if (request.method === "GET" && url.pathname === "/api/terminal/ws") {
    return interactiveTerminalHub(request, env, await terminalHubUser(request, env, requestAuth));
  }

  const user = await requireUser(request, env, requestAuth);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return json({ user, auth: authMethods(env, request) });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(await readState(request, env, user, context));
  }

  if (request.method === "GET" && url.pathname === "/api/fleet") {
    requireRole(user, "viewer");
    return json({ fleet: await readFleetState(env, user, undefined, context) });
  }

  if (request.method === "GET" && url.pathname === "/api/github/refs") {
    requireRole(user, "maintainer");
    return json(await searchGitHubRefs(request, env));
  }

  if (request.method === "POST" && url.pathname === "/api/interactive-sessions") {
    requireRole(user, "maintainer");
    return json(await createInteractiveSession(request, env, user), { status: 201 });
  }

  if (request.method === "POST" && url.pathname === "/api/interactive-sessions/cleanup") {
    requireRole(user, "viewer");
    return json(await cleanupInteractiveSessions(request, env, user));
  }

  const interactiveSessionReadMatch = url.pathname.match(/^\/api\/interactive-sessions\/([^/]+)$/);
  if (request.method === "GET" && interactiveSessionReadMatch) {
    requireRole(user, "viewer");
    const session = await readFreshInteractiveSession(
      env,
      decodeURIComponent(interactiveSessionReadMatch[1] ?? ""),
    );
    if (!session) throw notFound("interactive session not found");
    return json({ session: decorateInteractiveSession(session, user, env) });
  }

  const interactiveSessionLogsMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/logs$/,
  );
  if (request.method === "GET" && interactiveSessionLogsMatch) {
    requireRole(user, "viewer");
    return json(
      await readInteractiveSessionLogBundle(
        env,
        user,
        decodeURIComponent(interactiveSessionLogsMatch[1] ?? ""),
      ),
    );
  }

  const interactiveSessionTranscriptMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/transcript$/,
  );
  if (request.method === "GET" && interactiveSessionTranscriptMatch) {
    const user = await requireUser(request, env, requestAuth);
    return interactiveSessionTranscriptResponse(
      env,
      user,
      decodeURIComponent(interactiveSessionTranscriptMatch[1] ?? ""),
    );
  }

  const interactiveSessionSummaryMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/summary$/,
  );
  if (request.method === "POST" && interactiveSessionSummaryMatch) {
    const user = await requireUser(request, env, requestAuth);
    return json(
      await updateInteractiveSessionSummary(
        request,
        env,
        user,
        decodeURIComponent(interactiveSessionSummaryMatch[1] ?? ""),
      ),
    );
  }

  const interactiveSessionDiagnosticsMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/diagnostics$/,
  );
  if (request.method === "GET" && interactiveSessionDiagnosticsMatch) {
    requireRole(user, "viewer");
    return json(
      await readInteractiveSessionDiagnostics(
        env,
        user,
        decodeURIComponent(interactiveSessionDiagnosticsMatch[1] ?? ""),
      ),
    );
  }

  const interactiveSessionVncMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/vnc$/,
  );
  if (request.method === "GET" && interactiveSessionVncMatch) {
    requireRole(user, "viewer");
    return interactiveSessionVnc(
      env,
      user,
      decodeURIComponent(interactiveSessionVncMatch[1] ?? ""),
    );
  }

  const interactiveSessionCheckpointsMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/checkpoints$/,
  );
  if (interactiveSessionCheckpointsMatch) {
    requireRole(user, "viewer");
    const id = decodeURIComponent(interactiveSessionCheckpointsMatch[1] ?? "");
    if (request.method === "GET")
      return json(await listInteractiveSessionCheckpoints(env, user, id));
    if (request.method === "POST") {
      return json(await checkpointInteractiveSession(env, user, id), { status: 201 });
    }
  }

  const interactiveSessionRestoreMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/checkpoints\/([^/]+)\/restore$/,
  );
  if (request.method === "POST" && interactiveSessionRestoreMatch) {
    requireRole(user, "viewer");
    return json(
      await restoreInteractiveSessionCheckpoint(
        env,
        user,
        decodeURIComponent(interactiveSessionRestoreMatch[1] ?? ""),
        decodeURIComponent(interactiveSessionRestoreMatch[2] ?? ""),
      ),
    );
  }

  const interactiveSessionMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/actions$/,
  );
  if (request.method === "POST" && interactiveSessionMatch) {
    const body = await readJson<{ action?: string }>(request);
    const action = body.action ?? "";
    requireRole(user, "viewer");
    return json(
      await mutateInteractiveSession(
        request,
        env,
        user,
        decodeURIComponent(interactiveSessionMatch[1] ?? ""),
        action,
      ),
    );
  }

  const interactiveClipboardMatch = url.pathname.match(
    /^\/api\/interactive-sessions\/([^/]+)\/clipboard$/,
  );
  if (request.method === "POST" && interactiveClipboardMatch) {
    requireRole(user, "viewer");
    return json(
      await uploadInteractiveSessionClipboard(
        request,
        env,
        user,
        decodeURIComponent(interactiveClipboardMatch[1] ?? ""),
      ),
      { status: 201 },
    );
  }

  if (request.method === "POST" && url.pathname === "/api/cards") {
    requireRole(user, "maintainer");
    return json(await createCard(request, env, user), { status: 201 });
  }

  const runsMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/runs$/);
  if (request.method === "GET" && runsMatch) {
    const cardId = decodeURIComponent(runsMatch[1] ?? "");
    const card = await readCard(env, cardId);
    if (!card) throw notFound("card not found");
    return json({ runs: await readRunsForCard(env, cardId) });
  }

  if (request.method === "PUT" && url.pathname === "/api/admin/policy") {
    requireRole(user, "owner");
    return json(await updatePolicy(request, env, user));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/workflows/evaluate") {
    requireRole(user, "owner");
    return json(await evaluateWorkflow(request, env, user));
  }

  const actionMatch = url.pathname.match(/^\/api\/cards\/([^/]+)\/actions$/);
  if (request.method === "POST" && actionMatch) {
    const body = await readJson<{ action?: string }>(request);
    const action = body.action ?? "";
    requireRole(user, action === "attach" || action === "watch" ? "viewer" : "maintainer");
    return json(await mutateCard(env, user, decodeURIComponent(actionMatch[1] ?? ""), action));
  }

  if (request.method === "POST" && url.pathname === "/api/admin/allow") {
    requireRole(user, "owner");
    return json(await addAllowEntry(request, env, user), { status: 201 });
  }

  const allowMatch = url.pathname.match(/^\/api\/admin\/allow\/(.+)$/);
  if (request.method === "DELETE" && allowMatch) {
    requireRole(user, "owner");
    return json(
      await removeAllowEntry(request, env, user, decodeURIComponent(allowMatch[1] ?? "")),
    );
  }

  if (request.method === "POST" && url.pathname === "/api/admin/repos") {
    requireRole(user, "owner");
    return json(await addRepo(request, env, user), { status: 201 });
  }

  const repoMatch = url.pathname.match(/^\/api\/admin\/repos\/(.+)$/);
  if (request.method === "DELETE" && repoMatch) {
    requireRole(user, "owner");
    return json(await removeRepo(request, env, user, decodeURIComponent(repoMatch[1] ?? "")));
  }

  return json({ error: "not found" }, { status: 404 });
}

async function tokenLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  const { token } = await readJson<{ token?: string }>(request);
  if (!env.CRABBOX_BOOTSTRAP_TOKEN || token !== env.CRABBOX_BOOTSTRAP_TOKEN) {
    return json({ error: "invalid token" }, { status: 401 });
  }

  const now = Date.now();
  const subject = await bootstrapSubject(env);
  const user: User = {
    subject,
    login: "bootstrap",
    email: null,
    name: "Bootstrap Admin",
    role: "owner",
    allowed: true,
    teams: [],
  };
  await upsertUser(env, user, now);
  const cookieHeader = await createSession(env, request, user.subject, now);
  return json(
    { user, auth: authMethods(env, request) },
    { headers: { "set-cookie": cookieHeader } },
  );
}

async function devIdentityLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!devIdentityEnabled(env, request)) return json({ error: "not found" }, { status: 404 });

  const body = await readJson<{ id?: string; name?: string; role?: string }>(request);
  const id = devIdentityId(body.id);
  const role = parseRole(body.role);
  const user: User = {
    subject: `dev:${id}`,
    login: id,
    email: null,
    name: clean(body.name, 120) || id,
    role,
    allowed: true,
    teams: [],
  };
  const now = Date.now();
  await upsertUser(env, user, now);
  const cookieHeader = await createSession(env, request, user.subject, now);
  return json(
    { user, auth: authMethods(env, request) },
    { headers: { "set-cookie": cookieHeader } },
  );
}

async function sshLink(
  request: Request,
  env: RuntimeEnv,
  code: string,
  requestAuth: TrustedProxyAuthResult,
): Promise<Response> {
  const canonicalLinkUrl = githubOAuthCanonicalSshLinkUrl(
    request.url,
    code,
    env.GITHUB_REDIRECT_URI,
  );
  if (canonicalLinkUrl) {
    return redirect(canonicalLinkUrl, { "cache-control": "no-store" });
  }
  const codeHash = await sha256(code);
  const row = await database(env)
    .selectFrom("ssh_link_codes")
    .select(["fingerprint", "label", "expires_at", "consumed_at"])
    .where("code_hash", "=", codeHash)
    .executeTakeFirst();
  if (!row || row.consumed_at || row.expires_at <= Date.now()) {
    return text(
      "SSH link expired. Re-run ssh link@crabd.sh to get a fresh link.\n",
      "text/plain",
      {},
      410,
    );
  }

  if (request.method === "POST") {
    const user = await requireUser(request, env, requestAuth);
    if (!user.subject.startsWith("github:")) {
      throw forbidden("Sign in with GitHub before linking an SSH key");
    }
    const githubToken = await sessionGitHubToken(request, env, user.subject);
    if (!githubToken) {
      throw forbidden("Sign in with GitHub again before linking an SSH key");
    }
    await consumeSshLink(env, user, code, Date.now(), githubToken);
    return redirect("/app?ssh=linked&login=github", {
      "set-cookie": cookie(request, sshLinkCookie, "", 0),
    });
  }

  const user = await optionalUser(request, env, requestAuth);
  if (user) {
    if (!user.subject.startsWith("github:")) {
      return text(
        "Sign in with GitHub before linking an SSH key.\n",
        "text/plain; charset=utf-8",
        { "cache-control": "no-store" },
        403,
      );
    }
    return text(
      sshLinkConfirmHtml(code, row.fingerprint, row.label, actor(user)),
      "text/html; charset=utf-8",
      { "cache-control": "no-store" },
    );
  }

  return redirect("/login/github", {
    "set-cookie": cookie(request, sshLinkCookie, code, sshLinkSeconds),
  });
}

async function consumeSshLink(
  env: RuntimeEnv,
  user: User,
  code: string,
  now: number,
  githubToken: string,
): Promise<void> {
  const codeHash = await sha256(code);
  const db = database(env);
  const row = await db
    .selectFrom("ssh_link_codes")
    .select(["fingerprint", "public_key", "label", "expires_at", "consumed_at"])
    .where("code_hash", "=", codeHash)
    .executeTakeFirst();
  if (!row || row.consumed_at || row.expires_at <= now) {
    throw badRequest("SSH link expired");
  }
  const githubTokenCiphertext = await sealSecret(env, githubToken);
  await executeBatch(env, [
    db
      .insertInto("ssh_keys")
      .values({
        fingerprint: row.fingerprint,
        subject: user.subject,
        public_key: row.public_key,
        label: row.label,
        github_token_ciphertext: githubTokenCiphertext,
        created_at: now,
        last_used_at: now,
        revoked_at: null,
      })
      .onConflict((oc) =>
        oc.column("fingerprint").doUpdateSet({
          subject: user.subject,
          public_key: row.public_key,
          label: row.label,
          github_token_ciphertext: githubTokenCiphertext,
          last_used_at: now,
          revoked_at: null,
        }),
      ),
    db.updateTable("ssh_link_codes").set({ consumed_at: now }).where("code_hash", "=", codeHash),
  ]);
  await audit(env, user, `ssh key linked ${row.fingerprint}`, now);
}

function sshLinkConfirmHtml(
  code: string,
  fingerprint: string,
  label: string | null,
  user: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Link SSH key - Crabfleet</title>
  <style>
    body{font:16px/1.45 system-ui,sans-serif;margin:3rem;max-width:44rem;color:#111;background:#fff}
    code{background:#f3f4f6;padding:.15rem .35rem;border-radius:.25rem;word-break:break-all}
    button{font:inherit;padding:.65rem 1rem;border:0;border-radius:.4rem;background:#111;color:#fff}
  </style>
</head>
<body>
  <h1>Link SSH key</h1>
  <p>Signed in as <strong>${htmlEscape(user)}</strong>.</p>
  <p>Fingerprint: <code>${htmlEscape(fingerprint)}</code></p>
  ${label ? `<p>Label: <code>${htmlEscape(label)}</code></p>` : ""}
  <form method="post" action="/ssh/link/${encodeURIComponent(code)}">
    <button type="submit">Link this key</button>
  </form>
</body>
</html>`;
}

async function terminalHubUser(
  request: Request,
  env: RuntimeEnv,
  requestAuth: TrustedProxyAuthResult,
): Promise<User | null> {
  if (isSshGatewayRequest(request, env)) {
    return requireSshGatewayUser(request, env);
  }
  if (agentSessionId(request)) {
    return (await requireAgentSession(request, env)).user;
  }
  return optionalUser(request, env, requestAuth);
}

async function sshAuth(request: Request, env: RuntimeEnv): Promise<Record<string, unknown>> {
  requireSshGateway(request, env);
  const body = await readJson<{
    fingerprint?: string;
    publicKey?: string;
    label?: string;
    remoteIp?: string;
    createLink?: boolean;
  }>(request);
  const fingerprint = clean(body.fingerprint, 120);
  const publicKey = clean(body.publicKey, 4000);
  const label = clean(body.label, 200) || null;
  const remoteIp = clean(body.remoteIp, 120) || null;
  if (!fingerprint || !publicKey) throw badRequest("fingerprint and publicKey are required");

  const now = Date.now();
  if (!body.createLink) {
    const user = await readSshUser(env, fingerprint);
    if (!user) return { authorized: false };
    const attached = await database(env)
      .updateTable("ssh_keys")
      .set({ last_used_at: now })
      .where("fingerprint", "=", fingerprint)
      .executeTakeFirst();
    if ((attached.numUpdatedRows ?? 0n) === 0n) {
      throw conflict("interactive session lifecycle changed; retry attach");
    }
    return { authorized: true, user };
  }

  const db = database(env);
  await db.deleteFrom("ssh_link_codes").where("expires_at", "<=", now).execute();
  if (remoteIp) {
    const recent =
      (
        await sql<{ count: number }>`
        SELECT count(*) AS count
        FROM ssh_link_codes
        WHERE remote_ip = ${remoteIp}
          AND consumed_at IS NULL
          AND created_at > ${now - 10 * 60 * 1000}
      `.execute(db)
      ).rows[0]?.count ?? 0;
    if (recent >= 20) throw tooManyRequests("too many SSH link attempts; retry later");
  }
  await db
    .deleteFrom("ssh_link_codes")
    .where("fingerprint", "=", fingerprint)
    .where("consumed_at", "is", null)
    .execute();

  const code = crypto.randomUUID() + crypto.randomUUID();
  await db
    .insertInto("ssh_link_codes")
    .values({
      code_hash: await sha256(code),
      fingerprint,
      public_key: publicKey,
      label,
      remote_ip: remoteIp,
      expires_at: now + sshLinkSeconds * 1000,
      consumed_at: null,
      created_at: now,
    })
    .execute();
  const oauthOrigin = new URL(githubOAuthRedirectUri(request.url, env.GITHUB_REDIRECT_URI)).origin;
  const linkUrl = new URL(`/ssh/link/${encodeURIComponent(code)}`, oauthOrigin);
  return {
    authorized: false,
    linkUrl: linkUrl.toString(),
    expiresAt: now + sshLinkSeconds * 1000,
  };
}

async function sshState(request: Request, env: RuntimeEnv): Promise<Record<string, unknown>> {
  const user = await requireSshGatewayUser(request, env);
  const state = await readState(request, env, user);
  return { ...state, ssh: true };
}

async function agentState(request: Request, env: RuntimeEnv): Promise<Record<string, unknown>> {
  const { session, user } = await requireAgentSession(request, env);
  const state = await readState(request, env, user);
  return { ...state, agent: { sessionId: session.id, rootSessionId: session.rootSessionId } };
}

async function sshCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
): Promise<{ session: InteractiveSession }> {
  const user = await requireSshGatewayUser(request, env);
  requireRole(user, "maintainer");
  const githubToken = await sshKeyGitHubToken(request, env);
  if (user.subject.startsWith("github:") && !githubToken) {
    throw forbidden("GitHub credentials are not connected to this SSH key; re-link the key");
  }
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
    const preferred = deploymentConfig(env).preferredRepo;
    const repos = await database(env)
      .selectFrom("repos")
      .select("repo")
      .where("enabled", "=", 1)
      .orderBy("repo")
      .execute();
    const selectedRepo = preferredEnabledRepo(
      repos.map((repo) => repo.repo),
      preferred,
    );
    if (selectedRepo) body.repo = selectedRepo;
  }
  const result = await createInteractiveSessionFromInput(env, user, body, githubToken);
  await audit(env, user, `ssh interactive session created ${result.session.id}`, Date.now());
  return result;
}

async function agentCreateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
): Promise<{ session: InteractiveSession }> {
  const { session: parent, user } = await requireAgentSession(request, env);
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

async function openClawCreateCrabbox(
  request: Request,
  env: RuntimeEnv,
): Promise<{ session: InteractiveSession; browserUrl: string }> {
  requireOpenClawRoomService(request, env);
  const body = await readJson<{
    repo?: string;
    branch?: string;
    runtime?: string;
    profile?: string;
    command?: string;
    prompt?: string;
    owner?: string;
    parentSessionId?: string;
    rootSessionId?: string;
    purpose?: string;
    summary?: string;
    githubToken?: string;
    baseBranch?: string;
    requestId?: string;
  }>(request);
  const owner = openClawOwner(body.owner);
  body.branch = openClawServiceBranch(body.branch, "branch", "main");
  const baseBranch = openClawServiceBranch(body.baseBranch, "baseBranch");
  if (baseBranch) body.baseBranch = baseBranch;
  else delete body.baseBranch;
  const serviceUser = openClawServiceUser();
  const requestId = openClawRequestId(body.requestId);
  const requestHash = requestId
    ? await openClawCrabboxRequestHash(body, owner, deploymentConfig(env).defaultRuntime)
    : null;
  if (requestId && requestHash) {
    const existing = await readOpenClawRequestSession(env, requestId, requestHash);
    if (existing) {
      return openClawDecoratedCrabboxResponse(
        env,
        decorateInteractiveSession(existing, serviceUser, env),
      );
    }
  }
  const result = await createInteractiveSessionFromInput(
    env,
    serviceUser,
    body,
    clean(body.githubToken, 4000) || undefined,
    {
      owner,
      createdBy: "service:openclaw",
      openClawRequestId: requestId,
      openClawRequestHash: requestHash,
      afterReserve: async () => {
        const signal = AbortSignal.timeout(openClawPreparationTimeoutMs);
        try {
          await ensureOpenClawServiceBranch(env, body.repo, body.branch, body.baseBranch, signal);
        } catch (error) {
          if (signal.aborted) {
            throw serviceUnavailable("OpenClaw branch preparation timed out");
          }
          if (
            !(error instanceof GitHubApiError) ||
            !openClawBranchPreparationCanDefer(error.status)
          ) {
            throw error;
          }
          console.warn(
            JSON.stringify({
              event: "openclaw_branch_preparation_deferred",
              repo: normalizeRepo(body.repo),
              branch: clean(body.branch, 120) || "main",
              status: error.status,
            }),
          );
        }
      },
    },
  );
  await audit(
    env,
    serviceUser,
    `openclaw crabbox created ${result.session.id} owner=${owner}`,
    Date.now(),
  );
  return openClawDecoratedCrabboxResponse(env, result.session);
}

async function openClawReadSessionRoot(
  request: Request,
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<{
  rootSessionId: string;
  crabboxes: Array<{ session: InteractiveSession; browserUrl: string }>;
}> {
  requireOpenClawRoomService(request, env);
  const root = clean(rootSessionId, 120);
  if (!root) throw badRequest("root session id is required");
  const rootSession = await readOpenClawRoomRoot(env, root);
  const room = await readOpenClawRoomSessions(env, root, openClawRoomMaxSessions);
  const sessions = openClawVisibleRoomSessions(root, rootSession, room);
  const serviceUser = openClawServiceUser();
  return {
    rootSessionId: root,
    crabboxes: sessions.map((session) => openClawCrabboxSummaryResponse(env, serviceUser, session)),
  };
}

async function openClawMutateSessionRoot(
  request: Request,
  env: RuntimeEnv,
  rootSessionId: string,
): Promise<{
  rootSessionId: string;
  admissionClosed: true;
  crabboxes: Array<{ session: InteractiveSession; browserUrl: string }>;
}> {
  requireOpenClawRoomService(request, env);
  const body = await readJson<{ action?: string }>(request);
  if (body.action !== "stop") throw badRequest("only stop is supported");
  const root = clean(rootSessionId, 120);
  if (!root) throw badRequest("root session id is required");
  const serviceUser = openClawServiceUser();
  const result = await openClawRootStopService(request, env, serviceUser).stop(root);
  return {
    rootSessionId: result.rootSessionId,
    admissionClosed: true,
    crabboxes: result.sessions.map((session) =>
      openClawCrabboxSummaryResponse(env, serviceUser, session),
    ),
  };
}

async function openClawReadCrabbox(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<{ session: InteractiveSession; browserUrl: string }> {
  requireOpenClawRoomService(request, env);
  const session = await openClawRootScopedCrabbox(request, env, id);
  return openClawCrabboxSummaryResponse(env, openClawServiceUser(), session);
}

async function openClawReadCrabboxTranscript(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<{
  session: InteractiveSession;
  browserUrl: string;
  transcript: string;
  eventCount: number;
  truncated: boolean;
}> {
  requireOpenClawRoomService(request, env);
  const session = await openClawRootScopedCrabbox(request, env, id);
  const [eventWindow, eventCount] = await Promise.all([
    readInteractiveSessionEventRows(env, id, {
      limit: openClawTranscriptEventWindow,
      newest: true,
    }),
    countInteractiveSessionEvents(env, id),
  ]);
  const transcript = buildOpenClawTranscript(eventWindow, eventCount, (events) =>
    sessionLogTranscript(session, events),
  );
  const response = openClawCrabboxSummaryResponse(env, openClawServiceUser(), session);
  return {
    ...response,
    ...transcript,
  };
}

async function openClawMessageCrabbox(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<{ delivered: true; session: InteractiveSession; browserUrl: string }> {
  requireOpenClawRoomService(request, env);
  const body = await readJson<{ rootSessionId?: string; message?: string; enter?: boolean }>(
    request,
  );
  const session = await openClawRootScopedCrabbox(request, env, id, body.rootSessionId);
  const serviceUser = openClawServiceUser();
  await openClawMutationService(request, env, serviceUser).sendMessage(session, body);
  return {
    delivered: true,
    ...openClawCrabboxSummaryResponse(env, serviceUser, session),
  };
}

async function openClawMutateCrabbox(
  request: Request,
  env: RuntimeEnv,
  id: string,
): Promise<{ session: InteractiveSession; browserUrl: string }> {
  requireOpenClawRoomService(request, env);
  const body = await readJson<{ rootSessionId?: string; action?: string }>(request);
  await openClawRootScopedCrabbox(request, env, id, body.rootSessionId);
  if (body.action !== "stop") throw badRequest("only stop is supported");
  const serviceUser = openClawServiceUser();
  const session = await openClawMutationService(request, env, serviceUser).stopSession(id);
  return openClawCrabboxSummaryResponse(env, serviceUser, session);
}

async function openClawRootScopedCrabbox(
  request: Request,
  env: RuntimeEnv,
  id: string,
  bodyRootSessionId?: string,
): Promise<InteractiveSession> {
  const rootSessionId = clean(
    bodyRootSessionId ?? request.headers.get("x-crabfleet-root-session-id"),
    120,
  );
  if (!rootSessionId) throw badRequest("root session id is required");
  return openClawSupervision(env).requireRootScopedSession(id, rootSessionId);
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

function openClawCrabboxResponse(
  env: RuntimeEnv,
  serviceUser: User,
  session: InteractiveSession,
): { session: InteractiveSession; browserUrl: string } {
  return openClawDecoratedCrabboxResponse(
    env,
    decorateInteractiveSession(session, serviceUser, env),
  );
}

function openClawCrabboxSummaryResponse(
  env: RuntimeEnv,
  serviceUser: User,
  session: InteractiveSession,
): { session: InteractiveSession; browserUrl: string } {
  const response = openClawCrabboxResponse(env, serviceUser, session);
  return { ...response, session: openClawSessionSummary(response.session) };
}

function openClawDecoratedCrabboxResponse(
  env: RuntimeEnv,
  session: InteractiveSession,
): { session: InteractiveSession; browserUrl: string } {
  return {
    session,
    browserUrl: `${browserAppOrigin(env)}/app/sessions/${encodeURIComponent(session.id)}`,
  };
}

async function openClawRegisterActionSession(
  request: Request,
  env: RuntimeEnv,
): Promise<{
  session: InteractiveSession;
  agentToken: string;
  runnerPtyUrl: string;
  browserUrl: string;
}> {
  requireOpenClawAutomationService(request, env);
  const body = await readJson<{
    workKey?: string;
    workKind?: string;
    repo?: string;
    branch?: string;
    sourceUrl?: string;
    runUrl?: string;
    purpose?: string;
    summary?: string;
  }>(request);
  const workKey = actionWorkIdentifier(body.workKey, "workKey", 300);
  const workKind = actionWorkIdentifier(body.workKind, "workKind", 80);
  const repo = normalizeRepo(body.repo);
  if (!repo) throw badRequest("repo is required");
  await requireRepo(env, repo);
  const branch = clean(body.branch, 120) || "main";
  const sourceUrl = optionalHttpUrl(body.sourceUrl, "sourceUrl");
  const runUrl = optionalHttpUrl(body.runUrl, "runUrl");
  const serviceUser = openClawServiceUser();
  const agentToken = newAgentToken();
  const agentTokenHash = await sha256(agentToken);
  const now = Date.now();
  const db = database(env);
  let existing = await db
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("work_key", "=", workKey)
    .executeTakeFirst();
  const purpose =
    clean(body.purpose, 500) ||
    existing?.purpose ||
    `${workKind.replaceAll("_", " ")} in ${repo}@${branch}`;
  const summary = clean(body.summary, 500) || existing?.summary || purpose;

  if (!existing) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = await nextInteractiveSessionId(env);
      try {
        await db
          .insertInto("interactive_sessions")
          .values({
            id,
            parent_session_id: null,
            root_session_id: id,
            repo,
            branch,
            runtime: githubActionsRuntime,
            adapter: null,
            profile: "github-actions",
            adapter_workspace_id: null,
            adapter_control_plane: null,
            provider_resource_id: null,
            capabilities_json: JSON.stringify(githubActionsCapabilities),
            expires_at: null,
            last_reconciled_at: null,
            reconcile_error: null,
            terminal_status: null,
            adapter_ttl_seconds: null,
            adapter_idle_timeout_seconds: null,
            adapter_requested_capabilities_json: null,
            adapter_create_payload_json: null,
            adapter_create_pending: 0,
            command: "codex",
            prompt: purpose,
            purpose,
            summary,
            owner: `github-actions:${id}`,
            created_by: "service:openclaw",
            status: "ready",
            lease_id: null,
            attach_url: null,
            vnc_url: null,
            last_event: "GitHub Actions work registered",
            created_at: now,
            updated_at: now,
            last_seen_at: now,
            stopped_at: null,
            share_mode: "private",
            share_token_hash: null,
            share_token_preview: null,
            control_requested_by: null,
            control_requested_at: null,
            controller: null,
            control_granted_at: null,
            control_expires_at: null,
            multiplayer_mode: 0,
            agent_token_hash: agentTokenHash,
            work_key: workKey,
            work_kind: workKind,
            work_state: "registered",
            work_phase: "waiting_for_runner",
            source_url: sourceUrl,
            github_run_url: runUrl,
            codex_thread_id: null,
            codex_turn_id: null,
            last_heartbeat_at: null,
            completion_reason: null,
          })
          .execute();
        existing = await db
          .selectFrom("interactive_sessions")
          .selectAll()
          .where("id", "=", id)
          .executeTakeFirst();
        break;
      } catch (error) {
        if (!isConstraintError(error)) throw error;
        existing = await db
          .selectFrom("interactive_sessions")
          .selectAll()
          .where("work_key", "=", workKey)
          .executeTakeFirst();
        if (existing) break;
        if (attempt === 2) throw error;
      }
    }
  }

  if (!existing) throw new Error("failed to register GitHub Actions session");
  if (existing.runtime !== githubActionsRuntime) {
    throw badRequest("workKey is already registered to a different runtime");
  }
  const resumed = existing.work_state !== "registered" || existing.status !== "ready";
  await db
    .updateTable("interactive_sessions")
    .set({
      repo,
      branch,
      purpose,
      summary,
      prompt: purpose,
      status: "ready",
      lease_id: null,
      stopped_at: null,
      terminal_status: null,
      terminal_failure_reason: null,
      terminal_finalize_pending: 0,
      credential_cleanup_terminal_status: null,
      updated_at: now,
      last_seen_at: now,
      last_event: resumed ? "GitHub Actions work resumed" : "GitHub Actions work registered",
      agent_token_hash: agentTokenHash,
      work_kind: workKind,
      work_state: "registered",
      work_phase: "waiting_for_runner",
      source_url: body.sourceUrl === undefined ? existing.source_url : sourceUrl,
      github_run_url: body.runUrl === undefined ? existing.github_run_url : runUrl,
      last_heartbeat_at: null,
      completion_reason: null,
    })
    .where("id", "=", existing.id)
    .execute();
  await disconnectGitHubActionsRunner(env, existing.id).catch(() => undefined);
  const message = resumed ? "GitHub Actions work resumed" : "GitHub Actions work registered";
  await appendInteractiveSessionEvent(env, existing.id, serviceUser, message, now);
  await audit(
    env,
    serviceUser,
    `openclaw action session ${resumed ? "resumed" : "registered"} ${existing.id} work=${workKey}`,
    now,
  );
  const session = (await readInteractiveSession(env, existing.id)) as InteractiveSession;
  return {
    session: decorateInteractiveSession(session, serviceUser, env),
    agentToken,
    runnerPtyUrl: buildGitHubActionsRunnerPtyUrl(appCanonicalOrigin, existing.id, agentToken),
    browserUrl: `${browserAppOrigin(env)}/app/sessions/${encodeURIComponent(existing.id)}`,
  };
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

function requireOpenClawAutomationService(request: Request, env: RuntimeEnv): void {
  requireOpenClawServiceToken(request, [env.CRABBOX_OPENCLAW_TOKEN]);
}

function requireOpenClawRoomService(request: Request, env: RuntimeEnv): void {
  requireOpenClawServiceToken(request, [env.CRABBOX_OPENCLAW_TOKEN, env.CRABBOX_MULTICODEX_TOKEN]);
}

function requireOpenClawServiceToken(
  request: Request,
  tokens: Array<string | null | undefined>,
): void {
  if (!tokens.some(Boolean)) {
    throw serviceUnavailable("OpenClaw service token is not configured");
  }
  if (!openClawServiceAuthorized(request.headers.get("authorization"), tokens)) {
    throw unauthorized();
  }
}

function openClawServiceBranch(value: unknown, name: string, fallback = ""): string {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "string" || !openClawGitBranchAllowed(value)) {
    throw badRequest(`${name} must be a valid Git branch of at most 120 characters`);
  }
  return value;
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

function actionWorkIdentifier(value: unknown, name: string, max: number): string {
  const identifier = String(value ?? "").trim();
  if (!identifier) throw badRequest(`${name} is required`);
  if (identifier.length > max) throw badRequest(`${name} exceeds ${max} characters`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/@+#=-]*$/.test(identifier)) {
    throw badRequest(`${name} contains unsupported characters`);
  }
  return identifier;
}

function optionalHttpUrl(value: unknown, name: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (raw.length > 1000) throw badRequest(`${name} exceeds 1000 characters`);
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
    return url.toString();
  } catch {
    throw badRequest(`${name} must be an http(s) URL`);
  }
}

function openClawOwner(value: unknown): string {
  const owner = clean(value, 240);
  if (!owner) throw badRequest("owner is required");
  if (/^[A-Za-z0-9_.-]+$/.test(owner)) return owner;
  if (/^@[A-Za-z0-9_.-]+$/.test(owner)) return owner.slice(1);
  if (/^github:[A-Za-z0-9_.-]+$/.test(owner)) return owner.replace(/^github:/, "");
  return owner;
}

async function requireSshGatewayUser(request: Request, env: RuntimeEnv): Promise<User> {
  requireSshGateway(request, env);
  const fingerprint = sshFingerprint(request);
  if (!fingerprint) throw badRequest("fingerprint is required");
  const user = await readSshUser(env, fingerprint);
  if (!user) throw unauthorized();
  return user;
}

async function requireAgentSession(
  request: Request,
  env: RuntimeEnv,
  expectedId?: string,
  options: { allowQueryToken?: boolean } = {},
): Promise<{ session: InteractiveSession; user: User }> {
  const presentedId = agentSessionId(request);
  const id = clean(expectedId, 120) || presentedId;
  if (expectedId && presentedId && presentedId !== expectedId) throw unauthorized();
  const url = new URL(request.url);
  const token =
    bearerToken(request) ||
    clean(request.headers.get("x-crabfleet-agent-token"), 200) ||
    (options.allowQueryToken ? clean(url.searchParams.get("agentToken"), 200) : "");
  if (!id || !token) throw unauthorized();
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("preparation_pending", "=", 0)
    .executeTakeFirst();
  if (!row?.agent_token_hash || row.agent_token_hash !== (await sha256(token))) {
    throw unauthorized();
  }
  const session = interactiveSession(row, []);
  if (session.status === "stopping" || deadInteractiveSessionStatuses.includes(session.status)) {
    throw forbidden("agent session is not active");
  }
  return {
    session,
    user: {
      subject: `agent:${session.id}`,
      login: session.owner,
      email: null,
      name: `Codex ${session.id}`,
      role: "viewer",
      allowed: true,
      teams: [],
    },
  };
}

function requireSshGateway(request: Request, env: RuntimeEnv): void {
  const tokens = sshGatewayTokens(env);
  if (!tokens.length) throw serviceUnavailable("SSH gateway is not configured");
  const authorization = request.headers.get("authorization") ?? "";
  if (!tokens.some((token) => authorization === `Bearer ${token}`)) throw unauthorized();
}

async function readSshUser(env: RuntimeEnv, fingerprint: string): Promise<User | null> {
  const row = await database(env)
    .selectFrom("ssh_keys as k")
    .innerJoin("users as u", "u.subject", "k.subject")
    .select([
      "u.subject",
      "u.login",
      "u.email",
      "u.name",
      "u.role",
      "u.allowed",
      "u.teams",
      "k.github_token_ciphertext",
    ])
    .where("k.fingerprint", "=", fingerprint)
    .where("k.revoked_at", "is", null)
    .executeTakeFirst();
  if (!row) return null;
  const user: User = {
    subject: row.subject,
    login: row.login,
    email: row.email,
    name: row.name,
    role: row.role,
    allowed: row.allowed === 1,
    teams: parseJson(row.teams, []),
  };
  if (user.subject.startsWith("github:")) {
    if (!row.github_token_ciphertext) {
      throw forbidden("SSH key needs to be re-linked with GitHub");
    }
    const githubToken = await openSecret(env, row.github_token_ciphertext);
    if (!githubToken) throw forbidden("SSH key GitHub credentials are unavailable");
    const freshUser = await refreshGitHubUser(env, githubToken).catch(() => null);
    if (!freshUser || freshUser.subject !== user.subject) {
      throw forbidden("GitHub membership refresh failed");
    }
    const authorized = await authorize(env, freshUser);
    if (!authorized.allowed) throw forbidden("user is no longer allowlisted");
    await upsertUser(env, authorized, Date.now());
    return authorized;
  }
  const authorized = await authorize(env, user);
  if (!authorized.allowed) throw forbidden("user is no longer allowlisted");
  return authorized;
}

async function sshKeyGitHubToken(request: Request, env: RuntimeEnv): Promise<string | undefined> {
  requireSshGateway(request, env);
  const fingerprint = sshFingerprint(request);
  if (!fingerprint) throw badRequest("fingerprint is required");
  const user = await requireSshGatewayUser(request, env);
  return sshKeyGitHubTokenByFingerprint(env, fingerprint, user.subject);
}

async function sshGatewayKeyGitHubToken(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<string | undefined> {
  if (!isSshGatewayRequest(request, env)) return undefined;
  const fingerprint = sshFingerprint(request);
  return fingerprint ? sshKeyGitHubTokenByFingerprint(env, fingerprint, user.subject) : undefined;
}

async function sshKeyGitHubTokenByFingerprint(
  env: RuntimeEnv,
  fingerprint: string,
  subject: string,
): Promise<string | undefined> {
  const row = await database(env)
    .selectFrom("ssh_keys")
    .select("github_token_ciphertext")
    .where("fingerprint", "=", fingerprint)
    .where("subject", "=", subject)
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  return row?.github_token_ciphertext
    ? ((await openSecret(env, row.github_token_ciphertext)) ?? undefined)
    : undefined;
}

function isSshGatewayRequest(request: Request, env: RuntimeEnv): boolean {
  const tokens = sshGatewayTokens(env);
  const authorization = request.headers.get("authorization") ?? "";
  return Boolean(tokens.length && tokens.some((token) => authorization === `Bearer ${token}`));
}

function sshFingerprint(request: Request): string {
  const url = new URL(request.url);
  return (
    clean(request.headers.get("x-crabfleet-ssh-fingerprint"), 120) ||
    clean(request.headers.get("x-crabbox-ssh-fingerprint"), 120) ||
    clean(url.searchParams.get("fingerprint"), 120)
  );
}

function agentSessionId(request: Request): string {
  const url = new URL(request.url);
  return (
    clean(request.headers.get("x-crabfleet-session-id"), 120) ||
    clean(request.headers.get("x-crabbox-session-id"), 120) ||
    clean(url.searchParams.get("sessionId"), 120)
  );
}

function sshGatewayTokens(env: RuntimeEnv): string[] {
  return [env.CRABFLEET_SSH_GATEWAY_TOKEN, env.CRABBOX_SSH_GATEWAY_TOKEN].filter(
    (token): token is string => Boolean(token),
  );
}

async function reconcileExternalInteractiveSessions(
  env: RuntimeEnv,
  now: number,
  context?: ExecutionContext,
): Promise<void> {
  const reconciliation = reconcileInteractiveSessionLifecycleBatch(env, now).catch((error) => {
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

async function reconcileInteractiveSessionLifecycleBatch(
  env: RuntimeEnv,
  now: number,
): Promise<void> {
  await cleanupAbandonedInteractiveSessionPreparations(env, now);
  await reconcileCredentialPolicyCleanupBatch(env, now);
  await reconcileLegacyStoppingInteractiveSessionBatch(env, now);
  await reconcileExternalInteractiveSessionBatch(env, now);
}

async function reconcileLegacyStoppingInteractiveSessionBatch(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  let query = database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("status", "=", "stopping")
    .where((expression) =>
      expression.or([
        expression("adapter", "is", null),
        expression("adapter", "!=", runtimeAdapterName),
      ]),
    )
    .where("runtime", "!=", githubActionsRuntime)
    .where("credential_cleanup_terminal_status", "is", null)
    .where(sql<boolean>`lease_id IS NULL OR lease_id NOT LIKE ${`${sandboxLeasePrefix}%`}`)
    .orderBy("updated_at", "asc")
    .limit(runtimeAdapterReconcileLimit);
  if (sessionId) query = query.where("id", "=", sessionId);
  const candidates = await query.execute();
  await mapWithConcurrency(candidates, runtimeAdapterReconcileConcurrency, async (session) => {
    await completeLegacyInteractiveSessionStop(
      env,
      {
        id: session.id,
        status: session.status,
        runtime: session.runtime,
        adapter: session.adapter,
        leaseId: session.lease_id,
        updatedAt: session.updated_at,
      },
      "system",
      now,
    ).catch((error) => {
      console.error(`legacy interactive session stop recovery failed for ${session.id}`, error);
    });
  });
}

async function requeueTerminalArchiveObjectBackfill(
  env: RuntimeEnv,
  sessionId?: string,
): Promise<void> {
  if (!env.SESSION_LOGS) return;
  const sessionFilter = sessionId ? sql`AND session.id = ${sessionId}` : sql``;
  const limit = sessionId ? 1 : runtimeAdapterReconcileLimit * 2;
  await sql`
    UPDATE interactive_sessions
    SET terminal_finalize_pending = 1,
        last_reconciled_at = NULL
    WHERE id IN (
      SELECT session.id
      FROM interactive_sessions AS session
      JOIN interactive_session_log_archives AS archive
        ON archive.session_id = session.id
      WHERE session.status IN ('stopped', 'expired', 'failed')
        AND session.terminal_finalize_pending = 0
        AND (
          archive.events_key IS NULL
          OR archive.transcript_key IS NULL
          OR archive.summary_key IS NULL
        )
        ${sessionFilter}
      ORDER BY session.updated_at ASC, session.id ASC
      LIMIT ${limit}
    )
  `.execute(database(env));
}

async function reconcileExternalInteractiveSessionBatch(
  env: RuntimeEnv,
  now: number,
): Promise<void> {
  await requeueTerminalArchiveObjectBackfill(env);
  const providerConfigured = runtimeAdapterProviderConfigured(env);
  const activeStatuses: InteractiveSessionStatus[] = [
    "provisioning",
    "pending_adapter",
    "ready",
    "attached",
    "detached",
    "stopping",
  ];
  const terminalStatuses: InteractiveSessionStatus[] = ["stopped", "expired", "failed"];
  const rows = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where((expression) =>
      providerConfigured
        ? expression.or([
            expression.and([
              expression("status", "in", terminalStatuses),
              expression("terminal_finalize_pending", "=", 1),
            ]),
            expression.and([
              expression("adapter", "=", runtimeAdapterName),
              expression("status", "in", activeStatuses),
            ]),
          ])
        : expression.and([
            expression("status", "in", terminalStatuses),
            expression("terminal_finalize_pending", "=", 1),
          ]),
    )
    .orderBy("last_reconciled_at", "asc")
    .limit(runtimeAdapterReconcileLimit * 2)
    .execute();
  const due = rows
    .filter(
      (row) =>
        !row.last_reconciled_at ||
        now - row.last_reconciled_at >= runtimeAdapterReconcileIntervalMs,
    )
    .slice(0, runtimeAdapterReconcileLimit);
  await mapWithConcurrency(due, runtimeAdapterReconcileConcurrency, async (row) => {
    await reconcileExternalInteractiveSession(env, row, now);
  });
}

async function reconcileExternalInteractiveSessionById(
  env: RuntimeEnv,
  id: string,
  now = Date.now(),
): Promise<void> {
  await reconcileCredentialPolicyCleanupBatch(env, now, id);
  await reconcileLegacyStoppingInteractiveSessionBatch(env, now, id);
  await requeueTerminalArchiveObjectBackfill(env, id);
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) return;
  const terminalFinalizationPending =
    row.terminal_finalize_pending === 1 &&
    (row.status === "stopped" || row.status === "expired" || row.status === "failed");
  const providerConfigured = runtimeAdapterProviderConfigured(env);
  const active = [
    "provisioning",
    "pending_adapter",
    "ready",
    "attached",
    "detached",
    "stopping",
  ].includes(row.status);
  if (
    !terminalFinalizationPending &&
    (row.adapter !== runtimeAdapterName || !providerConfigured || !active)
  ) {
    return;
  }
  if (row.last_reconciled_at && now - row.last_reconciled_at < runtimeAdapterReconcileIntervalMs) {
    return;
  }
  await reconcileExternalInteractiveSession(env, row, now);
}

async function reconcileExternalInteractiveSession(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  now: number,
): Promise<void> {
  const terminalFinalizationStatus: "stopped" | "expired" | "failed" | null =
    row.terminal_finalize_pending === 1 &&
    (row.status === "stopped" || row.status === "expired" || row.status === "failed")
      ? row.status
      : null;
  if (
    !terminalFinalizationStatus &&
    (row.adapter !== runtimeAdapterName || !row.adapter_workspace_id)
  ) {
    return;
  }
  const claimAt = Math.max(now, Date.now(), (row.last_reconciled_at ?? 0) + 1);
  let claim = database(env)
    .updateTable("interactive_sessions")
    .set({ last_reconciled_at: claimAt })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("updated_at", "=", row.updated_at);
  claim = row.last_reconciled_at
    ? claim.where("last_reconciled_at", "=", row.last_reconciled_at)
    : claim.where("last_reconciled_at", "is", null);
  const claimed = await claim.executeTakeFirst();
  if ((claimed.numUpdatedRows ?? 0n) === 0n) return;

  try {
    if (terminalFinalizationStatus) {
      await finalizeTerminalInteractiveSession(
        env,
        row.id,
        terminalFinalizationStatus,
        row.stopped_at ?? now,
      );
      return;
    }
    if (row.adapter !== runtimeAdapterName || !row.adapter_workspace_id) return;
    const inspected = await inspectRuntimeAdapterWorkspace(env, row, claimAt);
    const completedAt = Math.max(Date.now(), claimAt);
    const completionVersion = Math.max(completedAt, row.updated_at + 1);
    const requestedTerminalStatus =
      inspected.terminalStatus === undefined ? row.terminal_status : inspected.terminalStatus;
    const status = reconciledInteractiveStatus(
      row.status,
      inspected.status,
      requestedTerminalStatus,
    );
    const inactive = ["stopping", "stopped", "expired", "failed"].includes(status);
    const terminalStatus = ["stopped", "expired", "failed"].includes(status)
      ? null
      : requestedTerminalStatus;
    const terminal = inactive
      ? null
      : inspected.attachUrlPresent
        ? inspected.attachUrl
        : row.attach_url;
    const capabilities = inspected.capabilities
      ? JSON.stringify(inspected.capabilities)
      : inspected.capabilitiesPresent
        ? JSON.stringify(clearedAdapterCapabilities)
        : row.capabilities_json;
    const expiresAt = inspected.expiresAtPresent ? (inspected.expiresAt ?? null) : row.expires_at;
    const createPending =
      inspected.createPending === undefined
        ? row.adapter_create_pending
        : inspected.createPending
          ? 1
          : 0;
    const stateChanged =
      status !== row.status ||
      terminal !== row.attach_url ||
      capabilities !== row.capabilities_json ||
      (inspected.providerResourceId ?? row.provider_resource_id) !== row.provider_resource_id ||
      expiresAt !== row.expires_at ||
      terminalStatus !== row.terminal_status ||
      createPending !== row.adapter_create_pending ||
      (inspected.reconcileError ?? null) !== row.reconcile_error;
    const messageChanged = inspected.message !== row.last_event;
    const expectedOwner = sql<boolean>`
      id = ${row.id}
      AND adapter = ${runtimeAdapterName}
      AND status = ${row.status}
      AND updated_at = ${row.updated_at}
      AND last_reconciled_at = ${claimAt}
    `;
    const db = database(env);
    const update = db
      .updateTable("interactive_sessions")
      .set({
        status,
        lease_id: null,
        provider_resource_id: inspected.providerResourceId ?? row.provider_resource_id,
        attach_url: terminal,
        // Connection-bearing desktop URLs are never persisted.
        vnc_url: null,
        capabilities_json: capabilities,
        expires_at: expiresAt,
        last_reconciled_at: completedAt,
        reconcile_error: inspected.reconcileError ?? null,
        terminal_status: terminalStatus,
        adapter_create_pending: createPending,
        terminal_finalize_pending: ["stopped", "expired", "failed"].includes(status)
          ? 1
          : row.terminal_finalize_pending,
        ...(inactive
          ? {
              agent_token_hash: null,
              controller: null,
              control_requested_by: null,
              control_requested_at: null,
              control_granted_at: null,
              control_expires_at: null,
            }
          : {}),
        stopped_at: ["stopped", "expired", "failed"].includes(status)
          ? (row.stopped_at ?? completedAt)
          : row.stopped_at,
        ...(stateChanged || messageChanged
          ? { updated_at: completionVersion, last_event: inspected.message }
          : {}),
      })
      .where(expectedOwner)
      .returning("updated_at");
    const queries: CompilableQuery[] = [];
    if (stateChanged || messageChanged) {
      queries.push(sql`
        INSERT INTO interactive_session_events (session_id, actor, message, created_at)
        SELECT ${row.id}, 'system', ${clean(inspected.message, 1000)}, ${completedAt}
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
    if (!results.at(-1)?.results.length) {
      const current = await readInteractiveSession(env, row.id);
      if (current && ["stopped", "expired", "failed"].includes(current.status)) {
        await finalizeTerminalInteractiveSession(
          env,
          current.id,
          current.status as "stopped" | "expired" | "failed",
          current.stoppedAt ?? now,
        ).catch(() => undefined);
        return;
      }
      const currentAdapterProvision = Boolean(
        current &&
        current.adapter === runtimeAdapterName &&
        current.adapterWorkspaceId === inspected.adapterWorkspaceId &&
        ["provisioning", "pending_adapter", "ready", "attached", "detached"].includes(
          current.status,
        ),
      );
      if (!currentAdapterProvision && inspected.adapterWorkspaceId) {
        await stopSupersededRuntimeAdapterProvision(
          env,
          row.id,
          inspected.adapterWorkspaceId,
          inspected.createPending === true,
          Date.now(),
        );
      }
      return;
    }
    if (stateChanged || messageChanged) {
      await archiveInteractiveSessionLogs(env, row.id, completedAt).catch(() => undefined);
    }
    if (
      status !== row.status &&
      (status === "stopped" || status === "expired" || status === "failed")
    ) {
      await finalizeTerminalInteractiveSession(
        env,
        row.id,
        status,
        row.stopped_at ?? completedAt,
      ).catch(() => undefined);
    }
  } catch (error) {
    const failedAt = Math.max(Date.now(), claimAt);
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        last_reconciled_at: failedAt,
        reconcile_error: safeProviderError(
          error,
          [row.adapter_workspace_id, row.provider_resource_id],
          [row.attach_url],
        ),
        updated_at: Math.max(failedAt, row.updated_at + 1),
      })
      .where("id", "=", row.id)
      .where("status", "=", row.status)
      .where("updated_at", "=", row.updated_at)
      .where("last_reconciled_at", "=", claimAt)
      .execute();
  }
}

function reconciledInteractiveStatus(
  current: InteractiveSessionStatus,
  next: InteractiveSessionStatus,
  terminalStatus: "failed" | null,
): InteractiveSessionStatus {
  if (current === "stopping") {
    if (["stopped", "expired", "failed"].includes(next)) return terminalStatus ?? next;
    return "stopping";
  }
  if ((current === "attached" || current === "detached") && next === "ready") return current;
  return next;
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  operation: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const worker = async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index] as T);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), values.length) }, () => worker()),
  );
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
    ptyBridgeUrl: env.CRABBOX_PTY_BRIDGE_URL,
    cloudflareRunnerUrl: env.CRABBOX_CLOUDFLARE_RUNNER_URL,
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
  body: {
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
  },
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
  const repo = normalizeRepo(body.repo);
  if (!repo) throw badRequest("repo is required");
  await requireRepo(env, repo);
  const branch = clean(body.branch, 120) || "main";
  const deployment = deploymentConfig(env);
  const runtime = oneOf(body.runtime, ["crabbox", "container"], deployment.defaultRuntime) as
    | "crabbox"
    | "container";
  const { profile, descriptor: runtimeProfile } = selectedRuntimeProfile(deployment, body.profile);
  requireRuntimeAdapterCreatePreflight(env, runtime, profile);
  const requestedCapabilities = runtimeProfileCapabilities(
    runtime === "crabbox" ? runtimeProfile : undefined,
    runtime === "crabbox" ? crabboxCapabilities : containerCapabilities,
  );
  const command = interactiveCommand(body.command);
  const prompt = clean(body.prompt, 4000);
  const purpose = interactiveSessionPurpose(body.purpose, prompt, repo, branch, command);
  const summary = interactiveSessionSummary(body.summary, purpose, prompt);
  const owner = options.owner || actor(user);
  const createdBy = options.createdBy || actor(user);
  const lineage = await resolveInteractiveSessionLineage(
    env,
    user,
    options.parentSessionId ?? (clean(body.parentSessionId, 120) || null),
    options.rootSessionId ?? (clean(body.rootSessionId, 120) || null),
  );
  const supervision = openClawSupervision(env);
  const supervisedRootSessionId = await supervision.supervisedRootForCreate(createdBy, lineage);
  const preparationReservation = Boolean(options.afterReserve || supervisedRootSessionId);
  const now = Date.now();
  const db = database(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let reservationInserted = false;
    const id = await nextInteractiveSessionId(env);
    const rootSessionId = lineage.rootSessionId ?? id;
    const agentToken = newAgentToken();
    const initialAgentTokenHash = await sha256(agentToken);
    const initialSandboxLease = runtime === "container" && env.SANDBOX ? newSandboxLease(id) : null;
    const initialSandboxOwnership: SandboxCurrentLeaseFence | null = initialSandboxLease
      ? {
          leaseId: sandboxLeaseId(initialSandboxLease),
          sandboxId: initialSandboxLease.sandboxId,
        }
      : null;
    const adapterWorkspaceId = initialRuntimeAdapterWorkspaceId(env, runtime, id);
    const adapterControlPlane = adapterWorkspaceId
      ? configuredRuntimeAdapterControlPlane(env, profile)
      : null;
    const adapterSettings = adapterWorkspaceId
      ? runtimeAdapterCreateSettings(env, requestedCapabilities)
      : null;
    const adapterCreatePayload =
      adapterWorkspaceId && adapterSettings
        ? runtimeAdapterCreatePayload(
            {
              namespace: normalizeAdapterNamespace(
                env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "",
              ) as string,
              id,
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
              ttlSeconds: adapterSettings.ttlSeconds,
              idleTimeoutSeconds: adapterSettings.idleTimeoutSeconds,
              desktop: adapterSettings.capabilities.desktop,
            },
            adapterWorkspaceId,
          )
        : null;
    const adapterCreatePayloadJson = adapterCreatePayload
      ? JSON.stringify(adapterCreatePayload)
      : null;
    try {
      const insertSession = db.insertInto("interactive_sessions").values({
        id,
        parent_session_id: lineage.parentSessionId,
        root_session_id: rootSessionId,
        repo,
        branch,
        runtime,
        adapter: adapterWorkspaceId && !preparationReservation ? runtimeAdapterName : null,
        profile,
        adapter_workspace_id: adapterWorkspaceId,
        adapter_control_plane: adapterControlPlane,
        provider_resource_id: null,
        capabilities_json: JSON.stringify(requestedCapabilities),
        expires_at: null,
        last_reconciled_at: adapterWorkspaceId && !preparationReservation ? now : null,
        reconcile_error:
          adapterWorkspaceId && !preparationReservation ? "runtime adapter create pending" : null,
        terminal_status: null,
        adapter_ttl_seconds: adapterSettings?.ttlSeconds ?? null,
        adapter_idle_timeout_seconds: adapterSettings?.idleTimeoutSeconds ?? null,
        adapter_requested_capabilities_json: adapterSettings
          ? JSON.stringify(adapterSettings.capabilities)
          : null,
        adapter_create_payload_json: adapterCreatePayloadJson,
        adapter_create_pending: adapterWorkspaceId && !preparationReservation ? 1 : 0,
        preparation_pending: preparationReservation ? 1 : 0,
        openclaw_request_id: options.openClawRequestId ?? null,
        openclaw_request_hash: options.openClawRequestHash ?? null,
        openclaw_admission_closed: 0,
        command,
        prompt,
        purpose,
        summary,
        owner,
        created_by: createdBy,
        status: "provisioning",
        lease_id: initialSandboxOwnership?.leaseId ?? null,
        attach_url: null,
        vnc_url: null,
        last_event: "interactive workspace requested",
        created_at: now,
        updated_at: now,
        last_seen_at: now,
        stopped_at: null,
        share_mode: "private",
        share_token_hash: null,
        share_token_preview: null,
        control_requested_by: null,
        control_requested_at: null,
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
        multiplayer_mode: 0,
        agent_token_hash: initialAgentTokenHash,
        work_key: null,
        work_kind: null,
        work_state: "",
        work_phase: "",
        source_url: null,
        github_run_url: null,
        codex_thread_id: null,
        codex_turn_id: null,
        last_heartbeat_at: null,
        completion_reason: null,
      });
      if (options.openClawRequestId && options.openClawRequestHash) {
        await executeBatch(env, [
          db.insertInto("openclaw_request_replays").values({
            request_id: options.openClawRequestId,
            request_hash: options.openClawRequestHash,
            session_id: id,
            created_at: now,
            updated_at: now,
          }),
          insertSession,
        ]);
      } else {
        await insertSession.execute();
      }
      reservationInserted = true;
      if (supervisedRootSessionId) {
        await supervision.enforceRoomSessionLimitAfterInsert(supervisedRootSessionId, id, now);
      }
      try {
        await options.afterReserve?.();
      } catch (error) {
        await supervision.rollbackReservation(id, now);
        throw error;
      }
      if (preparationReservation) {
        await supervision.requireReservationActivation(id, now, adapterWorkspaceId);
      }
      await appendInteractiveSessionEvent(env, id, user, "interactive workspace requested", now);
      const provisioned = await provisionInteractiveSession(
        env,
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
      );
      if (provisioned) {
        const initialTerminalStatus: "stopped" | "expired" | "failed" | null =
          provisioned.status === "stopped" ||
          provisioned.status === "expired" ||
          provisioned.status === "failed"
            ? provisioned.status
            : null;
        const terminalAt = provisioned.reconciledAt ?? now + 1;
        const completionVersionFloor = Math.max(terminalAt, now + 1);
        const provisionUpdate = await db
          .updateTable("interactive_sessions")
          .set({
            status: provisioned.status,
            lease_id: provisioned.adapter === runtimeAdapterName ? null : provisioned.leaseId,
            attach_url: initialTerminalStatus ? null : provisioned.attachUrl,
            // Versioned adapter desktop URLs are minted on demand and never persisted.
            vnc_url: provisioned.adapter === runtimeAdapterName ? null : provisioned.vncUrl,
            adapter: provisioned.adapter ?? null,
            profile: provisioned.profile ?? profile,
            adapter_workspace_id: provisioned.adapterWorkspaceId ?? null,
            provider_resource_id: provisioned.providerResourceId ?? null,
            capabilities_json: JSON.stringify(provisioned.capabilities ?? requestedCapabilities),
            expires_at: provisioned.expiresAt ?? null,
            last_reconciled_at: provisioned.reconciledAt ?? null,
            reconcile_error: provisioned.reconcileError ?? null,
            terminal_status: initialTerminalStatus ? null : (provisioned.terminalStatus ?? null),
            adapter_create_pending: initialTerminalStatus ? 0 : provisioned.createPending ? 1 : 0,
            terminal_finalize_pending: initialTerminalStatus ? 1 : 0,
            ...(initialTerminalStatus
              ? {
                  stopped_at: terminalAt,
                  agent_token_hash: null,
                  controller: null,
                  control_requested_by: null,
                  control_requested_at: null,
                  control_granted_at: null,
                  control_expires_at: null,
                }
              : {}),
            last_event: provisioned.message,
            updated_at: sql<number>`MAX(updated_at + 1, ${completionVersionFloor})`,
          })
          .where("id", "=", id)
          .where("status", "in", ["provisioning", "pending_adapter"])
          .where(sql<boolean>`lease_id IS ${initialSandboxOwnership?.leaseId ?? null}`)
          .where("agent_token_hash", "=", initialAgentTokenHash)
          .where("sandbox_refresh_sandbox_id", "is", null)
          .where("sandbox_refresh_claim", "is", null)
          .where("sandbox_refresh_claim_expires_at", "is", null)
          .executeTakeFirst();
        if ((provisionUpdate.numUpdatedRows ?? 0n) === 0n) {
          let current = await readInteractiveSession(env, id);
          const currentAdapterProvision = Boolean(
            current &&
            current.adapter === runtimeAdapterName &&
            current.adapterWorkspaceId === provisioned.adapterWorkspaceId &&
            ["provisioning", "pending_adapter", "ready", "attached", "detached"].includes(
              current.status,
            ),
          );
          if (
            !currentAdapterProvision &&
            provisioned.adapter === runtimeAdapterName &&
            provisioned.adapterWorkspaceId
          ) {
            await stopSupersededRuntimeAdapterProvision(
              env,
              id,
              provisioned.adapterWorkspaceId,
              provisioned.createPending === true,
              Date.now(),
            );
          }
          if (
            provisioned.adapter !== runtimeAdapterName &&
            provisioned.leaseId?.startsWith(sandboxLeasePrefix)
          ) {
            await queueSandboxCredentialPolicyCleanup(
              env,
              id,
              sandboxLeaseInfo({ id, leaseId: provisioned.leaseId }).sandboxId,
            );
            await reconcileCredentialPolicyCleanupBatch(env, Date.now(), id);
            current = await readInteractiveSession(env, id);
          }
          if (!current) throw new Error("interactive session disappeared during provisioning");
          return { session: decorateInteractiveSession(current, user, env) };
        }
        await appendInteractiveSessionEvent(env, id, user, provisioned.message, now + 1);
        if (initialTerminalStatus) {
          await finalizeTerminalInteractiveSession(
            env,
            id,
            initialTerminalStatus,
            terminalAt,
          ).catch(() => undefined);
        }
      } else {
        await db
          .updateTable("interactive_sessions")
          .set({
            status: "pending_adapter",
            last_event: "waiting for interactive runtime adapter",
            updated_at: sql<number>`MAX(updated_at + 1, ${now + 1})`,
          })
          .where("id", "=", id)
          .where("status", "=", "provisioning")
          .where(sql<boolean>`lease_id IS ${initialSandboxOwnership?.leaseId ?? null}`)
          .where("agent_token_hash", "=", initialAgentTokenHash)
          .execute();
        await appendInteractiveSessionEvent(
          env,
          id,
          user,
          "waiting for interactive runtime adapter",
          now + 1,
        );
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
      if (
        !reservationInserted &&
        isConstraintError(error) &&
        options.openClawRequestId &&
        options.openClawRequestHash
      ) {
        const existing = await readOpenClawRequestSession(
          env,
          options.openClawRequestId,
          options.openClawRequestHash,
        );
        if (existing) return { session: decorateInteractiveSession(existing, user, env) };
      }
      if (reservationInserted || !isConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("failed to allocate interactive session id");
}

function initialRuntimeAdapterWorkspaceId(
  env: RuntimeEnv,
  runtime: "crabbox" | "container",
  sessionId: string,
): string | null {
  if (!runtimeAdapterConfigurationPresent(env) || (runtime === "container" && env.SANDBOX)) {
    return null;
  }
  const namespace = normalizeAdapterNamespace(env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "");
  if (!namespace) {
    throw serviceUnavailable(
      "runtime adapter namespace is required and must be a DNS-safe label of at most 32 characters",
    );
  }
  const adapterWorkspaceId = namespacedAdapterWorkspaceId(namespace, sessionId);
  if (!adapterWorkspaceId) throw serviceUnavailable("runtime adapter workspace id is invalid");
  return adapterWorkspaceId;
}

function requireRuntimeAdapterCreatePreflight(
  env: RuntimeEnv,
  runtime: "crabbox" | "container",
  profile: string,
): void {
  if (!runtimeAdapterConfigurationPresent(env) || (runtime === "container" && env.SANDBOX)) return;
  if (!configuredRuntimeAdapterControlPlane(env, profile)) {
    throw serviceUnavailable(
      "runtime adapter URL or profile route template must be valid and unambiguous",
    );
  }
  if (!runtimeAdapterToken(env)) {
    throw serviceUnavailable("runtime adapter token is not configured");
  }
}

function runtimeAdapterConfigurationPresent(env: RuntimeEnv): boolean {
  return Boolean(env.CRABBOX_RUNTIME_ADAPTER_URL || env.CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE);
}

function configuredRuntimeAdapterControlPlane(env: RuntimeEnv, profile: string): string | null {
  return runtimeAdapterControlPlaneForProfile(
    env.CRABBOX_RUNTIME_ADAPTER_URL,
    env.CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE,
    profile,
  );
}

function requireRegisteredRuntimeAdapterControlPlane(
  env: RuntimeEnv,
  profile: string,
  registeredControlPlane: string | null | undefined,
): string {
  if (!registeredControlPlane) {
    throw new Error("runtime adapter control-plane registration is missing");
  }
  const configuredControlPlane = configuredRuntimeAdapterControlPlane(env, profile);
  if (!configuredControlPlane) {
    throw new Error("runtime adapter control plane is unavailable");
  }
  if (configuredControlPlane !== registeredControlPlane) {
    throw new Error("runtime adapter control plane differs from workspace registration");
  }
  if (!runtimeAdapterToken(env)) throw new Error("runtime adapter token is not configured");
  return registeredControlPlane;
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
    const release = await stopRuntimeAdapterWorkspaceForSession(env, sessionId, adapterWorkspaceId);
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

async function resolveInteractiveSessionLineage(
  env: RuntimeEnv,
  user: User,
  parentSessionId: string | null,
  rootSessionId: string | null,
): Promise<{ parentSessionId: string | null; rootSessionId: string | null }> {
  const parentId = clean(parentSessionId, 120) || null;
  const rootId = clean(rootSessionId, 120) || null;
  if (!parentId) {
    if (rootId) throw badRequest("root session id requires a parent session id");
    return { parentSessionId: null, rootSessionId: null };
  }

  const parent = await readInteractiveSession(env, parentId);
  if (!parent) throw badRequest("parent session not found");
  if (!canManageInteractiveSession(user, parent)) throw forbidden("parent session is not visible");
  return {
    parentSessionId: parent.id,
    rootSessionId: parent.rootSessionId || parent.id,
  };
}

function interactiveSessionPurpose(
  value: unknown,
  prompt: string,
  repo: string,
  branch: string,
  command: string,
): string {
  const explicit = clean(value, 500);
  if (explicit) return explicit;
  if (prompt) return clean(prompt, 500);
  return clean(`${command} in ${repo}@${branch}`, 500);
}

function interactiveSessionSummary(value: unknown, purpose: string, prompt: string): string {
  const explicit = clean(value, 500);
  if (explicit) return explicit;
  return clean(purpose || prompt || "interactive Codex session", 500);
}

function newAgentToken(): string {
  return `${crypto.randomUUID()}${crypto.randomUUID()}`;
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
  const db = database(env);
  let query = db
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("status", "in", deadInteractiveSessionStatuses)
    .where("terminal_finalize_pending", "=", 0).where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS policy
        WHERE policy.session_id = interactive_sessions.id
      )
    `).where(sql<boolean>`
      COALESCE(
        (
          SELECT event_count
          FROM interactive_session_log_archives AS archive
          WHERE archive.session_id = interactive_sessions.id
        ),
        -1
      ) >= (
        SELECT count(*)
        FROM interactive_session_events AS event
        WHERE event.session_id = interactive_sessions.id
      )
    `).where(sql<boolean>`
      EXISTS (
        SELECT 1
        FROM interactive_session_log_archives AS archive
        WHERE archive.session_id = interactive_sessions.id
          AND archive.session_updated_at = interactive_sessions.updated_at
      )
    `).where(sql<boolean>`
      NOT EXISTS (
        WITH RECURSIVE active_ancestor(id) AS (
          SELECT parent_session_id
          FROM interactive_sessions
          WHERE status NOT IN ('stopped', 'expired', 'failed')
            AND parent_session_id IS NOT NULL
          UNION
          SELECT session.parent_session_id
          FROM interactive_sessions AS session
          JOIN active_ancestor ON session.id = active_ancestor.id
          WHERE session.parent_session_id IS NOT NULL
        )
        SELECT 1
        FROM active_ancestor
        WHERE id = interactive_sessions.id
      )
    `).where(sql<boolean>`
      ${env.SESSION_LOGS ? 1 : 0} = 0
      OR EXISTS (
        SELECT 1
        FROM interactive_session_log_archives AS archive
        WHERE archive.session_id = interactive_sessions.id
          AND archive.events_key IS NOT NULL
          AND archive.transcript_key IS NOT NULL
          AND archive.summary_key IS NOT NULL
      )
    `);
  if (ids.length) query = query.where("id", "in", ids);
  const candidates = (await query.execute()).filter((row) =>
    canManageInteractiveSession(user, interactiveSession(row, [])),
  );
  const removedIds = (
    await Promise.all(
      candidates.map(async (row) => {
        const archive = await db
          .selectFrom("interactive_session_log_archives")
          .selectAll()
          .where("session_id", "=", row.id)
          .executeTakeFirst();
        const removed = await deleteFinalizedInteractiveSession(env, row, archive);
        if (!removed) return null;
        await cleanupSessionLogArchiveObjects(env, archive).catch((error) => {
          console.error(`session archive object cleanup leaked for ${row.id}`, error);
        });
        return row.id;
      }),
    )
  ).filter((id): id is string => Boolean(id));
  if (removedIds.length) {
    await audit(env, user, `interactive sessions cleaned ${removedIds.join(",")}`, Date.now());
  }
  return { state: await readState(request, env, user), removedIds };
}

async function deleteFinalizedInteractiveSession(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  archive: Selectable<InteractiveSessionLogArchiveTable> | undefined,
): Promise<boolean> {
  const db = database(env);
  const claimToken = `cleanup:${crypto.randomUUID()}`;
  const finalClaim = db
    .updateTable("interactive_sessions")
    .set({
      terminal_finalize_pending: terminalCleanupDeletePending,
      reconcile_error: claimToken,
    })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("updated_at", "=", row.updated_at)
    .where("terminal_finalize_pending", "=", 0).where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies
        WHERE session_id = ${row.id}
      )
    `).where(sql<boolean>`
      NOT EXISTS (
        WITH RECURSIVE active_ancestor(id) AS (
          SELECT parent_session_id
          FROM interactive_sessions
          WHERE status NOT IN ('stopped', 'expired', 'failed')
            AND parent_session_id IS NOT NULL
          UNION
          SELECT session.parent_session_id
          FROM interactive_sessions AS session
          JOIN active_ancestor ON session.id = active_ancestor.id
          WHERE session.parent_session_id IS NOT NULL
        )
        SELECT 1
        FROM active_ancestor
        WHERE id = ${row.id}
      )
    `).where(sql<boolean>`
      ${archive ? 1 : 0} = 1
        AND EXISTS (
          SELECT 1
          FROM interactive_session_log_archives
          WHERE session_id = ${row.id}
            AND event_count = ${archive?.event_count ?? -1}
            AND session_updated_at IS ${archive?.session_updated_at ?? null}
            AND session_updated_at = ${row.updated_at}
            AND events_key IS ${archive?.events_key ?? null}
            AND transcript_key IS ${archive?.transcript_key ?? null}
            AND summary_key IS ${archive?.summary_key ?? null}
            AND archived_at = ${archive?.archived_at ?? -1}
            AND updated_at = ${archive?.updated_at ?? -1}
        )
    `).where(sql<boolean>`
      COALESCE(
        (
          SELECT event_count
          FROM interactive_session_log_archives
          WHERE session_id = ${row.id}
        ),
        -1
      ) >= (
        SELECT count(*)
        FROM interactive_session_events
        WHERE session_id = ${row.id}
      )
    `).where(sql<boolean>`
      ${env.SESSION_LOGS ? 1 : 0} = 0
      OR EXISTS (
        SELECT 1
        FROM interactive_session_log_archives
        WHERE session_id = ${row.id}
          AND events_key IS NOT NULL
          AND transcript_key IS NOT NULL
          AND summary_key IS NOT NULL
      )
    `);
  const ownsFinalClaim = sql<boolean>`EXISTS (
    SELECT 1
    FROM interactive_sessions
    WHERE id = ${row.id}
      AND status = ${row.status}
      AND updated_at = ${row.updated_at}
      AND terminal_finalize_pending = ${terminalCleanupDeletePending}
      AND reconcile_error = ${claimToken}
  )`;
  // D1 batches are transactional, so no event can interleave between the claim and row deletes.
  await executeBatch(env, [
    finalClaim,
    db
      .deleteFrom("interactive_session_events")
      .where("session_id", "=", row.id)
      .where(ownsFinalClaim),
    db
      .deleteFrom("interactive_session_log_archives")
      .where("session_id", "=", row.id)
      .where(ownsFinalClaim),
    db
      .deleteFrom("interactive_sessions")
      .where("id", "=", row.id)
      .where("status", "=", row.status)
      .where("updated_at", "=", row.updated_at)
      .where("terminal_finalize_pending", "=", terminalCleanupDeletePending)
      .where("reconcile_error", "=", claimToken),
  ]);
  const current = await db
    .selectFrom("interactive_sessions")
    .select("id")
    .where("id", "=", row.id)
    .executeTakeFirst();
  return !current;
}

async function mutateInteractiveSessionMetadataAtomically(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "id" | "status" | "updatedAt">,
  user: User,
  message: string,
  values: UpdateObject<Database, "interactive_sessions">,
  now = Date.now(),
): Promise<void> {
  const db = database(env);
  const eventMessage = clean(message, 1000);
  const revision = Math.max(now, session.updatedAt + 1);
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND status = ${session.status}
    AND updated_at = ${session.updatedAt}
  `;
  const eventQuery = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, ${actor(user)}, ${eventMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const updateQuery = db
    .updateTable("interactive_sessions")
    .set({
      ...values,
      terminal_finalize_pending: sql<number>`CASE
        WHEN status IN ('stopped', 'expired', 'failed') THEN 1
        ELSE terminal_finalize_pending
      END`,
      updated_at: revision,
      last_event: eventMessage,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [eventQuery, updateQuery].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  if (!results.at(-1)?.results.some((row) => row.updated_at === revision)) {
    throw conflict("interactive session lifecycle changed; retry metadata update");
  }
  await archiveInteractiveSessionLogs(env, session.id, now).catch(() => undefined);
}

type LegacyInteractiveSessionStopOwner = {
  id: string;
  status: InteractiveSessionStatus;
  runtime: InteractiveRuntime;
  adapter: string | null;
  leaseId: string | null;
  updatedAt: number;
};

async function completeLegacyInteractiveSessionStop(
  env: RuntimeEnv,
  owner: LegacyInteractiveSessionStopOwner,
  eventActor: string,
  now: number,
): Promise<boolean> {
  if (owner.runtime === githubActionsRuntime) return false;
  const db = database(env);
  const revision = Math.max(now, owner.updatedAt + 1);
  const actorName = clean(eventActor, 120) || "system";
  const expectedOwner = sql<boolean>`
    id = ${owner.id}
    AND status = ${owner.status}
    AND runtime = ${owner.runtime}
    AND updated_at = ${owner.updatedAt}
    AND adapter IS ${owner.adapter}
    AND lease_id IS ${owner.leaseId}
    AND (adapter IS NULL OR adapter != ${runtimeAdapterName})
    AND (lease_id IS NULL OR lease_id NOT LIKE ${`${sandboxLeasePrefix}%`})
    AND credential_cleanup_terminal_status IS NULL
  `;
  const requestedMessage = "interactive workspace stop requested";
  const finalMessage = "interactive workspace stopped";
  const requestedEvent = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${owner.id}, ${actorName}, ${requestedMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const stoppedEvent = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${owner.id}, ${actorName}, ${finalMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const stop = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopped",
      stopped_at: sql<number>`COALESCE(stopped_at, ${now})`,
      reconcile_error: null,
      terminal_status: null,
      adapter_create_pending: 0,
      terminal_finalize_pending: 1,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: revision,
      last_event: finalMessage,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [requestedEvent, stoppedEvent, stop].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  const stopped = results.at(-1)?.results.some((row) => row.updated_at === revision) ?? false;
  if (stopped) {
    await archiveInteractiveSessionLogs(env, owner.id, now).catch(() => undefined);
    await finalizeTerminalInteractiveSession(env, owner.id, "stopped", now).catch(() => undefined);
  }
  return stopped;
}

async function stopGitHubActionsSession(
  env: RuntimeEnv,
  session: InteractiveSession,
  eventActor: string,
  now: number,
): Promise<boolean> {
  const revision = Math.max(now, session.updatedAt + 1);
  const message = "GitHub Actions terminal session ended from Crabfleet; workflow run not canceled";
  const db = database(env);
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND runtime = ${githubActionsRuntime}
    AND status = ${session.status}
    AND updated_at = ${session.updatedAt}
  `;
  const event = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, ${clean(eventActor, 120) || "system"}, ${message}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const update = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopped",
      stopped_at: now,
      reconcile_error: null,
      terminal_status: null,
      terminal_failure_reason: null,
      terminal_finalize_pending: 1,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      work_state: "",
      work_phase: "session_ended",
      completion_reason: "Crabfleet terminal session ended; workflow run not canceled",
      last_event: message,
      updated_at: revision,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [event, update].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  const stopped = results.at(-1)?.results.some((row) => row.updated_at === revision) ?? false;
  if (!stopped) return false;
  await disconnectGitHubActionsRunner(env, session.id).catch(() => undefined);
  await archiveInteractiveSessionLogs(env, session.id, now).catch(() => undefined);
  await finalizeTerminalInteractiveSession(env, session.id, "stopped", now).catch(() => undefined);
  return true;
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
  const canManage = canManageInteractiveSession(user, session);
  if (action === "attach") {
    if (!session.capabilities.terminal) {
      throw badRequest("session does not advertise terminal access");
    }
    if (!canControlInteractiveSession(user, session, now, canGrantDelegatedControl(env, session))) {
      throw forbidden("terminal control has not been granted");
    }
    if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    const nextStatus =
      session.status === "ready" || session.status === "detached" ? "attached" : session.status;
    const message =
      session.status === "pending_adapter"
        ? "attach requested; runtime adapter pending"
        : session.status === "provisioning"
          ? "attach requested; workspace provisioning"
          : "interactive terminal attached";
    const attached = await database(env)
      .updateTable("interactive_sessions")
      .set({
        status: nextStatus,
        last_seen_at: now,
        updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
        last_event: message,
      })
      .where("id", "=", id)
      .where("status", "=", session.status)
      .where("updated_at", "=", session.updatedAt)
      .executeTakeFirst();
    if ((attached.numUpdatedRows ?? 0n) === 0n) {
      throw conflict("interactive session lifecycle changed; retry attach");
    }
    await appendInteractiveSessionEvent(env, id, user, message, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
    };
  }

  if (action === "share_link") {
    if (!canManage) throw forbidden("only the session owner or maintainer can share");
    const token = shareToken();
    const tokenHash = await sha256(token);
    const preview = token.slice(0, 8);
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      "read-only share link enabled",
      {
        share_mode: "link_read",
        share_token_hash: tokenHash,
        share_token_preview: preview,
      },
      now,
    );
    await audit(env, user, `interactive session share enabled ${id}`, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
      shareUrl: shareUrl(request, env, id, token),
    };
  }

  if (action === "disable_share") {
    if (!canManage) throw forbidden("only the session owner or maintainer can disable sharing");
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      "session sharing disabled",
      {
        share_mode: "private",
        share_token_hash: null,
        share_token_preview: null,
        control_requested_by: null,
        control_requested_at: null,
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
      },
      now,
    );
    await audit(env, user, `interactive session share disabled ${id}`, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
    };
  }

  if (action === "enable_multiplayer" || action === "disable_multiplayer") {
    if (!canChangeInteractiveSessionMultiplayer(user, session)) {
      throw forbidden("only the session creator can change multiplayer");
    }
    const enabled = action === "enable_multiplayer";
    const message = enabled ? "multiplayer mode enabled" : "multiplayer mode disabled";
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      message,
      { multiplayer_mode: enabled ? 1 : 0 },
      now,
    );
    await audit(
      env,
      user,
      `interactive session multiplayer ${enabled ? "enabled" : "disabled"} ${id}`,
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

  if (action === "request_control") {
    if (!canGrantDelegatedControl(env, session)) {
      throw badRequest("delegated terminal control requires a revocable PTY bridge");
    }
    if (canControlInteractiveSession(user, session, now, canGrantDelegatedControl(env, session))) {
      return { session: decorateInteractiveSession(session, user, env) };
    }
    if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    const message = `${userActor} requested terminal control`;
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      message,
      {
        control_requested_by: userActor,
        control_requested_at: now,
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

  if (action === "approve_control") {
    if (!canManage) throw forbidden("only the session owner or maintainer can approve control");
    if (!session.controlRequestedBy) throw badRequest("no pending control request");
    if (!canGrantDelegatedControl(env, session)) {
      throw badRequest("delegated terminal control requires a revocable PTY bridge");
    }
    const expires = now + 30 * 60 * 1000;
    const message = `control granted to ${session.controlRequestedBy}`;
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      message,
      {
        controller: session.controlRequestedBy,
        control_granted_at: now,
        control_expires_at: expires,
        control_requested_by: null,
        control_requested_at: null,
      },
      now,
    );
    await audit(
      env,
      user,
      `interactive session control granted ${id} to ${session.controlRequestedBy}`,
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

  if (action === "deny_control") {
    if (!canManage) throw forbidden("only the session owner or maintainer can deny control");
    const requester = session.controlRequestedBy;
    const message = requester
      ? `control request denied for ${requester}`
      : "control request denied";
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      message,
      {
        control_requested_by: null,
        control_requested_at: null,
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

  if (action === "revoke_control") {
    if (!canManage) throw forbidden("only the session owner or maintainer can revoke control");
    await mutateInteractiveSessionMetadataAtomically(
      env,
      session,
      user,
      "terminal control revoked",
      {
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
      },
      now,
    );
    await audit(env, user, `interactive session control revoked ${id}`, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
    };
  }

  if (action === "stop") {
    if (!canManage) throw forbidden("only the session owner or maintainer can stop");
    if (["stopped", "expired", "failed"].includes(session.status)) {
      if (isSandboxInteractiveSession(session)) {
        const staged = await stageTerminalCredentialPolicyCleanupById(
          env,
          session.id,
          session.status as "stopped" | "expired" | "failed",
          "sandbox credential cleanup pending",
          now,
        );
        if (!staged) throw conflict("interactive session lifecycle changed; retry stop");
        await reconcileCredentialPolicyCleanupBatch(env, now, session.id);
        const current = await readInteractiveSession(env, session.id);
        if (current) return { session: decorateInteractiveSession(current, user, env) };
      }
      await finalizeTerminalInteractiveSession(
        env,
        session.id,
        session.status as "stopped" | "expired" | "failed",
        session.stoppedAt ?? now,
      ).catch(() => undefined);
      return { session: decorateInteractiveSession(session, user, env) };
    }
    if (session.runtime === githubActionsRuntime) {
      if (!(await stopGitHubActionsSession(env, session, userActor, now))) {
        const current = await readInteractiveSession(env, id);
        if (!current) throw notFound("interactive session not found");
        if (!deadInteractiveSessionStatuses.includes(current.status)) {
          throw conflict("interactive session lifecycle changed; retry stop");
        }
        return { session: decorateInteractiveSession(current, user, env) };
      }
      await audit(env, user, `GitHub Actions session stopped ${id}`, now);
      return {
        session: decorateInteractiveSession(
          (await readInteractiveSession(env, id)) as InteractiveSession,
          user,
          env,
        ),
      };
    }
    if (session.adapter === runtimeAdapterName) {
      if (!session.adapterWorkspaceId) {
        throw serviceUnavailable("runtime adapter workspace reference is incomplete");
      }
      const stopClaimRevision = Math.max(now, session.updatedAt + 1);
      const stopClaim = await database(env)
        .updateTable("interactive_sessions")
        .set({
          status: "stopping",
          lease_id: null,
          updated_at: stopClaimRevision,
          last_event: "runtime adapter stop requested",
          reconcile_error: null,
          agent_token_hash: null,
          attach_url: null,
          vnc_url: null,
          controller: null,
          control_requested_by: null,
          control_requested_at: null,
          control_granted_at: null,
          control_expires_at: null,
        })
        .where("id", "=", id)
        .where("status", "=", session.status)
        .where("updated_at", "=", session.updatedAt)
        .executeTakeFirst();
      if ((stopClaim.numUpdatedRows ?? 0n) === 0n) {
        const current = await readInteractiveSession(env, id);
        if (
          !current ||
          current.adapter !== runtimeAdapterName ||
          current.adapterWorkspaceId !== session.adapterWorkspaceId ||
          !["stopping", "stopped", "expired", "failed"].includes(current.status)
        ) {
          throw conflict("interactive session lifecycle changed; retry stop");
        }
        return {
          session: decorateInteractiveSession(current, user, env),
        };
      }
      await appendInteractiveSessionEvent(env, id, user, "runtime adapter stop requested", now);
      let adapterStop: RuntimeAdapterStopResult;
      try {
        adapterStop = await stopRuntimeAdapterWorkspaceForSession(
          env,
          session.id,
          session.adapterWorkspaceId,
        );
      } catch (error) {
        const message = safeProviderError(error, [session.adapterWorkspaceId]);
        const pendingMessage = `runtime adapter stop pending: ${message}`;
        await persistRuntimeAdapterStopEvidence(
          env,
          id,
          session.adapterWorkspaceId,
          pendingMessage,
          now,
          message,
          actor(user),
        );
        throw serviceUnavailable(`runtime adapter stop failed: ${message}`);
      }
      if (adapterStop.status === "stopping") {
        const lifecycle = await database(env)
          .selectFrom("interactive_sessions")
          .select("adapter_create_pending")
          .where("id", "=", id)
          .where("adapter", "=", runtimeAdapterName)
          .where("adapter_workspace_id", "=", session.adapterWorkspaceId)
          .where("status", "=", "stopping")
          .executeTakeFirst();
        const message = lifecycle?.adapter_create_pending
          ? `${adapterStop.message}; runtime adapter stop waiting for create resolution`
          : adapterStop.message;
        await persistRuntimeAdapterStopEvidence(
          env,
          id,
          session.adapterWorkspaceId,
          message,
          now,
          null,
          actor(user),
        );
        return {
          session: decorateInteractiveSession(
            (await readInteractiveSession(env, id)) as InteractiveSession,
            user,
            env,
          ),
        };
      }
      const resolved = await recordConfirmedRuntimeAdapterRelease(
        env,
        id,
        session.adapterWorkspaceId,
        Date.now(),
        adapterStop.message,
      );
      if (resolved === "failed" || resolved === "stopped") {
        await audit(env, user, `interactive session stopped ${id}`, Date.now());
      }
      return {
        session: decorateInteractiveSession(
          (await readInteractiveSession(env, id)) as InteractiveSession,
          user,
          env,
        ),
      };
    }
    if (isSandboxInteractiveSession(session)) {
      const message = "interactive workspace stop waiting for credential cleanup";
      const staged = await stageTerminalCredentialPolicyCleanupById(
        env,
        session.id,
        "stopped",
        message,
        now,
      );
      if (!staged) {
        const current = await readInteractiveSession(env, id);
        if (!current) throw notFound("interactive session not found");
        const terminalIntent = await database(env)
          .selectFrom("interactive_sessions")
          .select("credential_cleanup_terminal_status")
          .where("id", "=", id)
          .where("status", "=", "stopping")
          .executeTakeFirst();
        if (terminalIntent?.credential_cleanup_terminal_status) {
          return { session: decorateInteractiveSession(current, user, env) };
        }
        if (["stopped", "expired", "failed"].includes(current.status)) {
          return { session: decorateInteractiveSession(current, user, env) };
        }
        throw conflict("interactive session lifecycle changed; retry stop");
      }
      await appendInteractiveSessionEvent(
        env,
        id,
        user,
        "interactive workspace stop requested",
        now,
      );
      await reconcileCredentialPolicyCleanupBatch(env, now, id);
      return {
        session: decorateInteractiveSession(
          (await readInteractiveSession(env, id)) as InteractiveSession,
          user,
          env,
        ),
      };
    }
    if (!(await completeLegacyInteractiveSessionStop(env, session, actor(user), now))) {
      const current = await readInteractiveSession(env, id);
      if (!current) throw notFound("interactive session not found");
      if (!["stopped", "expired", "failed"].includes(current.status)) {
        throw conflict("interactive session lifecycle changed; retry stop");
      }
      return { session: decorateInteractiveSession(current, user, env) };
    }
    await audit(env, user, `interactive session stopped ${id}`, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
    };
  }

  throw badRequest("unknown action");
}

async function unregisterSandboxCredentialPolicyLookup(
  env: RuntimeEnv,
  lookupId: string,
  generation: string,
  sessionId: string,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("sandbox credential policy cleanup is unavailable");
  let response: Response;
  try {
    response = await stub.fetch(
      `https://crabfleet.internal/api/session-control/sandbox/${encodeURIComponent(lookupId)}`,
      {
        method: "DELETE",
        body: JSON.stringify({ generation, sessionId, tombstonedAt: Date.now() }),
        headers: { "content-type": "application/json" },
      },
    );
  } catch {
    throw serviceUnavailable("sandbox credential policy cleanup failed");
  }
  if (!response.ok) {
    throw serviceUnavailable("sandbox credential policy cleanup failed");
  }
}

function sandboxCredentialPolicyRefQueries(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  state: "registering" | "active" | "cleanup_pending",
  generation: string,
  now: number,
  authorizationCondition: RawBuilder<boolean>,
): CompilableQuery[] {
  return sandboxLookupIds(env, sandboxId).map(
    (lookupId) => sql`
    INSERT INTO interactive_session_credential_policies (
      session_id,
      sandbox_id,
      lookup_id,
      state,
      registration_generation,
      registration_claim,
      registration_claim_expires_at,
      attempt_count,
      last_attempt_at,
      last_error,
      cleanup_claim,
      cleanup_claim_expires_at,
      created_at,
      updated_at
    ) SELECT
      ${sessionId},
      ${sandboxId},
      ${lookupId},
      ${state},
      ${generation},
      NULL,
      NULL,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      ${now},
      ${now}
    WHERE ${authorizationCondition}
    ON CONFLICT(session_id, sandbox_id, lookup_id) DO UPDATE SET
      state = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR excluded.state = 'cleanup_pending'
        THEN 'cleanup_pending'
        WHEN interactive_session_credential_policies.registration_claim IS NOT NULL
        THEN interactive_session_credential_policies.state
        ELSE excluded.state
      END,
      last_error = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.last_error
        ELSE NULL
      END,
      cleanup_claim = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.cleanup_claim
        ELSE NULL
      END,
      cleanup_claim_expires_at = CASE
        WHEN interactive_session_credential_policies.state = 'cleanup_pending'
          OR interactive_session_credential_policies.registration_claim IS NOT NULL
          OR excluded.state = 'cleanup_pending'
        THEN interactive_session_credential_policies.cleanup_claim_expires_at
        ELSE NULL
      END,
      updated_at = excluded.updated_at
  `,
  );
}

function sandboxCredentialPolicyCleanupAuthorizedCondition(
  sessionId: string,
  sandboxId: string,
  now: number,
): RawBuilder<boolean> {
  const leasePrefix = `${sandboxLeasePrefix}${sandboxId}`;
  return sql<boolean>`
    NOT EXISTS (
      SELECT 1
      FROM standalone_sandbox_provisions AS owner
      WHERE owner.id = ${sessionId}
        AND owner.sandbox_id = ${sandboxId}
        AND (
          owner.state = 'active'
          OR (
            owner.state = 'provisioning'
            AND owner.ownership_claim IS NOT NULL
            AND owner.ownership_claim_expires_at > ${now}
          )
        )
    )
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_sessions AS session
      WHERE session.id = ${sessionId}
        AND (session.adapter IS NULL OR session.adapter != ${runtimeAdapterName})
        AND session.status IN ('provisioning', 'pending_adapter', 'ready', 'attached', 'detached')
        AND session.credential_cleanup_terminal_status IS NULL
        AND session.agent_token_hash IS NOT NULL
        AND (
          (
            session.lease_id IS NOT NULL
            AND substr(session.lease_id, 1, ${leasePrefix.length}) = ${leasePrefix}
            AND (
              length(session.lease_id) = ${leasePrefix.length}
              OR substr(session.lease_id, ${leasePrefix.length + 1}, 1) = ':'
            )
          )
          OR (
            session.sandbox_refresh_sandbox_id = ${sandboxId}
            AND session.sandbox_refresh_claim IS NOT NULL
            AND session.sandbox_refresh_claim_expires_at > ${now}
          )
        )
    )
  `;
}

async function sandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string> {
  return (
    (await existingSandboxCredentialPolicyGeneration(env, sessionId, sandboxId)) ??
    `generation:${crypto.randomUUID()}`
  );
}

async function existingSandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string | null> {
  const existing = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select("registration_generation")
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .orderBy("lookup_id", "asc")
    .executeTakeFirst();
  return existing?.registration_generation ?? null;
}

function activeSandboxCredentialPolicyCondition(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  generation: string,
  updatedAt?: number,
): RawBuilder<boolean> {
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const updatedAtCondition =
    updatedAt === undefined ? sql<boolean>`1 = 1` : sql<boolean>`updated_at = ${updatedAt}`;
  return sql<boolean>`
    (
      SELECT count(DISTINCT lookup_id)
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND lookup_id IN (${sql.join(lookupIds)})
        AND state = 'active'
        AND registration_generation = ${generation}
        AND registration_claim IS NULL
        AND ${updatedAtCondition}
    ) = ${lookupIds.length}
    AND NOT EXISTS (
      SELECT 1
      FROM interactive_session_credential_policies
      WHERE session_id = ${sessionId}
        AND sandbox_id = ${sandboxId}
        AND (
          state != 'active'
          OR registration_generation != ${generation}
          OR registration_claim IS NOT NULL
          OR NOT (${updatedAtCondition})
        )
    )
  `;
}

async function activeSandboxCredentialPolicyGeneration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<string | null> {
  const rows = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  const expected = sandboxLookupIds(env, sandboxId);
  const generation = rows[0]?.registration_generation;
  if (
    !generation ||
    !expected.every((lookupId) =>
      rows.some(
        (row) =>
          row.lookup_id === lookupId &&
          row.state === "active" &&
          row.registration_generation === generation &&
          row.registration_claim === null,
      ),
    ) ||
    rows.some(
      (row) =>
        row.state !== "active" ||
        row.registration_generation !== generation ||
        row.registration_claim !== null,
    )
  ) {
    return null;
  }
  return generation;
}

async function queueSandboxCredentialPolicyCleanup(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  now = Date.now(),
): Promise<void> {
  const generation = await sandboxCredentialPolicyGeneration(env, sessionId, sandboxId);
  await executeBatch(
    env,
    sandboxCredentialPolicyRefQueries(
      env,
      sessionId,
      sandboxId,
      "cleanup_pending",
      generation,
      now,
      sandboxCredentialPolicyCleanupAuthorizedCondition(sessionId, sandboxId, now),
    ),
  );
}

function sandboxTerminalCleanupOwnership(
  session: Pick<
    InteractiveSessionRow,
    | "id"
    | "lease_id"
    | "sandbox_refresh_sandbox_id"
    | "sandbox_refresh_claim"
    | "sandbox_refresh_claim_expires_at"
  >,
): SandboxTerminalCleanupOwnership | null {
  if (!session.lease_id?.startsWith(sandboxLeasePrefix)) return null;
  const terminalLeaseId = sandboxLeaseWithoutRefresh(session.lease_id);
  let currentSandboxId: string;
  try {
    currentSandboxId = sandboxLeaseInfo({ id: session.id, leaseId: terminalLeaseId }).sandboxId;
  } catch {
    return null;
  }
  const refreshValues = [
    session.sandbox_refresh_sandbox_id,
    session.sandbox_refresh_claim,
    session.sandbox_refresh_claim_expires_at,
  ];
  const refreshPresent = refreshValues.some((value) => value !== null);
  if (refreshPresent && refreshValues.some((value) => value === null)) return null;
  if (
    session.sandbox_refresh_sandbox_id &&
    session.sandbox_refresh_claim &&
    session.sandbox_refresh_claim_expires_at !== null
  ) {
    return {
      fence: {
        claim: session.sandbox_refresh_claim,
        expiresAt: session.sandbox_refresh_claim_expires_at,
        refreshLeaseId: session.lease_id,
        sandboxId: session.sandbox_refresh_sandbox_id,
      },
      sandboxIds: [...new Set([currentSandboxId, session.sandbox_refresh_sandbox_id])],
      terminalLeaseId,
    };
  }
  return {
    fence: { leaseId: session.lease_id, sandboxId: currentSandboxId },
    sandboxIds: [currentSandboxId],
    terminalLeaseId,
  };
}

function sandboxManagedOwnershipFencesMatch(
  left: SandboxManagedOwnershipFence,
  right: SandboxManagedOwnershipFence,
): boolean {
  if ("leaseId" in left || "leaseId" in right) {
    return (
      "leaseId" in left &&
      "leaseId" in right &&
      left.leaseId === right.leaseId &&
      left.sandboxId === right.sandboxId
    );
  }
  return (
    left.claim === right.claim &&
    left.expiresAt === right.expiresAt &&
    left.refreshLeaseId === right.refreshLeaseId &&
    left.sandboxId === right.sandboxId
  );
}

function terminalCleanupIntentRank(status: "stopped" | "expired" | "failed"): number {
  return status === "failed" ? 3 : status === "expired" ? 2 : 1;
}

async function stageTerminalCredentialPolicyCleanup(
  env: RuntimeEnv,
  session: InteractiveSessionRow,
  terminalStatus: "stopped" | "expired" | "failed",
  message: string,
  now: number,
  failureReason?: string,
  requiredFence?: SandboxManagedOwnershipFence,
): Promise<boolean> {
  const ownership = sandboxTerminalCleanupOwnership(session);
  if (
    !ownership ||
    (requiredFence && !sandboxManagedOwnershipFencesMatch(ownership.fence, requiredFence))
  ) {
    return false;
  }
  const db = database(env);
  const stageRevision = Math.max(now, session.updated_at + 1);
  const generations = await Promise.all(
    ownership.sandboxIds.map(async (sandboxId) => ({
      generation: await sandboxCredentialPolicyGeneration(env, session.id, sandboxId),
      sandboxId,
    })),
  );
  const cleanupIntent = sql<"stopped" | "expired" | "failed">`CASE
    WHEN credential_cleanup_terminal_status = 'failed' OR ${terminalStatus} = 'failed'
      THEN 'failed'
    WHEN credential_cleanup_terminal_status = 'expired' OR ${terminalStatus} = 'expired'
      THEN 'expired'
    ELSE 'stopped'
  END`;
  const failureFallback =
    failureReason ??
    (terminalStatus === "failed"
      ? message
      : "interactive workspace failed during credential cleanup");
  const failureEvidence = sql<string | null>`CASE
    WHEN credential_cleanup_terminal_status = 'failed' THEN COALESCE(
      NULLIF(terminal_failure_reason, ''),
      NULLIF(reconcile_error, ''),
      NULLIF(last_event, ''),
      ${failureFallback}
    )
    WHEN ${terminalStatus} = 'failed' THEN COALESCE(
      NULLIF(terminal_failure_reason, ''),
      NULLIF(${failureFallback}, ''),
      NULLIF(reconcile_error, ''),
      NULLIF(last_event, ''),
      'interactive workspace failed during credential cleanup'
    )
    ELSE terminal_failure_reason
  END`;
  const sessionTransition = db
    .updateTable("interactive_sessions")
    .set({
      status: "stopping",
      lease_id: ownership.terminalLeaseId,
      credential_cleanup_terminal_status: cleanupIntent,
      terminal_finalize_pending: 0,
      sandbox_refresh_sandbox_id: null,
      sandbox_refresh_claim: null,
      sandbox_refresh_claim_expires_at: null,
      agent_token_hash: null,
      attach_url: null,
      vnc_url: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      reconcile_error: sql<string>`CASE
        WHEN credential_cleanup_terminal_status = 'failed' OR ${terminalStatus} = 'failed'
          THEN COALESCE(${failureEvidence}, ${message})
        ELSE ${message}
      END`,
      terminal_failure_reason: failureEvidence,
      terminal_status: null,
      adapter_create_pending: 0,
      stopped_at: sql<number>`COALESCE(stopped_at, ${now})`,
      updated_at: stageRevision,
      last_event: message,
    })
    .where("id", "=", session.id)
    .where("updated_at", "=", session.updated_at)
    .where((expression) =>
      expression.or([
        expression("adapter", "is", null),
        expression("adapter", "!=", runtimeAdapterName),
      ]),
    )
    .where(sandboxManagedStoredOwnershipCondition(ownership.fence));
  const policyTransitions = generations.flatMap(({ generation, sandboxId }) => [
    ...sandboxCredentialPolicyRefQueries(
      env,
      session.id,
      sandboxId,
      "cleanup_pending",
      generation,
      stageRevision,
      sandboxCredentialPolicyCleanupAuthorizedCondition(session.id, sandboxId, stageRevision),
    ),
    db
      .updateTable("interactive_session_credential_policies")
      .set({
        state: "cleanup_pending",
        updated_at: stageRevision,
      })
      .where("session_id", "=", session.id)
      .where("sandbox_id", "=", sandboxId)
      .where(
        sandboxCredentialPolicyCleanupAuthorizedCondition(session.id, sandboxId, stageRevision),
      ),
  ]);
  await executeBatch(env, [sessionTransition, ...policyTransitions]);
  const staged = await db
    .selectFrom("interactive_sessions")
    .select([
      "status",
      "credential_cleanup_terminal_status",
      "terminal_failure_reason",
      "updated_at",
    ])
    .where("id", "=", session.id)
    .executeTakeFirst();
  return Boolean(
    staged?.status === "stopping" &&
    staged.updated_at === stageRevision &&
    staged.credential_cleanup_terminal_status &&
    terminalCleanupIntentRank(staged.credential_cleanup_terminal_status) >=
      terminalCleanupIntentRank(terminalStatus) &&
    (staged.credential_cleanup_terminal_status !== "failed" || staged.terminal_failure_reason),
  );
}

async function stageTerminalCredentialPolicyCleanupById(
  env: RuntimeEnv,
  sessionId: string,
  terminalStatus: "stopped" | "expired" | "failed",
  message: string,
  now: number,
  failureReason?: string,
  requiredFence?: SandboxManagedOwnershipFence,
): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const session = await database(env)
      .selectFrom("interactive_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .executeTakeFirst();
    if (!session) return false;
    if (
      session.status === "stopping" &&
      session.credential_cleanup_terminal_status &&
      terminalCleanupIntentRank(session.credential_cleanup_terminal_status) >=
        terminalCleanupIntentRank(terminalStatus) &&
      (session.credential_cleanup_terminal_status !== "failed" || session.terminal_failure_reason)
    ) {
      return true;
    }
    if (
      await stageTerminalCredentialPolicyCleanup(
        env,
        session,
        terminalStatus,
        message,
        now,
        failureReason,
        session.status === "stopping" && session.credential_cleanup_terminal_status
          ? undefined
          : requiredFence,
      )
    ) {
      return true;
    }
  }
  return false;
}

type CredentialPolicyScanRow = {
  scan_rowid: number;
  session_id: string;
  sandbox_id: string;
  lookup_id: string;
  policy_state: "registering" | "active";
  registration_generation: string;
  registration_claim: string | null;
  registration_claim_expires_at: number | null;
  policy_updated_at: number;
  matched_session_id: string | null;
  session_adapter: string | null;
  session_status: InteractiveSessionStatus | null;
  session_lease_id: string | null;
  credential_cleanup_terminal_status: "stopped" | "expired" | "failed" | null;
  session_sandbox_refresh_sandbox_id: string | null;
  session_sandbox_refresh_claim: string | null;
  session_sandbox_refresh_claim_expires_at: number | null;
  session_agent_token_hash: string | null;
  session_updated_at: number | null;
  matched_standalone_id: string | null;
  standalone_state: "provisioning" | "active" | "cleanup_pending" | null;
  standalone_claim: string | null;
  standalone_claim_expires_at: number | null;
  standalone_updated_at: number | null;
};

async function scanCredentialPolicyCleanupPage(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  const db = database(env);
  const state = sessionId
    ? null
    : await db
        .selectFrom("credential_policy_reconcile_state")
        .select(["last_rowid", "scan_max_rowid"])
        .where("id", "=", 1)
        .executeTakeFirst();
  const originalCursor = state?.last_rowid ?? 0;
  const originalMaxRowid = state?.scan_max_rowid ?? 0;
  let cursor = sessionId ? 0 : originalCursor;
  let maxRowid = sessionId
    ? Number.MAX_SAFE_INTEGER
    : originalMaxRowid || (await maximumCredentialPolicyRowid(db));
  let rows = await readCredentialPolicyScanPage(db, cursor, maxRowid, sessionId);
  if (!sessionId && rows.length === 0 && (cursor > 0 || maxRowid > 0)) {
    cursor = 0;
    maxRowid = await maximumCredentialPolicyRowid(db);
    rows = await readCredentialPolicyScanPage(db, cursor, maxRowid);
  }
  const attemptedRepairs = new Set<string>();
  const repairedRegistrations = new Set<string>();
  const deferredRegistrations = new Set<string>();
  for (const row of rows) {
    const registrationKey = `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`;
    if (attemptedRepairs.has(registrationKey)) continue;
    attemptedRepairs.add(registrationKey);
    try {
      if (await repairActiveSandboxCredentialPolicyRegistration(env, row, now)) {
        repairedRegistrations.add(registrationKey);
      }
    } catch (error) {
      deferredRegistrations.add(registrationKey);
      console.error("active sandbox credential policy repair failed", error);
    }
  }
  const candidates = rows.filter(
    (row) =>
      !repairedRegistrations.has(
        `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`,
      ) &&
      !deferredRegistrations.has(
        `${row.session_id}\u0000${row.sandbox_id}\u0000${row.registration_generation}`,
      ) &&
      credentialPolicyScanRequiresCleanup(row, now),
  );
  for (const row of candidates) {
    const transitionRevision = Math.max(
      now,
      row.policy_updated_at + 1,
      (row.session_updated_at ?? 0) + 1,
      (row.standalone_updated_at ?? 0) + 1,
    );
    let policyTransition = db
      .updateTable("interactive_session_credential_policies")
      .set({ state: "cleanup_pending", updated_at: transitionRevision })
      .where("session_id", "=", row.session_id)
      .where("sandbox_id", "=", row.sandbox_id)
      .where("lookup_id", "=", row.lookup_id)
      .where("state", "=", row.policy_state)
      .where("registration_generation", "=", row.registration_generation)
      .where("updated_at", "=", row.policy_updated_at)
      .where(
        sandboxCredentialPolicyCleanupAuthorizedCondition(row.session_id, row.sandbox_id, now),
      );
    policyTransition = row.registration_claim
      ? policyTransition.where("registration_claim", "=", row.registration_claim)
      : policyTransition.where("registration_claim", "is", null);
    policyTransition =
      row.registration_claim_expires_at === null
        ? policyTransition.where("registration_claim_expires_at", "is", null)
        : policyTransition.where(
            "registration_claim_expires_at",
            "=",
            row.registration_claim_expires_at,
          );
    if (row.matched_standalone_id) {
      if (!row.standalone_state || row.standalone_updated_at === null) continue;
      let ownerTransition = db
        .updateTable("standalone_sandbox_provisions")
        .set({
          state: "cleanup_pending",
          ownership_claim: null,
          ownership_claim_expires_at: null,
          updated_at: transitionRevision,
        })
        .where("id", "=", row.matched_standalone_id)
        .where("sandbox_id", "=", row.sandbox_id)
        .where("state", "=", row.standalone_state)
        .where("updated_at", "=", row.standalone_updated_at);
      ownerTransition = row.standalone_claim
        ? ownerTransition.where("ownership_claim", "=", row.standalone_claim)
        : ownerTransition.where("ownership_claim", "is", null);
      ownerTransition =
        row.standalone_claim_expires_at === null
          ? ownerTransition.where("ownership_claim_expires_at", "is", null)
          : ownerTransition.where(
              "ownership_claim_expires_at",
              "=",
              row.standalone_claim_expires_at,
            );
      await executeBatch(env, [ownerTransition, policyTransition]);
      continue;
    }
    if (!row.matched_session_id || row.session_adapter === runtimeAdapterName) {
      await executeBatch(env, [policyTransition]);
      continue;
    }
    const sessionTransition = sql`
        UPDATE interactive_sessions
        SET terminal_failure_reason = CASE
              WHEN credential_cleanup_terminal_status = 'failed'
                OR status = 'failed'
                OR (
                  credential_cleanup_terminal_status IS NULL
                  AND status NOT IN ('stopping', 'stopped', 'expired')
                )
              THEN COALESCE(
                NULLIF(terminal_failure_reason, ''),
                NULLIF(reconcile_error, ''),
                NULLIF(last_event, ''),
                'sandbox credential registration cleanup failed'
              )
              ELSE terminal_failure_reason
            END,
            status = 'stopping',
            credential_cleanup_terminal_status = CASE
              WHEN credential_cleanup_terminal_status = 'failed' OR status = 'failed'
                THEN 'failed'
              WHEN credential_cleanup_terminal_status = 'expired' OR status = 'expired'
                THEN 'expired'
              WHEN credential_cleanup_terminal_status = 'stopped'
                OR status IN ('stopping', 'stopped')
                THEN 'stopped'
              ELSE 'failed'
            END,
            terminal_status = NULL,
            adapter_create_pending = 0,
            terminal_finalize_pending = 0,
            sandbox_refresh_sandbox_id = NULL,
            sandbox_refresh_claim = NULL,
            sandbox_refresh_claim_expires_at = NULL,
            agent_token_hash = NULL,
            attach_url = NULL,
            vnc_url = NULL,
            controller = NULL,
            control_requested_by = NULL,
            control_requested_at = NULL,
            control_granted_at = NULL,
            control_expires_at = NULL,
            reconcile_error = CASE
              WHEN credential_cleanup_terminal_status = 'failed'
                OR status = 'failed'
                OR (
                  credential_cleanup_terminal_status IS NULL
                  AND status NOT IN ('stopping', 'stopped', 'expired')
                )
              THEN COALESCE(
                NULLIF(terminal_failure_reason, ''),
                NULLIF(reconcile_error, ''),
                NULLIF(last_event, ''),
                'sandbox credential registration cleanup failed'
              )
              ELSE 'sandbox credential registration cleanup pending'
            END,
            stopped_at = COALESCE(stopped_at, ${now}),
            updated_at = ${transitionRevision},
            last_event = 'sandbox credential registration cleanup pending'
        WHERE id = ${row.matched_session_id}
          AND adapter IS ${row.session_adapter}
          AND status IS ${row.session_status}
          AND lease_id IS ${row.session_lease_id}
          AND credential_cleanup_terminal_status IS ${row.credential_cleanup_terminal_status}
          AND sandbox_refresh_sandbox_id IS ${row.session_sandbox_refresh_sandbox_id}
          AND sandbox_refresh_claim IS ${row.session_sandbox_refresh_claim}
          AND sandbox_refresh_claim_expires_at IS ${row.session_sandbox_refresh_claim_expires_at}
          AND agent_token_hash IS ${row.session_agent_token_hash}
          AND updated_at IS ${row.session_updated_at}
      `;
    await executeBatch(env, [sessionTransition, policyTransition]);
  }
  if (!sessionId) {
    const nextCursor = rows.at(-1)?.scan_rowid ?? 0;
    await sql`
      UPDATE credential_policy_reconcile_state
      SET last_rowid = ${nextCursor}, scan_max_rowid = ${maxRowid}, updated_at = ${now}
      WHERE id = 1
        AND last_rowid = ${originalCursor}
        AND scan_max_rowid = ${originalMaxRowid}
    `.execute(db);
  }
}

async function readCredentialPolicyScanPage(
  db: Kysely<Database>,
  cursor: number,
  maxRowid: number,
  sessionId?: string,
): Promise<CredentialPolicyScanRow[]> {
  const sessionFilter = sessionId ? sql`AND policy.session_id = ${sessionId}` : sql``;
  const result = await sql<CredentialPolicyScanRow>`
    SELECT
      policy.rowid AS scan_rowid,
      policy.session_id,
      policy.sandbox_id,
      policy.lookup_id,
      policy.state AS policy_state,
      policy.registration_generation,
      policy.registration_claim,
      policy.registration_claim_expires_at,
      policy.updated_at AS policy_updated_at,
      session.id AS matched_session_id,
      session.adapter AS session_adapter,
      session.status AS session_status,
      session.lease_id AS session_lease_id,
      session.credential_cleanup_terminal_status,
      session.sandbox_refresh_sandbox_id AS session_sandbox_refresh_sandbox_id,
      session.sandbox_refresh_claim AS session_sandbox_refresh_claim,
      session.sandbox_refresh_claim_expires_at AS session_sandbox_refresh_claim_expires_at,
      session.agent_token_hash AS session_agent_token_hash,
      session.updated_at AS session_updated_at,
      standalone.id AS matched_standalone_id,
      standalone.state AS standalone_state,
      standalone.ownership_claim AS standalone_claim,
      standalone.ownership_claim_expires_at AS standalone_claim_expires_at,
      standalone.updated_at AS standalone_updated_at
    FROM interactive_session_credential_policies AS policy
    LEFT JOIN interactive_sessions AS session ON session.id = policy.session_id
    LEFT JOIN standalone_sandbox_provisions AS standalone
      ON standalone.id = policy.session_id
      AND standalone.sandbox_id = policy.sandbox_id
    WHERE policy.rowid > ${cursor}
      AND policy.rowid <= ${maxRowid}
      AND policy.state IN ('registering', 'active')
      ${sessionFilter}
    ORDER BY policy.rowid ASC
    LIMIT ${credentialPolicyScanLimit}
  `.execute(db);
  return result.rows;
}

async function maximumCredentialPolicyRowid(db: Kysely<Database>): Promise<number> {
  const result = await sql<{ max_rowid: number }>`
    SELECT COALESCE(MAX(rowid), 0) AS max_rowid
    FROM interactive_session_credential_policies
  `.execute(db);
  return result.rows[0]?.max_rowid ?? 0;
}

async function repairActiveSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  row: CredentialPolicyScanRow,
  now: number,
): Promise<boolean> {
  if (
    row.policy_state !== "registering" ||
    (row.registration_claim !== null &&
      (row.registration_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now)
  ) {
    return false;
  }
  const ownershipFence = credentialPolicyScanOwnershipFence(row, now);
  if (!ownershipFence) return false;
  if (!(await sandboxCredentialPolicyExists(env, row.sandbox_id, row.registration_generation))) {
    return false;
  }
  const repaired = await recordSandboxCredentialPolicyRefs(
    env,
    row.session_id,
    row.sandbox_id,
    "active",
    row.registration_generation,
    ownershipFence,
    now,
  );
  if (!repaired) {
    throw new Error("active sandbox credential policy repair lost durable ownership");
  }
  return true;
}

function credentialPolicyScanOwnershipFence(
  row: CredentialPolicyScanRow,
  now: number,
): SandboxCredentialPolicyOwnershipFence | null {
  if (
    row.matched_standalone_id === row.session_id &&
    row.standalone_state === "provisioning" &&
    row.standalone_claim &&
    (row.standalone_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now
  ) {
    return {
      claim: row.standalone_claim,
      provisionId: row.matched_standalone_id,
      sandboxId: row.sandbox_id,
    };
  }
  if (!row.matched_session_id || !row.session_lease_id) return null;
  try {
    const lease = sandboxLeaseInfo({
      id: row.matched_session_id,
      adapter: row.session_adapter,
      leaseId: row.session_lease_id,
    });
    if (lease.sandboxId === row.sandbox_id) {
      return { leaseId: row.session_lease_id, sandboxId: row.sandbox_id };
    }
  } catch {
    return null;
  }
  if (
    row.session_sandbox_refresh_sandbox_id === row.sandbox_id &&
    row.session_sandbox_refresh_claim &&
    (row.session_sandbox_refresh_claim_expires_at ?? Number.NEGATIVE_INFINITY) > now
  ) {
    return {
      claim: row.session_sandbox_refresh_claim,
      expiresAt: row.session_sandbox_refresh_claim_expires_at as number,
      refreshLeaseId: row.session_lease_id,
      sandboxId: row.sandbox_id,
    };
  }
  return null;
}

function credentialPolicyScanRequiresCleanup(row: CredentialPolicyScanRow, now: number): boolean {
  const registrationAbandoned =
    row.policy_state === "registering" &&
    (row.registration_claim === null ||
      (row.registration_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now);
  if (row.matched_standalone_id) {
    if (row.standalone_state === "active") return false;
    if (row.standalone_state === "provisioning") {
      return (row.standalone_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now;
    }
    return true;
  }
  if (!row.matched_session_id || row.session_adapter === runtimeAdapterName) return true;
  if (
    row.credential_cleanup_terminal_status !== null ||
    row.session_status === "stopping" ||
    row.session_status === "stopped" ||
    row.session_status === "expired" ||
    row.session_status === "failed"
  ) {
    return true;
  }
  const leaseSandboxId = row.session_lease_id?.startsWith(sandboxLeasePrefix)
    ? (row.session_lease_id.slice(sandboxLeasePrefix.length).split(":", 1)[0] ?? null)
    : null;
  const sandboxExpected = credentialPolicySandboxIsExpected(
    leaseSandboxId,
    row.sandbox_id,
    row.session_sandbox_refresh_sandbox_id,
    row.session_sandbox_refresh_claim,
    row.session_sandbox_refresh_claim_expires_at,
    now,
  );
  if (
    sandboxExpected &&
    (row.session_status === "ready" ||
      row.session_status === "attached" ||
      row.session_status === "detached")
  ) {
    // Migrated live sessions can predate agent tokens; the durable lease/refresh fence owns policy.
    return false;
  }
  if (registrationAbandoned) return true;
  if (
    row.policy_state === "active" &&
    (row.session_status === "provisioning" || row.session_status === "pending_adapter") &&
    row.policy_updated_at <= now - credentialPolicyProvisioningStaleMs &&
    (row.session_updated_at ?? Number.NEGATIVE_INFINITY) <=
      now - credentialPolicyProvisioningStaleMs
  ) {
    return true;
  }
  if (
    row.policy_state === "active" &&
    (row.session_status === "ready" ||
      row.session_status === "attached" ||
      row.session_status === "detached")
  ) {
    return true;
  }
  return false;
}

async function normalizeCredentialPolicyCleanupGroups(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  const db = database(env);
  const state = sessionId
    ? null
    : await db
        .selectFrom("credential_policy_reconcile_state")
        .select([
          "group_session_id",
          "group_sandbox_id",
          "group_max_session_id",
          "group_max_sandbox_id",
        ])
        .where("id", "=", 1)
        .executeTakeFirst();
  const originalSessionCursor = state?.group_session_id ?? "";
  const originalSandboxCursor = state?.group_sandbox_id ?? "";
  const originalMaxSession = state?.group_max_session_id ?? "";
  const originalMaxSandbox = state?.group_max_sandbox_id ?? "";
  let maximum = sessionId
    ? { session_id: sessionId, sandbox_id: "\uffff" }
    : originalMaxSession
      ? { session_id: originalMaxSession, sandbox_id: originalMaxSandbox }
      : await maximumCredentialPolicyCleanupGroup(db);
  let groups = await readCredentialPolicyCleanupGroups(
    db,
    sessionId ? "" : originalSessionCursor,
    sessionId ? "" : originalSandboxCursor,
    maximum,
    sessionId,
  );
  if (!sessionId && groups.length === 0 && maximum) {
    maximum = await maximumCredentialPolicyCleanupGroup(db);
    groups = await readCredentialPolicyCleanupGroups(db, "", "", maximum);
  }
  for (const group of groups) {
    await queueSandboxCredentialPolicyCleanup(env, group.session_id, group.sandbox_id, now);
  }
  if (!sessionId) {
    const last = groups.at(-1);
    await db
      .updateTable("credential_policy_reconcile_state")
      .set({
        group_session_id: last?.session_id ?? "",
        group_sandbox_id: last?.sandbox_id ?? "",
        group_max_session_id: maximum?.session_id ?? "",
        group_max_sandbox_id: maximum?.sandbox_id ?? "",
        updated_at: now,
      })
      .where("id", "=", 1)
      .where("group_session_id", "=", originalSessionCursor)
      .where("group_sandbox_id", "=", originalSandboxCursor)
      .where("group_max_session_id", "=", originalMaxSession)
      .where("group_max_sandbox_id", "=", originalMaxSandbox)
      .execute();
  }
}

async function readCredentialPolicyCleanupGroups(
  db: Kysely<Database>,
  sessionCursor: string,
  sandboxCursor: string,
  maximum: { session_id: string; sandbox_id: string } | null,
  sessionId?: string,
): Promise<Array<{ session_id: string; sandbox_id: string }>> {
  let query = db
    .selectFrom("interactive_session_credential_policies")
    .select(["session_id", "sandbox_id"])
    .distinct()
    .where("state", "=", "cleanup_pending")
    .where((expression) =>
      expression.or([
        expression("session_id", ">", sessionCursor),
        expression.and([
          expression("session_id", "=", sessionCursor),
          expression("sandbox_id", ">", sandboxCursor),
        ]),
      ]),
    )
    .where((expression) =>
      maximum
        ? expression.or([
            expression("session_id", "<", maximum.session_id),
            expression.and([
              expression("session_id", "=", maximum.session_id),
              expression("sandbox_id", "<=", maximum.sandbox_id),
            ]),
          ])
        : expression("session_id", "=", ""),
    )
    .orderBy("session_id", "asc")
    .orderBy("sandbox_id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  return query.execute();
}

async function maximumCredentialPolicyCleanupGroup(
  db: Kysely<Database>,
): Promise<{ session_id: string; sandbox_id: string } | null> {
  return (
    (await db
      .selectFrom("interactive_session_credential_policies")
      .select(["session_id", "sandbox_id"])
      .where("state", "=", "cleanup_pending")
      .orderBy("session_id", "desc")
      .orderBy("sandbox_id", "desc")
      .executeTakeFirst()) ?? null
  );
}

async function reconcileCredentialPolicyCleanupBatch(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  await repairLegacySandboxCredentialPolicyBatch(env, now, sessionId).catch((error) => {
    console.error("legacy sandbox credential policy repair batch failed", error);
  });
  await expireStandaloneSandboxProvisions(env, now, sessionId).catch((error) => {
    console.error("standalone Sandbox expiry failed", error);
  });
  await scanCredentialPolicyCleanupPage(env, now, sessionId).catch((error) => {
    console.error("credential policy cleanup scan failed", error);
  });
  await normalizeCredentialPolicyCleanupGroups(env, now, sessionId).catch((error) => {
    console.error("credential policy cleanup group normalization failed", error);
  });
  let query = database(env)
    .selectFrom("interactive_session_credential_policies")
    .selectAll()
    .where("state", "=", "cleanup_pending")
    .where((expression) =>
      expression.or([
        expression("cleanup_claim", "is", null),
        expression("cleanup_claim_expires_at", "<", now),
      ]),
    )
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.registration_claim IS NOT NULL
          AND registration.registration_claim_expires_at > ${now}
      )
    `)
    .orderBy(sql`COALESCE(last_attempt_at, created_at)`, "asc")
    .orderBy("session_id", "asc")
    .orderBy("sandbox_id", "asc")
    .orderBy("lookup_id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  const policies = await query.execute();
  await mapWithConcurrency(policies, 3, async (policy) => {
    await reconcileCredentialPolicyCleanup(env, policy, now);
  });
  let completedSessions = database(env)
    .selectFrom("interactive_sessions")
    .select("id")
    .where("status", "in", ["stopping", "stopped", "expired", "failed"])
    .where("credential_cleanup_terminal_status", "is not", null)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS policy
        WHERE policy.session_id = interactive_sessions.id
      )
    `)
    .orderBy("stopped_at", "asc")
    .orderBy("id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) completedSessions = completedSessions.where("id", "=", sessionId);
  await mapWithConcurrency(await completedSessions.execute(), 3, async (session) => {
    await completeCredentialPolicyCleanupSession(env, session.id, Date.now());
  });
  let standaloneCleanup = database(env)
    .selectFrom("standalone_sandbox_provisions")
    .select(["id", "sandbox_id"])
    .where("state", "=", "cleanup_pending")
    .orderBy("updated_at", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) standaloneCleanup = standaloneCleanup.where("id", "=", sessionId);
  await mapWithConcurrency(await standaloneCleanup.execute(), 3, async (owner) => {
    await completeStandaloneSandboxProvisionCleanupSafely(env, owner.id, owner.sandbox_id);
  });
}

async function reconcileCredentialPolicyCleanup(
  env: RuntimeEnv,
  policy: Selectable<InteractiveSessionCredentialPolicyTable>,
  now: number,
): Promise<void> {
  const claim = crypto.randomUUID();
  const claimed = await sql`
    UPDATE interactive_session_credential_policies
    SET cleanup_claim = ${claim},
        cleanup_claim_expires_at = ${now + credentialPolicyCleanupClaimMs},
        attempt_count = attempt_count + 1,
        last_attempt_at = ${now},
        updated_at = ${now}
    WHERE session_id = ${policy.session_id}
      AND sandbox_id = ${policy.sandbox_id}
      AND lookup_id = ${policy.lookup_id}
      AND registration_generation = ${policy.registration_generation}
      AND state = 'cleanup_pending'
      AND (cleanup_claim IS NULL OR cleanup_claim_expires_at < ${now})
      AND ${sandboxCredentialPolicyCleanupAuthorizedCondition(
        policy.session_id,
        policy.sandbox_id,
        now,
      )}
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS registration
        WHERE registration.session_id = interactive_session_credential_policies.session_id
          AND registration.sandbox_id = interactive_session_credential_policies.sandbox_id
          AND registration.registration_claim IS NOT NULL
          AND registration.registration_claim_expires_at > ${now}
      )
  `.execute(database(env));
  if ((claimed.numAffectedRows ?? 0n) === 0n) return;
  try {
    await unregisterSandboxCredentialPolicyLookup(
      env,
      policy.lookup_id,
      policy.registration_generation,
      policy.session_id,
    );
  } catch (error) {
    await database(env)
      .updateTable("interactive_session_credential_policies")
      .set({
        last_error: clean(error instanceof Error ? error.message : String(error), 500),
        cleanup_claim: null,
        cleanup_claim_expires_at: null,
        updated_at: Date.now(),
      })
      .where("session_id", "=", policy.session_id)
      .where("sandbox_id", "=", policy.sandbox_id)
      .where("lookup_id", "=", policy.lookup_id)
      .where("registration_generation", "=", policy.registration_generation)
      .where("cleanup_claim", "=", claim)
      .execute();
    return;
  }
  await database(env)
    .deleteFrom("interactive_session_credential_policies")
    .where("session_id", "=", policy.session_id)
    .where("sandbox_id", "=", policy.sandbox_id)
    .where("lookup_id", "=", policy.lookup_id)
    .where("registration_generation", "=", policy.registration_generation)
    .where("cleanup_claim", "=", claim)
    .execute();
  await completeCredentialPolicyCleanupSession(env, policy.session_id, Date.now());
  await completeStandaloneSandboxProvisionCleanupSafely(env, policy.session_id, policy.sandbox_id);
}

async function completeStandaloneSandboxProvisionCleanupSafely(
  env: RuntimeEnv,
  provisionId: string,
  sandboxId: string,
): Promise<void> {
  try {
    await completeStandaloneSandboxProvisionCleanup(env, provisionId, sandboxId);
  } catch (error) {
    const now = Date.now();
    const message = `standalone Sandbox cleanup pending: ${safeProviderError(error, [
      provisionId,
      sandboxId,
    ])}`;
    try {
      await database(env)
        .updateTable("standalone_sandbox_provisions")
        .set({
          message,
          updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
        })
        .where("id", "=", provisionId)
        .where("sandbox_id", "=", sandboxId)
        .where("state", "=", "cleanup_pending")
        .execute();
    } catch (persistError) {
      console.error("standalone Sandbox cleanup failure persistence failed", persistError);
    }
  }
}

async function completeStandaloneSandboxProvisionCleanup(
  env: RuntimeEnv,
  provisionId: string,
  sandboxId: string,
): Promise<void> {
  const db = database(env);
  const owner = await db
    .selectFrom("standalone_sandbox_provisions")
    .selectAll()
    .where("id", "=", provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("state", "=", "cleanup_pending")
    .executeTakeFirst();
  if (!owner) return;
  if (owner.lease_id) {
    if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
    if (!isCurrentSandboxLease(owner.lease_id)) {
      throw serviceUnavailable("standalone Sandbox cleanup lease is invalid");
    }
    const lease = sandboxLeaseInfo({ id: owner.id, leaseId: owner.lease_id });
    if (lease.sandboxId !== owner.sandbox_id) {
      throw serviceUnavailable("standalone Sandbox cleanup ownership is inconsistent");
    }
    try {
      await getSandbox(env.SANDBOX, owner.sandbox_id).deleteSession(lease.terminalSessionId);
    } catch (error) {
      if (!isSandboxSessionAlreadyGone(error, lease.terminalSessionId)) throw error;
    }
  }
  await db
    .deleteFrom("standalone_sandbox_provisions")
    .where("id", "=", provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("request_hash", "=", owner.request_hash)
    .where("state", "=", "cleanup_pending")
    .where("updated_at", "=", owner.updated_at)
    .where(sql<boolean>`lease_id IS ${owner.lease_id}`)
    .where(sql<boolean>`expires_at IS ${owner.expires_at}`)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies AS policy
        WHERE policy.session_id = ${provisionId}
          AND policy.sandbox_id = ${sandboxId}
      )
    `)
    .execute();
}

async function completeCredentialPolicyCleanupSession(
  env: RuntimeEnv,
  sessionId: string,
  now: number,
): Promise<void> {
  const db = database(env);
  const remaining = await db
    .selectFrom("interactive_session_credential_policies")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("session_id", "=", sessionId)
    .executeTakeFirst();
  if (Number(remaining?.count ?? 0) > 0) return;
  const session = await db
    .selectFrom("interactive_sessions")
    .select([
      "status",
      "credential_cleanup_terminal_status",
      "terminal_failure_reason",
      "reconcile_error",
      "last_event",
      "stopped_at",
      "updated_at",
    ])
    .where("id", "=", sessionId)
    .executeTakeFirst();
  const terminalStatus = session?.credential_cleanup_terminal_status;
  if (!session || !terminalStatus) return;
  const failureMessage = retainedRuntimeAdapterFailureMessage(
    session.terminal_failure_reason,
    session.reconcile_error,
    session.last_event,
  );
  const updated = await db
    .updateTable("interactive_sessions")
    .set({
      status: terminalStatus,
      credential_cleanup_terminal_status: null,
      terminal_status: null,
      adapter_create_pending: 0,
      terminal_finalize_pending: 1,
      sandbox_refresh_sandbox_id: null,
      sandbox_refresh_claim: null,
      sandbox_refresh_claim_expires_at: null,
      terminal_failure_reason: terminalStatus === "failed" ? failureMessage : null,
      reconcile_error: terminalStatus === "failed" ? failureMessage : null,
      stopped_at: session.stopped_at ?? now,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      last_event:
        terminalStatus === "failed"
          ? failureMessage
          : terminalStatus === "expired"
            ? "interactive workspace expired after credential cleanup"
            : "interactive workspace stopped after credential cleanup",
    })
    .where("id", "=", sessionId)
    .where("status", "=", session.status)
    .where("updated_at", "=", session.updated_at)
    .where("credential_cleanup_terminal_status", "=", terminalStatus)
    .where(sql<boolean>`
      NOT EXISTS (
        SELECT 1
        FROM interactive_session_credential_policies
        WHERE session_id = ${sessionId}
      )
    `)
    .executeTakeFirst();
  if ((updated.numUpdatedRows ?? 0n) === 0n) return;
  await finalizeTerminalInteractiveSession(
    env,
    sessionId,
    terminalStatus,
    session.stopped_at ?? now,
  ).catch(() => undefined);
}

function legacyInteractiveSessionLeaseId(
  session: Pick<InteractiveSession, "adapter" | "leaseId">,
): string | null {
  return legacyLeaseIdForAdapter(session.adapter, session.leaseId);
}

function isSandboxInteractiveSession(
  session: Pick<InteractiveSession, "adapter" | "leaseId">,
): boolean {
  return legacyInteractiveSessionLeaseId(session)?.startsWith(sandboxLeasePrefix) === true;
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
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("websocket upgrade required");
  }
  if (!user && !(await canOpenAnonymousTerminalHub(request, env))) {
    throw unauthorized();
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  const subscriptions = new Map<string, TerminalHubSubscription>();
  const pendingSubscriptions = new Map<string, PendingTerminalSubscription>();
  let queue = Promise.resolve();
  let hubClosed = false;

  server.accept();
  sendTerminalJson(server, TerminalMessageType.Welcome, "", {
    ok: true,
    version: 1,
    multiplex: true,
  });

  const closeSubscription = (id: string, code = 1000, reason = "unsubscribed") => {
    const subscription = subscriptions.get(id);
    if (!subscription) return;
    subscriptions.delete(id);
    subscription.markClosing(reason);
    if (subscription.viewCheck !== null) clearInterval(subscription.viewCheck);
    if (subscription.upstream.readyState < WebSocket.CLOSING) {
      subscription.upstream.close(code, reason);
    }
  };

  const closeAll = (code = 1000, reason = "client closed") => {
    for (const id of subscriptions.keys()) closeSubscription(id, code, reason);
  };

  server.addEventListener("message", (event) => {
    queue = queue
      .catch(() => undefined)
      .then(async () => {
        const data = await webSocketMessageData(event.data);
        const bytes =
          typeof data === "string" ? encoder.encode(data) : new Uint8Array(data.slice(0));
        const frame = decodeTerminalFrame(bytes);
        if (!frame) {
          sendTerminalJson(server, TerminalMessageType.Error, "", { error: "invalid frame" });
          return;
        }
        if (frame.type === TerminalMessageType.Hello) {
          sendTerminalJson(server, TerminalMessageType.Welcome, "", {
            ok: true,
            version: 1,
            multiplex: true,
          });
          return;
        }
        if (frame.type === TerminalMessageType.Ping) {
          sendTerminalFrame(server, TerminalMessageType.Pong, frame.sessionId, frame.payload);
          return;
        }
        if (frame.type === TerminalMessageType.Subscribe) {
          if (frame.sessionId) {
            const existingPending = pendingSubscriptions.get(frame.sessionId);
            if (existingPending && !existingPending.unsubscribeRequested) {
              sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
                type: "subscribing",
              });
              return;
            }
          }
          const pending = { unsubscribeRequested: false };
          if (frame.sessionId) pendingSubscriptions.set(frame.sessionId, pending);
          void subscribeTerminalHubSession(
            request,
            env,
            user,
            server,
            subscriptions,
            frame,
            () => !hubClosed && !pending.unsubscribeRequested,
          ).finally(() => {
            if (frame.sessionId && pendingSubscriptions.get(frame.sessionId) === pending) {
              pendingSubscriptions.delete(frame.sessionId);
            }
          });
          return;
        }
        if (frame.type === TerminalMessageType.Unsubscribe) {
          const pending = pendingSubscriptions.get(frame.sessionId);
          if (pending) {
            pending.unsubscribeRequested = true;
            return;
          }
          closeSubscription(frame.sessionId);
          return;
        }

        if (pendingSubscriptions.has(frame.sessionId)) {
          sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
            type: "subscribing",
          });
          return;
        }

        const subscription = subscriptions.get(frame.sessionId);
        if (!subscription) {
          sendTerminalJson(server, TerminalMessageType.Error, frame.sessionId, {
            error: "session is not subscribed",
          });
          return;
        }
        if (frame.type === TerminalMessageType.Input || frame.type === TerminalMessageType.Key) {
          if (!(await subscription.canInput())) {
            sendTerminalJson(server, TerminalMessageType.ControlRevoked, frame.sessionId, {
              error: "terminal control has not been granted",
            });
            return;
          }
          if (subscription.upstream.readyState === WebSocket.OPEN) {
            const inputs = await multiplayerTerminalInputPayloads(
              env,
              subscription,
              user,
              frame.payload,
            );
            for (const [index, input] of inputs.entries()) {
              if (index > 0) await sleep(index === inputs.length - 1 ? 80 : 2);
              subscription.upstream.send(input);
            }
          }
          return;
        }
        if (frame.type === TerminalMessageType.Resize) {
          const size = decodeResizePayload(frame.payload);
          if (!(await subscription.canInput())) {
            sendTerminalJson(server, TerminalMessageType.ControlRevoked, frame.sessionId, {
              error: "terminal control has not been granted",
            });
            return;
          }
          if (size) {
            subscription.cols = size.cols;
            subscription.rows = size.rows;
            if (subscription.upstream.readyState === WebSocket.OPEN) {
              subscription.upstream.send(JSON.stringify({ type: "resize", ...size }));
            }
          }
          sendTerminalJson(server, TerminalMessageType.Event, frame.sessionId, {
            type: "resize",
            cols: size?.cols ?? null,
            rows: size?.rows ?? null,
          });
          return;
        }
        if (frame.type === TerminalMessageType.Ack) {
          const bytes = decodeAckPayload(frame.payload);
          if (
            bytes &&
            subscription.outputAcknowledgements &&
            bytes <= subscription.outputAcknowledgementBytes &&
            subscription.upstream.readyState === WebSocket.OPEN
          ) {
            subscription.outputAcknowledgementBytes -= bytes;
            sendTerminalOutputAcknowledgement(subscription.upstream, bytes);
          }
          return;
        }
        if (frame.type === TerminalMessageType.Stop) {
          closeSubscription(frame.sessionId, 1000, "stopped by client");
        }
      });
  });

  server.addEventListener("close", () => {
    hubClosed = true;
    closeAll();
  });
  server.addEventListener("error", () => {
    hubClosed = true;
    closeAll(1011, "client error");
  });

  return new Response(null, { status: 101, webSocket: client });
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

async function subscribeTerminalHubSession(
  request: Request,
  env: RuntimeEnv,
  user: User | null,
  client: WebSocket,
  subscriptions: Map<string, TerminalHubSubscription>,
  frame: { sessionId: string; payload: Uint8Array },
  isHubOpen: () => boolean,
): Promise<void> {
  const id = frame.sessionId;
  if (!id) {
    sendTerminalJson(client, TerminalMessageType.Error, "", { error: "session id required" });
    return;
  }
  const subscription = decodeSubscribePayload(frame.payload);
  if (!subscription) {
    sendTerminalJson(client, TerminalMessageType.Error, id, { error: "invalid subscribe payload" });
    return;
  }
  if (subscriptions.has(id)) {
    sendTerminalJson(client, TerminalMessageType.Event, id, { type: "subscribed" });
    return;
  }

  if (!user && !(await canViewSharedTerminalRequest(request, env, id))) {
    sendTerminalJson(client, TerminalMessageType.Error, id, { error: "unauthorized" });
    return;
  }

  const session = await readFreshInteractiveSession(env, id);
  if (!session) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: "interactive session not found",
    });
    return;
  }
  if (["stopping", "expired", "failed", "stopped"].includes(session.status)) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: `session is ${session.status}`,
    });
    return;
  }
  if (!session.capabilities.terminal) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: "session does not advertise terminal access",
    });
    return;
  }
  if (!(await canViewTerminalSession(request, env, user, session))) {
    sendTerminalJson(client, TerminalMessageType.Error, id, { error: "unauthorized" });
    return;
  }

  try {
    const canInput = terminalInputGrant(env, user, session);
    const canInputNow = await canInput();
    const canView = terminalViewGrant(request, env, user, session);
    const reconcileSubscription = terminalSubscriptionReconciler(env, id);
    const cols = canInputNow ? terminalDimension(subscription.cols, 120) : 120;
    const rows = canInputNow ? terminalDimension(subscription.rows, 34) : 34;
    const outputAcknowledgements = Boolean(
      subscription.flags & TerminalSubscribeFlags.OutputAcknowledgements,
    );
    let closingReason: string | undefined;
    const markClosing = (reason: string) => {
      closingReason = reason;
    };
    const consumeCloseReason = () => {
      const reason = closingReason;
      closingReason = undefined;
      return reason;
    };
    let upstreamConnection: TerminalUpstream;
    try {
      upstreamConnection = await openInteractiveTerminalUpstream(
        request,
        env,
        user,
        session,
        cols,
        rows,
      );
    } catch (error) {
      const message = redactedAdapterMessage(
        `terminal unavailable: ${
          error instanceof Error ? error.message : "terminal connection failed"
        }`,
        "failed",
        [session.adapterWorkspaceId, session.providerResourceId],
        [session.attachUrl],
      );
      if (
        session.runtime === githubActionsRuntime ||
        (isSandboxInteractiveSession(session) && env.SANDBOX)
      ) {
        await markInteractiveTerminalDetached(env, user, id, Date.now(), message);
      } else {
        await markInteractiveTerminalUnavailable(env, user, id, Date.now(), message);
      }
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: message,
      });
      return;
    }
    const upstream = upstreamConnection.socket;
    if (!isHubOpen() || client.readyState !== WebSocket.OPEN) {
      if (upstream.readyState < WebSocket.CLOSING) upstream.close(1000, "client closed");
      return;
    }
    let viewGranted = true;
    let viewCheck: ReturnType<typeof setInterval> | null = null;
    const revokeView = () => {
      if (!viewGranted) return;
      viewGranted = false;
      subscriptions.delete(id);
      if (viewCheck !== null) clearInterval(viewCheck);
      if (upstream.readyState === WebSocket.OPEN) upstream.close(1008, "share revoked");
      sendTerminalJson(client, TerminalMessageType.Error, id, {
        error: "terminal share revoked",
      });
    };
    viewCheck = setInterval(() => {
      reconcileSubscription();
      void canView()
        .then((allowed) => {
          if (!allowed) revokeView();
        })
        .catch(() => revokeView());
    }, 5000);
    const activeSubscription: TerminalHubSubscription = {
      session,
      upstream,
      canView,
      canInput,
      markClosing,
      viewCheck,
      cols,
      rows,
      outputAcknowledgements: outputAcknowledgements && upstreamConnection.outputAcknowledgements,
      outputAcknowledgementBytes: 0,
    };
    subscriptions.set(id, activeSubscription);
    let outputQueue = Promise.resolve();
    sendTerminalJson(client, TerminalMessageType.Event, id, {
      type: "subscribed",
      canInput: canInputNow,
    });
    upstream.addEventListener("message", (event) => {
      const raw = event.data;
      outputQueue = outputQueue
        .catch(() => undefined)
        .then(async () => {
          const data = await webSocketMessageData(raw);
          if (client.readyState !== WebSocket.OPEN) return;
          if (!viewGranted) return;
          if (typeof data === "string") {
            const parsed = parseTerminalControlMessage(data);
            if (parsed) {
              sendTerminalJson(client, TerminalMessageType.Event, id, parsed);
              return;
            }
            const output = encoder.encode(data);
            sendTerminalFrame(client, TerminalMessageType.Output, id, output);
            if (activeSubscription.outputAcknowledgements) {
              activeSubscription.outputAcknowledgementBytes += output.byteLength;
            } else if (upstreamConnection.outputAcknowledgements) {
              sendTerminalOutputAcknowledgement(upstream, output.byteLength);
            }
            return;
          }
          const output = new Uint8Array(data);
          sendTerminalFrame(client, TerminalMessageType.Output, id, output);
          if (activeSubscription.outputAcknowledgements) {
            activeSubscription.outputAcknowledgementBytes += output.byteLength;
          } else if (upstreamConnection.outputAcknowledgements) {
            sendTerminalOutputAcknowledgement(upstream, output.byteLength);
          }
        });
    });
    upstream.addEventListener("close", (event) => {
      const closeReason = consumeCloseReason();
      const safeUpstreamReason = event.reason
        ? redactedAdapterMessage(
            event.reason,
            "detached",
            [session.adapterWorkspaceId, session.providerResourceId],
            [session.attachUrl],
          )
        : "";
      subscriptions.delete(id);
      if (viewCheck !== null) clearInterval(viewCheck);
      if (!isPassiveTerminalClose(closeReason)) {
        const message = terminalCloseMessage(event.code, safeUpstreamReason);
        void markInteractiveTerminalDetached(env, user, id, Date.now(), message);
      }
      if (client.readyState === WebSocket.OPEN) {
        sendTerminalJson(client, TerminalMessageType.Event, id, {
          type: "closed",
          code: event.code,
          reason: closeReason || safeUpstreamReason,
        });
      }
    });
    upstream.addEventListener("error", () => {
      const closeReason = closingReason;
      subscriptions.delete(id);
      if (viewCheck !== null) clearInterval(viewCheck);
      const message = "terminal unavailable: upstream terminal error";
      if (!isPassiveTerminalClose(closeReason)) {
        const markTerminal =
          session.runtime === githubActionsRuntime ||
          (isSandboxInteractiveSession(session) && env.SANDBOX)
            ? markInteractiveTerminalDetached
            : markInteractiveTerminalUnavailable;
        void markTerminal(env, user, id, Date.now(), message);
        sendTerminalJson(client, TerminalMessageType.Error, id, { error: message });
      }
    });
    void upstreamConnection.markConnected().catch(() => {
      sendTerminalJson(client, TerminalMessageType.Event, id, {
        type: "warning",
        message: "terminal connection state update failed",
      });
    });
  } catch (error) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: redactedAdapterMessage(
        error instanceof Error ? error.message : "terminal subscription failed",
        "failed",
        [session.adapterWorkspaceId, session.providerResourceId],
        [session.attachUrl],
      ),
    });
  }
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
  if (!target) throw serviceUnavailable("PTY bridge is not configured for this session");
  const upstreamResponse = await interactiveTerminalFetch(
    env,
    session,
    sizedTerminalTargetUrl(target.url, routeKind, cols, rows),
    interactiveTerminalHeaders(session, target.authorization),
  );
  const upstream = upstreamResponse.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    throw serviceUnavailable(`PTY bridge HTTP ${upstreamResponse.status}`);
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
  if (runtimeAdapterTerminalFailureStatus(existing.adapter) === "detached") {
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

function sendTerminalFrame(
  socket: WebSocket,
  type: TerminalMessageType,
  sessionId: string,
  payload?: Uint8Array,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(
      payload
        ? encodeTerminalFrame({ type, sessionId, payload })
        : encodeTerminalFrame({ type, sessionId }),
    );
  }
}

function sendTerminalJson(
  socket: WebSocket,
  type: TerminalMessageType,
  sessionId: string,
  payload: unknown,
): void {
  sendTerminalFrame(socket, type, sessionId, encodeJsonPayload(payload));
}

function parseTerminalControlMessage(data: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(data) as Record<string, unknown>;
    return typeof parsed.type === "string" ? parsed : null;
  } catch {
    return null;
  }
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

function sandboxBackupAllowedHosts(env: RuntimeEnv): string[] {
  return env.CLOUDFLARE_ACCOUNT_ID && env.BACKUP_BUCKET_NAME
    ? [`${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`]
    : [];
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

function interactiveTerminalTarget(
  env: RuntimeEnv,
  session: InteractiveSession,
  routeKind = interactivePtyRouteKind(env, session),
): InteractiveTerminalTarget | null {
  if (routeKind === "bridge" && env.CRABBOX_PTY_BRIDGE_URL) {
    const url = interactiveBridgeUrl(env.CRABBOX_PTY_BRIDGE_URL, session);
    if (!url) return null;
    return {
      url,
      authorization: bearer(env.CRABBOX_PTY_BRIDGE_TOKEN),
    };
  }

  const attachUrl = routeKind === "attach" ? safeWebSocketUrl(session.attachUrl) : null;
  if (attachUrl) {
    if (session.adapter === runtimeAdapterName) {
      const authorization = runtimeAdapterTerminalAuthorization(
        env,
        session.profile,
        session[interactiveSessionAdapterControlPlane],
        attachUrl,
      );
      return authorization ? { url: attachUrl, authorization } : null;
    }
    return {
      url: attachUrl,
      authorization: null,
    };
  }

  const leaseId = legacyInteractiveSessionLeaseId(session);
  if (
    routeKind === "cloudflare" &&
    leaseId?.startsWith("cloudflare:") &&
    env.CRABBOX_CLOUDFLARE_RUNNER_URL
  ) {
    const sandboxId = leaseId.slice("cloudflare:".length);
    const runnerUrl = safeDesktopUrl(env.CRABBOX_CLOUDFLARE_RUNNER_URL);
    if (!runnerUrl) return null;
    const url = addQuery(
      joinUrl(runnerUrl, `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty`),
      terminalQuery(session),
    );
    if (!url) return null;
    return {
      url,
      authorization: bearer(env.CRABBOX_CLOUDFLARE_RUNNER_TOKEN),
    };
  }

  return null;
}

function runtimeAdapterTerminalAuthorization(
  env: RuntimeEnv,
  profile: string,
  registeredControlPlane: string | null,
  attachUrl: string,
): string | null {
  try {
    const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      env,
      profile,
      registeredControlPlane,
    );
    if (!runtimeAdapterTerminalOriginMatches(controlPlane, attachUrl)) return null;
    return bearer(runtimeAdapterToken(env));
  } catch {
    return null;
  }
}

function interactivePtyRouteKind(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "adapter" | "leaseId" | "attachUrl">,
): PtyRouteKind | null {
  return ptyRouteKind(session, {
    sandboxAvailable: Boolean(env.SANDBOX),
    bridgeUrl: env.CRABBOX_PTY_BRIDGE_URL,
    cloudflareRunnerUrl: env.CRABBOX_CLOUDFLARE_RUNNER_URL,
  });
}

function interactiveBridgeUrl(base: string, session: InteractiveSession): string {
  const leaseId = legacyInteractiveSessionLeaseId(session) ?? "";
  const replacements: Record<string, string> = {
    id: session.id,
    leaseId,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
  };
  let url = base;
  for (const [key, value] of Object.entries(replacements)) {
    url = url.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return safeWebSocketUrl(addQuery(httpToWebSocketUrl(url), terminalQuery(session))) ?? "";
}

function terminalQuery(session: InteractiveSession): Record<string, string> {
  return {
    sessionId: session.id,
    leaseId: legacyInteractiveSessionLeaseId(session) ?? "",
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    profile: session.profile,
    command: session.command,
  };
}

function interactiveTerminalHeaders(
  session: InteractiveSession,
  authorization: string | null,
): Headers {
  const headers = new Headers({
    upgrade: "websocket",
    "x-crabbox-session": session.id,
    "x-crabbox-repo": session.repo,
    "x-crabbox-runtime": session.runtime,
  });
  if (authorization) headers.set("authorization", authorization);
  return headers;
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

function bridgeWebSockets(
  left: WebSocket,
  right: WebSocket,
  canSendLeft?: () => Promise<boolean>,
  reconcileSubscription?: () => void,
  deniedReason = "terminal control revoked",
  forwardRightOutputAcknowledgements = false,
  acknowledgeRightOutputImmediately = false,
): void {
  let leftInputQueue = Promise.resolve();
  let rightOutputQueue = Promise.resolve();
  let controlCheckTimer: ReturnType<typeof setInterval> | undefined;
  let controlCheckInFlight: Promise<void> | undefined;
  let leftCanSend = true;
  let rightOutputAcknowledgementBytes = 0;
  const stopControlCheck = () => {
    if (controlCheckTimer !== undefined) clearInterval(controlCheckTimer);
    controlCheckTimer = undefined;
  };
  const verifyControl = async () => {
    const canSend = canSendLeft ? await canSendLeft().catch(() => false) : true;
    leftCanSend = canSend;
    if (!canSend) {
      stopControlCheck();
      closePair(left, right, 1008, deniedReason);
      return false;
    }
    return true;
  };
  const scheduleControlCheck = () => {
    reconcileSubscription?.();
    if (controlCheckInFlight) return;
    controlCheckInFlight = verifyControl()
      .then(() => undefined)
      .finally(() => {
        controlCheckInFlight = undefined;
      });
  };
  if (canSendLeft) {
    controlCheckTimer = setInterval(() => {
      scheduleControlCheck();
    }, 5000);
    scheduleControlCheck();
  }
  left.addEventListener("message", (event) => {
    const data = event.data;
    leftInputQueue = leftInputQueue
      .catch(() => undefined)
      .then(async () => {
        if (left.readyState !== WebSocket.OPEN || right.readyState !== WebSocket.OPEN) return;
        if (!leftCanSend || !(await verifyControl())) {
          closePair(left, right, 1008, deniedReason);
          return;
        }
        const forwarded = await webSocketMessageData(data);
        const acknowledgedBytes = forwardRightOutputAcknowledgements
          ? terminalOutputAcknowledgement(forwarded)
          : null;
        if (acknowledgedBytes !== null) {
          if (acknowledgedBytes <= rightOutputAcknowledgementBytes) {
            rightOutputAcknowledgementBytes -= acknowledgedBytes;
            sendTerminalOutputAcknowledgement(right, acknowledgedBytes);
          }
          return;
        }
        right.send(forwarded);
      });
  });
  right.addEventListener("message", (event) => {
    const data = event.data;
    rightOutputQueue = rightOutputQueue
      .catch(() => undefined)
      .then(async () => {
        if (left.readyState !== WebSocket.OPEN || right.readyState !== WebSocket.OPEN) return;
        const forwarded = await webSocketMessageData(data);
        left.send(forwarded);
        if (forwardRightOutputAcknowledgements) {
          rightOutputAcknowledgementBytes += terminalMessageByteLength(forwarded);
        } else if (acknowledgeRightOutputImmediately) {
          sendTerminalOutputAcknowledgement(right, terminalMessageByteLength(forwarded));
        }
      });
  });
  left.addEventListener("close", (event) => {
    stopControlCheck();
    closePeer(event, right);
  });
  right.addEventListener("close", (event) => {
    stopControlCheck();
    closePeer(event, left);
  });
  left.addEventListener("error", () => {
    stopControlCheck();
    closePair(left, right, 1011, "peer error");
  });
  right.addEventListener("error", () => {
    stopControlCheck();
    closePair(right, left, 1011, "peer error");
  });
}

function terminalOutputAcknowledgements(value: string): boolean {
  try {
    return new URL(value).searchParams.get("flow") === "ack-v1";
  } catch {
    return false;
  }
}

function terminalOutputAcknowledgement(value: string | ArrayBuffer): number | null {
  if (typeof value !== "string" || !value.startsWith("{") || value.length > 100) return null;
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const bytes = parsed.bytes;
    return parsed.type === "ack" &&
      Number.isInteger(bytes) &&
      Number(bytes) > 0 &&
      Number(bytes) <= 1024 * 1024
      ? Number(bytes)
      : null;
  } catch {
    return null;
  }
}

function terminalMessageByteLength(value: string | ArrayBuffer): number {
  return typeof value === "string" ? encoder.encode(value).byteLength : value.byteLength;
}

function sendTerminalOutputAcknowledgement(socket: WebSocket, bytes: number): void {
  if (bytes > 0 && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({ type: "ack", bytes }));
  }
}

async function webSocketMessageData(data: unknown): Promise<string | ArrayBuffer> {
  if (typeof data === "string" || data instanceof ArrayBuffer) return data;
  if (data instanceof Uint8Array) {
    return new Uint8Array(data).buffer;
  }
  if (data instanceof Blob) return await data.arrayBuffer();
  if (
    data &&
    typeof data === "object" &&
    "arrayBuffer" in data &&
    typeof data.arrayBuffer === "function"
  ) {
    return await data.arrayBuffer();
  }
  return String(data);
}

function closePeer(event: CloseEvent, to: WebSocket): void {
  if (to.readyState === WebSocket.OPEN || to.readyState === WebSocket.CONNECTING) {
    to.close(
      event.code || 1000,
      clean(event.reason ? redactedAdapterMessage(event.reason, "detached") : "peer closed", 120),
    );
  }
}

function closePair(left: WebSocket, right: WebSocket, code: number, reason: string): void {
  if (left.readyState === WebSocket.OPEN || left.readyState === WebSocket.CONNECTING) {
    left.close(code, reason);
  }
  if (right.readyState === WebSocket.OPEN || right.readyState === WebSocket.CONNECTING) {
    right.close(code, reason);
  }
}

async function provisionInteractiveSession(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  agentToken?: string,
  sandboxProvision?: {
    lease: SandboxLease;
    ownership: SandboxCurrentLeaseFence;
  },
): Promise<InteractiveProvisionResult | null> {
  if (session.runtime === "container" && env.SANDBOX) {
    if (!sandboxProvision) {
      return failedProvision("Cloudflare Sandbox durable ownership is missing");
    }
    return provisionWithSandbox(
      env,
      session,
      agentToken,
      sandboxProvision.lease,
      sandboxProvision.ownership,
    );
  }
  if (runtimeAdapterConfigurationPresent(env)) {
    return provisionWithRuntimeAdapter(env, session, agentToken);
  }
  if (!env.CRABBOX_INTERACTIVE_PROVISION_URL) return null;
  if (isBuiltInInteractiveProvisionUrl(env, env.CRABBOX_INTERACTIVE_PROVISION_URL)) {
    return provisionInteractivePayload(env, session, agentToken);
  }
  let response: Response;
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (env.CRABBOX_INTERACTIVE_PROVISION_TOKEN) {
      headers.set("authorization", `Bearer ${env.CRABBOX_INTERACTIVE_PROVISION_TOKEN}`);
    }
    response = await fetch(env.CRABBOX_INTERACTIVE_PROVISION_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(session),
    });
  } catch (error) {
    return {
      status: "failed",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      message: `interactive provision failed: ${clean(String(error), 240)}`,
    };
  }
  if (!response.ok) {
    return {
      status: "failed",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      message: `interactive provision failed: HTTP ${response.status}`,
    };
  }
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const status = createOnlyAdapterStatus(body.status);
  if (!status) {
    return {
      status: "failed",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      message: "interactive provision failed: invalid adapter response",
    };
  }
  const leaseId = clean(body.leaseId ?? body.lease_id, 240) || null;
  const attachUrl = clean(body.attachUrl ?? body.attach_url, 1000) || null;
  const vncUrl = clean(body.vncUrl ?? body.vnc_url, 1000) || null;
  return {
    status,
    leaseId,
    attachUrl,
    vncUrl,
    message: redactedAdapterMessage(
      clean(body.message, 500) || null,
      status,
      [leaseId],
      [attachUrl, vncUrl],
    ),
  };
}

async function provisionInteractiveEndpoint(
  request: Request,
  env: RuntimeEnv,
): Promise<InteractiveProvisionResult> {
  authorizeProvisionEndpoint(request, env);
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
    return provisionManagedSandboxEndpoint(env, payload, managed);
  }
  if (payload.runtime === "container" && env.SANDBOX) {
    if (managedInteractiveSessionId(payload.id)) {
      return failedProvision(
        "interactive provision failed: standalone provision id uses the managed session namespace",
      );
    }
    return provisionStandaloneSandbox(env, payload);
  }
  return provisionInteractivePayload(env, payload);
}

function managedSandboxProvisionPayloadMatches(
  payload: InteractiveProvisionRequest,
  session: InteractiveSessionRow,
): boolean {
  return (
    payload.id === session.id &&
    payload.parentSessionId === session.parent_session_id &&
    payload.rootSessionId === (session.root_session_id ?? session.id) &&
    payload.repo === session.repo &&
    payload.branch === session.branch &&
    payload.runtime === session.runtime &&
    payload.profile === session.profile &&
    payload.command === session.command &&
    payload.prompt === session.prompt &&
    payload.purpose === session.purpose &&
    payload.summary === session.summary &&
    payload.owner === session.owner &&
    payload.createdBy === session.created_by
  );
}

async function provisionManagedSandboxEndpoint(
  env: RuntimeEnv,
  payload: InteractiveProvisionRequest,
  session: InteractiveSessionRow,
): Promise<InteractiveProvisionResult> {
  if (
    !managedSandboxProvisionPayloadMatches(payload, session) ||
    !["provisioning", "pending_adapter"].includes(session.status) ||
    session.preparation_pending !== 0 ||
    session.adapter === runtimeAdapterName ||
    session.credential_cleanup_terminal_status !== null
  ) {
    return failedProvision(
      "interactive provision failed: managed session request does not match durable ownership",
    );
  }
  const preflightError = sandboxProvisionPreflightError(env, payload);
  if (preflightError) return failedProvision(preflightError);
  const now = Date.now();
  const claimRevision = Math.max(now, session.updated_at + 1);
  const agentToken = newAgentToken();
  const agentTokenHash = await sha256(agentToken);
  const lease = newSandboxLease(payload.id);
  const fence: SandboxLeaseRefreshFence = {
    claim: `managed-provision:${crypto.randomUUID()}`,
    expiresAt: now + credentialPolicyProvisioningStaleMs,
    refreshLeaseId: session.lease_id,
    sandboxId: lease.sandboxId,
  };
  const claimed = await database(env)
    .updateTable("interactive_sessions")
    .set({
      sandbox_refresh_sandbox_id: fence.sandboxId,
      sandbox_refresh_claim: fence.claim,
      sandbox_refresh_claim_expires_at: fence.expiresAt,
      agent_token_hash: agentTokenHash,
      last_event: "managed Sandbox provision claimed",
      updated_at: claimRevision,
    })
    .where("id", "=", session.id)
    .where("updated_at", "=", session.updated_at)
    .where("status", "in", ["provisioning", "pending_adapter"])
    .where("preparation_pending", "=", 0)
    .where(sql<boolean>`parent_session_id IS ${payload.parentSessionId}`)
    .where(sql<boolean>`COALESCE(root_session_id, id) = ${payload.rootSessionId}`)
    .where("runtime", "=", payload.runtime)
    .where("repo", "=", payload.repo)
    .where("branch", "=", payload.branch)
    .where("profile", "=", payload.profile)
    .where("command", "=", payload.command)
    .where("prompt", "=", payload.prompt)
    .where("purpose", "=", payload.purpose)
    .where("summary", "=", payload.summary)
    .where("owner", "=", payload.owner)
    .where("created_by", "=", payload.createdBy)
    .where((expression) =>
      expression.or([
        expression("adapter", "is", null),
        expression("adapter", "!=", runtimeAdapterName),
      ]),
    )
    .where("credential_cleanup_terminal_status", "is", null)
    .where(sql<boolean>`agent_token_hash IS ${session.agent_token_hash}`)
    .where(sql<boolean>`lease_id IS ${session.lease_id}`)
    .where((expression) =>
      expression.or([
        expression("sandbox_refresh_claim", "is", null),
        expression("sandbox_refresh_claim_expires_at", "<=", now),
      ]),
    )
    .executeTakeFirst();
  if ((claimed.numUpdatedRows ?? 0n) === 0n) {
    return failedProvision("interactive provision failed: managed session claim was not acquired");
  }

  let provisioned: InteractiveProvisionResult;
  try {
    provisioned = await provisionWithSandbox(env, payload, agentToken, lease, fence);
  } catch (error) {
    const message = `Cloudflare Sandbox provision failed: ${safeProviderError(error)}`;
    await stageFailedManagedSandboxProvision(env, session.id, fence, message, Date.now());
    return failedProvision(message);
  }
  if (provisioned.status !== "ready") {
    await stageFailedManagedSandboxProvision(
      env,
      session.id,
      fence,
      provisioned.message,
      Date.now(),
    );
    return provisioned;
  }
  const expectedLeaseId = sandboxLeaseId(lease);
  const previousSandboxId = session.lease_id?.startsWith(sandboxLeasePrefix)
    ? sandboxLeaseInfo({
        id: session.id,
        leaseId: sandboxLeaseWithoutRefresh(session.lease_id),
      }).sandboxId
    : null;
  const finishedAt = Date.now();
  if (provisioned.leaseId !== expectedLeaseId) {
    const message = "interactive provision failed: managed Sandbox lease mismatch";
    const staged = await stageTerminalCredentialPolicyCleanupById(
      env,
      session.id,
      "failed",
      message,
      finishedAt,
      message,
      fence,
    );
    if (!staged) {
      return failedProvision("interactive provision failed: managed session ownership changed");
    }
    await reconcileCredentialPolicyCleanupBatch(env, finishedAt, session.id);
    return failedProvision(message);
  }
  const db = database(env);
  const commitRevision = Math.max(finishedAt, claimRevision + 1);
  const commitQueries: CompilableQuery[] = [
    db
      .updateTable("interactive_sessions")
      .set({
        status: "ready",
        lease_id: expectedLeaseId,
        attach_url: provisioned.attachUrl,
        vnc_url: provisioned.vncUrl,
        sandbox_refresh_sandbox_id: null,
        sandbox_refresh_claim: null,
        sandbox_refresh_claim_expires_at: null,
        last_event: provisioned.message,
        updated_at: sql<number>`MAX(updated_at + 1, ${commitRevision})`,
      })
      .where("id", "=", session.id)
      .where("status", "in", ["provisioning", "pending_adapter"])
      .where(sql<boolean>`lease_id IS ${fence.refreshLeaseId}`)
      .where("sandbox_refresh_sandbox_id", "=", fence.sandboxId)
      .where("sandbox_refresh_claim", "=", fence.claim)
      .where("sandbox_refresh_claim_expires_at", "=", fence.expiresAt)
      .where("sandbox_refresh_claim_expires_at", ">", finishedAt)
      .where("agent_token_hash", "=", agentTokenHash),
  ];
  if (previousSandboxId && previousSandboxId !== lease.sandboxId) {
    commitQueries.push(
      db
        .updateTable("interactive_session_credential_policies")
        .set({
          state: "cleanup_pending",
          cleanup_claim: null,
          cleanup_claim_expires_at: null,
          updated_at: commitRevision,
        })
        .where("session_id", "=", session.id)
        .where("sandbox_id", "=", previousSandboxId).where(sql<boolean>`
          EXISTS (
            SELECT 1
            FROM interactive_sessions AS owner
            WHERE owner.id = ${session.id}
              AND owner.status = 'ready'
              AND owner.lease_id = ${expectedLeaseId}
              AND owner.agent_token_hash = ${agentTokenHash}
              AND owner.credential_cleanup_terminal_status IS NULL
              AND owner.sandbox_refresh_sandbox_id IS NULL
              AND owner.sandbox_refresh_claim IS NULL
              AND owner.sandbox_refresh_claim_expires_at IS NULL
          )
        `),
    );
  }
  await executeBatch(env, commitQueries);
  const current = await db
    .selectFrom("interactive_sessions")
    .select(["lease_id", "status", "sandbox_refresh_claim", "agent_token_hash"])
    .where("id", "=", session.id)
    .executeTakeFirst();
  if (
    current?.lease_id === expectedLeaseId &&
    current.sandbox_refresh_claim === null &&
    current.agent_token_hash === agentTokenHash &&
    ["ready", "attached", "detached"].includes(current.status)
  ) {
    if (previousSandboxId && previousSandboxId !== lease.sandboxId) {
      await reconcileCredentialPolicyCleanupBatch(env, commitRevision, session.id);
    }
    return provisioned;
  }
  await stageFailedManagedSandboxProvision(
    env,
    session.id,
    fence,
    "interactive provision failed: managed session ownership changed",
    finishedAt,
  );
  return failedProvision("interactive provision failed: managed session ownership changed");
}

async function provisionStandaloneSandbox(
  env: RuntimeEnv,
  payload: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  if (managedInteractiveSessionId(payload.id)) {
    return failedProvision(
      "interactive provision failed: standalone provision id uses the managed session namespace",
    );
  }
  const { githubToken: _githubToken, ...ownershipPayload } = payload;
  const requestHash = await sha256(JSON.stringify(ownershipPayload));
  const db = database(env);
  const now = Date.now();
  let previous = await db
    .selectFrom("standalone_sandbox_provisions")
    .selectAll()
    .where("id", "=", payload.id)
    .executeTakeFirst();
  if (previous && previous.request_hash !== requestHash) {
    return failedProvision("interactive provision failed: provision id is already registered");
  }
  if (previous?.state === "active") {
    if (!previous.expires_at || previous.expires_at <= Date.now()) {
      await stageStandaloneSandboxProvisionCleanup(
        env,
        previous,
        "standalone Sandbox provision expired",
        Date.now(),
      );
      await reconcileCredentialPolicyCleanupBatch(env, Date.now(), payload.id);
      return failedProvision("interactive provision failed: standalone Sandbox provision expired");
    }
    return {
      status: "ready",
      leaseId: previous.lease_id,
      attachUrl: previous.attach_url,
      vncUrl: previous.vnc_url,
      expiresAt: previous.expires_at,
      expiresAtPresent: true,
      message: previous.message,
    };
  }
  if (previous?.state === "cleanup_pending") {
    return failedProvision("interactive provision failed: previous credential cleanup is pending");
  }
  if (
    previous?.state === "provisioning" &&
    (previous.ownership_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now
  ) {
    const staged = await stageStandaloneSandboxProvisionCleanup(
      env,
      previous,
      "abandoned standalone Sandbox provision cleanup",
      now,
    );
    if (!staged) {
      return failedProvision("interactive provision failed: standalone ownership changed");
    }
    await reconcileCredentialPolicyCleanupBatch(env, now, payload.id);
    previous = await db
      .selectFrom("standalone_sandbox_provisions")
      .selectAll()
      .where("id", "=", payload.id)
      .executeTakeFirst();
    if (previous) {
      return failedProvision(
        "interactive provision failed: previous credential cleanup is pending",
      );
    }
  }

  const expiresAt =
    now +
    clampedSeconds(env.CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS, standaloneSandboxDefaultTtlSeconds) *
      1000;
  const lease = newSandboxLease(payload.id);
  const claim = `standalone:${crypto.randomUUID()}`;
  await sql`
    INSERT INTO standalone_sandbox_provisions (
      id,
      request_hash,
      sandbox_id,
      state,
      ownership_claim,
      ownership_claim_expires_at,
      lease_id,
      attach_url,
      vnc_url,
      expires_at,
      message,
      created_at,
      updated_at
    ) VALUES (
      ${payload.id},
      ${requestHash},
      ${lease.sandboxId},
      'provisioning',
      ${claim},
      ${now + credentialPolicyProvisioningStaleMs},
      ${sandboxLeaseId(lease)},
      NULL,
      NULL,
      ${expiresAt},
      'standalone Sandbox provision started',
      ${now},
      ${now}
    )
    ON CONFLICT(id) DO UPDATE SET
      sandbox_id = excluded.sandbox_id,
      ownership_claim = excluded.ownership_claim,
      ownership_claim_expires_at = excluded.ownership_claim_expires_at,
      lease_id = excluded.lease_id,
      attach_url = NULL,
      vnc_url = NULL,
      expires_at = excluded.expires_at,
      message = excluded.message,
      updated_at = excluded.updated_at
    WHERE standalone_sandbox_provisions.request_hash = excluded.request_hash
      AND standalone_sandbox_provisions.state = 'provisioning'
      AND standalone_sandbox_provisions.ownership_claim_expires_at <= ${now}
  `.execute(db);
  const ownership = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["sandbox_id", "state", "ownership_claim", "ownership_claim_expires_at", "expires_at"])
    .where("id", "=", payload.id)
    .executeTakeFirst();
  if (
    ownership?.sandbox_id !== lease.sandboxId ||
    ownership.state !== "provisioning" ||
    ownership.ownership_claim !== claim ||
    (ownership.ownership_claim_expires_at ?? 0) <= now ||
    ownership.expires_at !== expiresAt
  ) {
    return failedProvision("interactive provision failed: provision id is already in progress");
  }
  if (previous?.sandbox_id && previous.sandbox_id !== lease.sandboxId) {
    await queueSandboxCredentialPolicyCleanup(env, payload.id, previous.sandbox_id, now);
  }
  const fence: StandaloneSandboxProvisionFence = {
    claim,
    provisionId: payload.id,
    sandboxId: lease.sandboxId,
  };
  const result = await provisionWithSandbox(env, payload, undefined, lease, fence);
  const finishedAt = Date.now();
  if (result.status !== "ready") {
    await db
      .updateTable("standalone_sandbox_provisions")
      .set({
        state: "cleanup_pending",
        ownership_claim: null,
        ownership_claim_expires_at: null,
        message: result.message,
        updated_at: finishedAt,
      })
      .where("id", "=", payload.id)
      .where("sandbox_id", "=", lease.sandboxId)
      .where("ownership_claim", "=", claim)
      .where("expires_at", "=", expiresAt)
      .execute();
    await queueSandboxCredentialPolicyCleanup(env, payload.id, lease.sandboxId, finishedAt);
    await reconcileCredentialPolicyCleanupBatch(env, finishedAt, payload.id);
    return result;
  }
  const policyGeneration = await activeSandboxCredentialPolicyGeneration(
    env,
    payload.id,
    lease.sandboxId,
  );
  const activationVersion = Math.max(Date.now(), finishedAt + 1);
  if (policyGeneration) {
    const ownerStillClaimed = sql<boolean>`EXISTS (
      SELECT 1
      FROM standalone_sandbox_provisions AS owner
      WHERE owner.id = ${payload.id}
        AND owner.sandbox_id = ${lease.sandboxId}
        AND owner.state = 'provisioning'
        AND owner.ownership_claim = ${claim}
        AND owner.ownership_claim_expires_at > ${activationVersion}
        AND owner.expires_at = ${expiresAt}
        AND owner.expires_at > ${activationVersion}
    )`;
    await executeBatch(env, [
      db
        .updateTable("interactive_session_credential_policies")
        .set({ updated_at: activationVersion })
        .where("session_id", "=", payload.id)
        .where("sandbox_id", "=", lease.sandboxId)
        .where("state", "=", "active")
        .where("registration_generation", "=", policyGeneration)
        .where("registration_claim", "is", null)
        .where(ownerStillClaimed),
      db
        .updateTable("standalone_sandbox_provisions")
        .set({
          state: "active",
          ownership_claim: null,
          ownership_claim_expires_at: null,
          lease_id: result.leaseId,
          attach_url: result.attachUrl,
          vnc_url: result.vncUrl,
          message: result.message,
          updated_at: activationVersion,
        })
        .where("id", "=", payload.id)
        .where("sandbox_id", "=", lease.sandboxId)
        .where("state", "=", "provisioning")
        .where("ownership_claim", "=", claim)
        .where("ownership_claim_expires_at", ">", activationVersion)
        .where("expires_at", "=", expiresAt)
        .where("expires_at", ">", activationVersion)
        .where(
          activeSandboxCredentialPolicyCondition(
            env,
            payload.id,
            lease.sandboxId,
            policyGeneration,
            activationVersion,
          ),
        ),
    ]);
  }
  const activated = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "sandbox_id", "lease_id", "expires_at"])
    .where("id", "=", payload.id)
    .executeTakeFirst();
  if (
    activated?.state !== "active" ||
    activated.sandbox_id !== lease.sandboxId ||
    activated.lease_id !== result.leaseId ||
    activated.expires_at !== expiresAt
  ) {
    await db
      .updateTable("standalone_sandbox_provisions")
      .set({
        state: "cleanup_pending",
        ownership_claim: null,
        ownership_claim_expires_at: null,
        message: "standalone ownership claim expired",
        updated_at: finishedAt,
      })
      .where("id", "=", payload.id)
      .where("sandbox_id", "=", lease.sandboxId)
      .where("ownership_claim", "=", claim)
      .where("expires_at", "=", expiresAt)
      .execute();
    await queueSandboxCredentialPolicyCleanup(env, payload.id, lease.sandboxId, finishedAt);
    await reconcileCredentialPolicyCleanupBatch(env, finishedAt, payload.id);
    return failedProvision("interactive provision failed: standalone ownership claim expired");
  }
  return { ...result, expiresAt, expiresAtPresent: true };
}

function managedInteractiveSessionId(id: string): boolean {
  return /^is-[0-9]+$/i.test(id);
}

async function stageStandaloneSandboxProvisionCleanup(
  env: RuntimeEnv,
  owner: Selectable<StandaloneSandboxProvisionTable>,
  message: string,
  now: number,
): Promise<boolean> {
  if (owner.state === "cleanup_pending") return true;
  const db = database(env);
  const transitionRevision = Math.max(now, owner.updated_at + 1);
  const generation = await sandboxCredentialPolicyGeneration(env, owner.id, owner.sandbox_id);
  let ownerTransition = db
    .updateTable("standalone_sandbox_provisions")
    .set({
      state: "cleanup_pending",
      ownership_claim: null,
      ownership_claim_expires_at: null,
      attach_url: null,
      vnc_url: null,
      message,
      updated_at: transitionRevision,
    })
    .where("id", "=", owner.id)
    .where("request_hash", "=", owner.request_hash)
    .where("sandbox_id", "=", owner.sandbox_id)
    .where("state", "=", owner.state)
    .where("updated_at", "=", owner.updated_at);
  ownerTransition = owner.ownership_claim
    ? ownerTransition.where("ownership_claim", "=", owner.ownership_claim)
    : ownerTransition.where("ownership_claim", "is", null);
  ownerTransition =
    owner.ownership_claim_expires_at === null
      ? ownerTransition.where("ownership_claim_expires_at", "is", null)
      : ownerTransition.where("ownership_claim_expires_at", "=", owner.ownership_claim_expires_at);
  ownerTransition = owner.lease_id
    ? ownerTransition.where("lease_id", "=", owner.lease_id)
    : ownerTransition.where("lease_id", "is", null);
  ownerTransition =
    owner.expires_at === null
      ? ownerTransition.where("expires_at", "is", null)
      : ownerTransition.where("expires_at", "=", owner.expires_at);
  const cleanupAuthorized = sandboxCredentialPolicyCleanupAuthorizedCondition(
    owner.id,
    owner.sandbox_id,
    transitionRevision,
  );
  await executeBatch(env, [
    ownerTransition,
    ...sandboxCredentialPolicyRefQueries(
      env,
      owner.id,
      owner.sandbox_id,
      "cleanup_pending",
      generation,
      transitionRevision,
      cleanupAuthorized,
    ),
    db
      .updateTable("interactive_session_credential_policies")
      .set({ state: "cleanup_pending", updated_at: transitionRevision })
      .where("session_id", "=", owner.id)
      .where("sandbox_id", "=", owner.sandbox_id)
      .where(cleanupAuthorized),
  ]);
  const staged = await db
    .selectFrom("standalone_sandbox_provisions")
    .select(["state", "sandbox_id", "updated_at"])
    .where("id", "=", owner.id)
    .executeTakeFirst();
  return Boolean(
    staged?.state === "cleanup_pending" &&
    staged.sandbox_id === owner.sandbox_id &&
    staged.updated_at === transitionRevision,
  );
}

async function expireStandaloneSandboxProvisions(
  env: RuntimeEnv,
  now: number,
  provisionId?: string,
): Promise<void> {
  const idFilter = provisionId ? sql`AND id = ${provisionId}` : sql``;
  const result = await sql<Selectable<StandaloneSandboxProvisionTable>>`
    SELECT *
    FROM standalone_sandbox_provisions
    WHERE (
      (state = 'active' AND (expires_at IS NULL OR expires_at <= ${now}))
      OR (
        state = 'provisioning'
        AND (
          expires_at IS NULL
          OR expires_at <= ${now}
          OR ownership_claim_expires_at IS NULL
          OR ownership_claim_expires_at <= ${now}
        )
      )
      OR (
        state = 'active'
        AND lower(id) GLOB 'is-[0-9]*'
        AND substr(lower(id), 4) NOT GLOB '*[^0-9]*'
      )
    )
    ${idFilter}
    ORDER BY COALESCE(expires_at, 0) ASC, updated_at ASC, id ASC
    LIMIT ${credentialPolicyCleanupLimit}
  `.execute(database(env));
  await mapWithConcurrency(result.rows, 3, async (owner) => {
    await stageStandaloneSandboxProvisionCleanup(
      env,
      owner,
      managedInteractiveSessionId(owner.id)
        ? "standalone provision used the reserved managed session namespace"
        : "standalone Sandbox provision expired",
      now,
    );
  });
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
  authorizeProvisionEndpoint(request, env);
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
    managedInteractiveSessionId(provisionId)
  ) {
    if (owner) {
      const now = Date.now();
      await stageStandaloneSandboxProvisionCleanup(
        env,
        owner,
        managedInteractiveSessionId(provisionId)
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
  bridgeWebSockets(
    server,
    response.webSocket,
    terminalGrant,
    undefined,
    "standalone Sandbox authorization revoked or expired",
  );
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

function isBuiltInInteractiveProvisionUrl(env: RuntimeEnv, value: string): boolean {
  if (value === "/api/provision/interactive") return true;
  try {
    const url = new URL(value);
    return (
      url.pathname === "/api/provision/interactive" &&
      (url.hostname === new URL(deploymentConfig(env).canonicalUrl).hostname ||
        url.hostname === appCanonicalHost ||
        appRedirectHosts.has(url.hostname))
    );
  } catch {
    return false;
  }
}

async function provisionInteractivePayload(
  env: RuntimeEnv,
  payload: InteractiveProvisionRequest,
  _agentToken?: string,
): Promise<InteractiveProvisionResult> {
  if (payload.runtime === "container" && env.SANDBOX) {
    return failedProvision("Cloudflare Sandbox provision requires durable ownership");
  }
  if (runtimeAdapterConfigurationPresent(env)) {
    return failedProvision(
      "versioned runtime adapter requires a durable interactive session lifecycle",
    );
  }
  if (env.CRABBOX_RUNTIME_PROVISION_URL) {
    return forwardRuntimeProvision(env, payload);
  }
  if (payload.runtime === "container" && env.CRABBOX_CLOUDFLARE_RUNNER_URL) {
    return provisionWithCloudflareRunner(env, payload);
  }
  if (payload.runtime === "crabbox" && env.CRABBOX_CLAWFLEET_URL) {
    return provisionWithClawFleet(env, payload);
  }
  return {
    status: "pending_adapter",
    leaseId: null,
    attachUrl: null,
    attachUrlPresent: true,
    vncUrl: null,
    message: "provision route live; runtime backend not configured",
  };
}

function authorizeProvisionEndpoint(request: Request, env: RuntimeEnv): void {
  const hasBackend = Boolean(
    env.SANDBOX ||
    runtimeAdapterConfigurationPresent(env) ||
    env.CRABBOX_RUNTIME_PROVISION_URL ||
    env.CRABBOX_CLOUDFLARE_RUNNER_URL ||
    env.CRABBOX_CLAWFLEET_URL,
  );
  if (!env.CRABBOX_INTERACTIVE_PROVISION_TOKEN) {
    if (hasBackend) {
      throw serviceUnavailable("interactive provision token is not configured");
    }
    return;
  }
  authorizeProvisionBearerToken(request, env);
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

function sandboxManagedOwnershipCondition(
  ownershipFence: SandboxManagedOwnershipFence,
  now: number,
): RawBuilder<boolean> {
  if ("leaseId" in ownershipFence) {
    return sql<boolean>`
      lease_id = ${ownershipFence.leaseId}
      AND sandbox_refresh_sandbox_id IS NULL
      AND sandbox_refresh_claim IS NULL
      AND sandbox_refresh_claim_expires_at IS NULL
    `;
  }
  return sql<boolean>`
    lease_id IS ${ownershipFence.refreshLeaseId}
    AND sandbox_refresh_sandbox_id = ${ownershipFence.sandboxId}
    AND sandbox_refresh_claim = ${ownershipFence.claim}
    AND sandbox_refresh_claim_expires_at > ${now}
  `;
}

function sandboxManagedStoredOwnershipCondition(
  ownershipFence: SandboxManagedOwnershipFence,
): RawBuilder<boolean> {
  if ("leaseId" in ownershipFence) {
    return sql<boolean>`
      lease_id = ${ownershipFence.leaseId}
      AND sandbox_refresh_sandbox_id IS NULL
      AND sandbox_refresh_claim IS NULL
      AND sandbox_refresh_claim_expires_at IS NULL
    `;
  }
  return sql<boolean>`
    lease_id IS ${ownershipFence.refreshLeaseId}
    AND sandbox_refresh_sandbox_id = ${ownershipFence.sandboxId}
    AND sandbox_refresh_claim = ${ownershipFence.claim}
    AND sandbox_refresh_claim_expires_at = ${ownershipFence.expiresAt}
  `;
}

function sandboxCredentialPolicyOwnerCondition(
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now: number,
): RawBuilder<boolean> {
  if ("provisionId" in ownershipFence) {
    return sql<boolean>`EXISTS (
      SELECT 1
      FROM standalone_sandbox_provisions AS owner
      WHERE owner.id = ${sessionId}
        AND owner.id = ${ownershipFence.provisionId}
        AND owner.sandbox_id = ${sandboxId}
        AND owner.sandbox_id = ${ownershipFence.sandboxId}
        AND owner.state = 'provisioning'
        AND owner.ownership_claim = ${ownershipFence.claim}
        AND owner.ownership_claim_expires_at > ${now}
    )`;
  }
  return sql<boolean>`EXISTS (
    SELECT 1
    FROM interactive_sessions
    WHERE id = ${sessionId}
      AND ${sandboxId} = ${ownershipFence.sandboxId}
      AND (adapter IS NULL OR adapter != ${runtimeAdapterName})
      AND status IN ('provisioning', 'pending_adapter', 'ready', 'attached', 'detached')
      AND credential_cleanup_terminal_status IS NULL
      AND agent_token_hash IS NOT NULL
      AND ${sandboxManagedOwnershipCondition(ownershipFence, now)}
  )`;
}

function sandboxCredentialPolicyRegistrationQueries(
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  registrationExpiresAt: number,
  now: number,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): CompilableQuery[] {
  return registration.lookupIds.map(
    (lookupId) => sql`
      INSERT INTO interactive_session_credential_policies (
        session_id,
        sandbox_id,
        lookup_id,
        state,
        registration_generation,
        registration_claim,
        registration_claim_expires_at,
        attempt_count,
        last_attempt_at,
        last_error,
        cleanup_claim,
        cleanup_claim_expires_at,
        created_at,
        updated_at
      )
      SELECT
        ${sessionId},
        ${sandboxId},
        ${lookupId},
        'registering',
        ${registration.generation},
        ${registration.claim},
        ${registrationExpiresAt},
        0,
        NULL,
        NULL,
        NULL,
        NULL,
        ${now},
        ${now}
      WHERE ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
      ON CONFLICT(session_id, sandbox_id, lookup_id) DO UPDATE SET
        state = 'registering',
        registration_generation = excluded.registration_generation,
        registration_claim = excluded.registration_claim,
        registration_claim_expires_at = excluded.registration_claim_expires_at,
        last_error = NULL,
        cleanup_claim = NULL,
        cleanup_claim_expires_at = NULL,
        updated_at = excluded.updated_at
      WHERE interactive_session_credential_policies.state != 'cleanup_pending'
        AND (
          interactive_session_credential_policies.registration_claim IS NULL
          OR interactive_session_credential_policies.registration_claim_expires_at <= ${now}
        )
        AND ${sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now)}
    `,
  );
}

async function beginSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<SandboxCredentialPolicyRegistration> {
  const db = database(env);
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const existing = await db
    .selectFrom("interactive_session_credential_policies")
    .select("registration_generation")
    .distinct()
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  if (existing.length > 1) {
    throw new Error("sandbox credential policy generations are inconsistent");
  }
  const registration = {
    generation: existing[0]?.registration_generation ?? `generation:${crypto.randomUUID()}`,
    claim: `registration:${crypto.randomUUID()}`,
    lookupIds,
  };
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  await executeBatch(
    env,
    sandboxCredentialPolicyRegistrationQueries(
      sessionId,
      sandboxId,
      registration,
      registrationExpiresAt,
      now,
      ownershipFence,
    ),
  );
  const claimed = await db
    .selectFrom("interactive_session_credential_policies")
    .select([
      "lookup_id",
      "state",
      "registration_generation",
      "registration_claim",
      "registration_claim_expires_at",
    ])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  if (
    claimed.length !== lookupIds.length ||
    claimed.some(
      (row) =>
        row.state !== "registering" ||
        row.registration_generation !== registration.generation ||
        row.registration_claim !== registration.claim ||
        row.registration_claim_expires_at !== registrationExpiresAt,
    )
  ) {
    await abandonSandboxCredentialPolicyRegistration(
      env,
      sessionId,
      sandboxId,
      registration,
      "sandbox credential policy registration claim was not acquired",
    );
    throw new Error("sandbox credential policy registration is unavailable");
  }
  return registration;
}

async function beginLegacySandboxCredentialPolicyRepair(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  ownershipFence: SandboxCurrentLeaseFence,
): Promise<SandboxCredentialPolicyRegistration> {
  const db = database(env);
  const lookupIds = sandboxLookupIds(env, sandboxId);
  const existing = await db
    .selectFrom("interactive_session_credential_policies")
    .select(["registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .execute();
  const generations = [...new Set(existing.map((row) => row.registration_generation))];
  const existingGeneration = generations[0];
  if (!existingGeneration || generations.length !== 1) {
    throw new Error("legacy sandbox credential policy generations are inconsistent");
  }
  const resuming = existing.some((row) =>
    row.registration_claim?.startsWith(credentialPolicyLegacyRepairClaimPrefix),
  );
  if (!existingGeneration?.startsWith(credentialPolicyLegacyGenerationPrefix) && !resuming) {
    throw new Error("legacy sandbox credential policy repair is not pending");
  }
  const registration: SandboxCredentialPolicyRegistration = {
    generation: existingGeneration.startsWith(credentialPolicyLegacyGenerationPrefix)
      ? `generation:${crypto.randomUUID()}`
      : existingGeneration,
    claim: `${credentialPolicyLegacyRepairClaimPrefix}${crypto.randomUUID()}`,
    lookupIds,
  };
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  await executeBatch(
    env,
    sandboxCredentialPolicyRegistrationQueries(
      sessionId,
      sandboxId,
      registration,
      registrationExpiresAt,
      now,
      ownershipFence,
    ),
  );
  const claimed = await db
    .selectFrom("interactive_session_credential_policies")
    .select([
      "lookup_id",
      "state",
      "registration_generation",
      "registration_claim",
      "registration_claim_expires_at",
    ])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  if (
    claimed.length !== lookupIds.length ||
    claimed.some(
      (row) =>
        row.state !== "registering" ||
        row.registration_generation !== registration.generation ||
        row.registration_claim !== registration.claim ||
        row.registration_claim_expires_at !== registrationExpiresAt,
    )
  ) {
    throw new Error("legacy sandbox credential policy repair claim was not acquired");
  }
  return registration;
}

async function repairLegacySandboxCredentialPolicy(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub || !env.SANDBOX) {
    throw new Error("legacy sandbox credential policy repair is unavailable");
  }
  const session = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();
  if (!session?.lease_id) {
    throw new Error("legacy sandbox credential policy owner is unavailable");
  }
  const lease = sandboxLeaseInfo({
    id: session.id,
    adapter: session.adapter,
    leaseId: session.lease_id,
  });
  if (lease.sandboxId !== sandboxId) {
    throw new Error("legacy sandbox credential policy lease does not match");
  }
  const ownership: SandboxCurrentLeaseFence = { leaseId: session.lease_id, sandboxId };
  const registration = await beginLegacySandboxCredentialPolicyRepair(
    env,
    sessionId,
    sandboxId,
    ownership,
  );
  try {
    const registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
      env,
      sessionId,
      sandboxId,
      registration,
      ownership,
    );
    if (!registrationExpiresAt) {
      throw new Error("legacy sandbox credential policy repair claim was revoked");
    }
    const response = await stub.fetch(
      "https://crabfleet.internal/api/session-control/migrate-legacy",
      {
        method: "POST",
        body: JSON.stringify({
          generation: registration.generation,
          registrationClaim: registration.claim,
          registrationExpiresAt,
          sandboxIds: registration.lookupIds,
          sessionId,
        } satisfies SandboxCredentialPolicyLegacyMigration),
        headers: { "content-type": "application/json" },
      },
    );
    if (!response.ok) {
      throw new Error("legacy sandbox credential policy repair failed");
    }
    if (
      !(await finishSandboxCredentialPolicyRegistration(
        env,
        sessionId,
        sandboxId,
        registration,
        ownership,
      ))
    ) {
      throw new Error("legacy sandbox credential policy repair lost ownership");
    }
  } catch (error) {
    await database(env)
      .updateTable("interactive_session_credential_policies")
      .set({
        last_error: clean(error instanceof Error ? error.message : String(error), 500),
        updated_at: Date.now(),
      })
      .where("session_id", "=", sessionId)
      .where("sandbox_id", "=", sandboxId)
      .where("registration_generation", "=", registration.generation)
      .where("registration_claim", "=", registration.claim)
      .execute();
    throw error;
  }
}

async function repairLegacySandboxCredentialPolicyBatch(
  env: RuntimeEnv,
  now: number,
  sessionId?: string,
): Promise<void> {
  if (!env.SANDBOX || !env.SESSION_CONTROL) return;
  let query = database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["session_id", "sandbox_id"])
    .select(({ fn }) => fn.min<number>("updated_at").as("repair_updated_at"))
    .where((expression) =>
      expression.or([
        expression.and([
          expression("state", "=", "active"),
          expression(
            "registration_generation",
            "like",
            `${credentialPolicyLegacyGenerationPrefix}%`,
          ),
        ]),
        expression.and([
          expression("state", "=", "registering"),
          expression("registration_claim", "like", `${credentialPolicyLegacyRepairClaimPrefix}%`),
          expression("registration_claim_expires_at", "<=", now),
        ]),
      ]),
    )
    .groupBy(["session_id", "sandbox_id"])
    .orderBy("repair_updated_at", "asc")
    .orderBy("session_id", "asc")
    .orderBy("sandbox_id", "asc")
    .limit(credentialPolicyCleanupLimit);
  if (sessionId) query = query.where("session_id", "=", sessionId);
  const candidates = await query.execute();
  await mapWithConcurrency(candidates, 3, async (candidate) => {
    await repairLegacySandboxCredentialPolicy(
      env,
      candidate.session_id,
      candidate.sandbox_id,
    ).catch((error) => {
      console.error("legacy sandbox credential policy repair failed", error);
    });
  });
}

async function renewSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<number | null> {
  const now = Date.now();
  const registrationExpiresAt = now + credentialPolicyRegistrationClaimMs;
  const renewed = await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      registration_claim_expires_at: registrationExpiresAt,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .executeTakeFirst();
  return Number(renewed.numUpdatedRows ?? 0n) === registration.lookupIds.length
    ? registrationExpiresAt
    : null;
}

async function finishSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<boolean> {
  const now = Date.now();
  const db = database(env);
  await db
    .updateTable("interactive_session_credential_policies")
    .set({
      state: "active",
      registration_claim: null,
      registration_claim_expires_at: null,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .where("state", "=", "registering")
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .execute();
  const active = await db
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", registration.lookupIds)
    .execute();
  return (
    active.length === registration.lookupIds.length &&
    active.every(
      (row) =>
        row.state === "active" &&
        row.registration_generation === registration.generation &&
        row.registration_claim === null,
    )
  );
}

async function abandonSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  reason: string,
): Promise<void> {
  const now = Date.now();
  await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      state: sql<"registering" | "cleanup_pending">`CASE
        WHEN ${sandboxCredentialPolicyCleanupAuthorizedCondition(sessionId, sandboxId, now)}
        THEN 'cleanup_pending'
        ELSE 'registering'
      END`,
      registration_claim: null,
      registration_claim_expires_at: null,
      last_error: reason,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("registration_generation", "=", registration.generation)
    .where("registration_claim", "=", registration.claim)
    .execute();
}

async function registerSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) throw new Error("SESSION_CONTROL Durable Object is not configured");
  const policyExpiresAt =
    "provisionId" in ownershipFence
      ? await standaloneSandboxPolicyExpiresAt(env, session.id, sandboxId, ownershipFence)
      : null;
  if ("provisionId" in ownershipFence && !policyExpiresAt) {
    throw new Error("standalone Sandbox credential expiry is unavailable");
  }
  const registration = await beginSandboxCredentialPolicyRegistration(
    env,
    session.id,
    sandboxId,
    ownershipFence,
  );
  try {
    const githubToken = "githubToken" in session ? session.githubToken : undefined;
    const githubTokenCiphertext = githubToken ? await sealSecret(env, githubToken) : null;
    if (githubToken && !githubTokenCiphertext) {
      throw new Error(
        "CRABBOX_TOKEN_ENCRYPTION_KEY or GITHUB_CLIENT_SECRET is required for user GitHub tokens",
      );
    }
    const effectiveGithubToken = githubToken ?? env.GITHUB_TOKEN;
    const githubCredentialSource = githubTokenCiphertext
      ? "session"
      : env.GITHUB_TOKEN
        ? "worker"
        : "none";
    const githubRepoNodeId = effectiveGithubToken
      ? await fetchGithubRepoNodeId(session.repo, effectiveGithubToken)
      : null;
    const policy: SandboxCredentialPolicy = {
      allowedHosts: sandboxBackupAllowedHosts(env),
      ...(policyExpiresAt ? { expiresAt: policyExpiresAt } : {}),
      githubCredentialSource,
      githubRepo: session.repo,
      owner: session.owner,
      sandboxId,
      sessionId: session.id,
      ...(githubRepoNodeId ? { githubRepoNodeId } : {}),
      ...(githubTokenCiphertext ? { githubTokenCiphertext } : {}),
      ...(env.OPENAI_BASE_URL ? { openAIBaseUrl: env.OPENAI_BASE_URL } : {}),
      ...(env.OPENAI_ORG_ID ? { openAIOrgId: env.OPENAI_ORG_ID } : {}),
    };
    for (const lookupId of registration.lookupIds) {
      const registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
        env,
        session.id,
        sandboxId,
        registration,
        ownershipFence,
      );
      if (!registrationExpiresAt) {
        throw new Error("sandbox credential policy registration claim was revoked");
      }
      const response = await stub.fetch("https://crabfleet.internal/api/session-control/register", {
        method: "POST",
        body: JSON.stringify({
          generation: registration.generation,
          registrationClaim: registration.claim,
          registrationExpiresAt,
          policy: { ...policy, sandboxId: lookupId },
        } satisfies StoredSandboxCredentialPolicy),
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        throw new Error("sandbox credential policy registration failed");
      }
    }
    if (
      !(await finishSandboxCredentialPolicyRegistration(
        env,
        session.id,
        sandboxId,
        registration,
        ownershipFence,
      ))
    ) {
      throw new Error("sandbox credential policy cleanup became pending during registration");
    }
  } catch (error) {
    await abandonSandboxCredentialPolicyRegistration(
      env,
      session.id,
      sandboxId,
      registration,
      clean(error instanceof Error ? error.message : String(error), 500),
    ).catch(() => undefined);
    throw error;
  }
}

async function standaloneSandboxPolicyExpiresAt(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  fence: StandaloneSandboxProvisionFence,
): Promise<number | null> {
  const now = Date.now();
  const owner = await database(env)
    .selectFrom("standalone_sandbox_provisions")
    .select("expires_at")
    .where("id", "=", sessionId)
    .where("id", "=", fence.provisionId)
    .where("sandbox_id", "=", sandboxId)
    .where("sandbox_id", "=", fence.sandboxId)
    .where("state", "=", "provisioning")
    .where("ownership_claim", "=", fence.claim)
    .where("ownership_claim_expires_at", ">", now)
    .where("expires_at", ">", now)
    .executeTakeFirst();
  return owner?.expires_at ?? null;
}

async function ensureSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  sandboxId: string,
): Promise<void> {
  const leaseId = session.leaseId;
  if (!leaseId || !leaseId.startsWith(sandboxLeasePrefix)) {
    throw new Error("sandbox credential policy requires a current durable lease");
  }
  const lease = sandboxLeaseInfo(session);
  if (lease.sandboxId !== sandboxId) {
    throw new Error("sandbox credential policy lease ownership does not match");
  }
  const ownership: SandboxCurrentLeaseFence = { leaseId, sandboxId };
  const hasFreshUserToken = Boolean("githubToken" in session && session.githubToken);
  let generation = await existingSandboxCredentialPolicyGeneration(env, session.id, sandboxId);
  if (generation?.startsWith(credentialPolicyLegacyGenerationPrefix)) {
    await repairLegacySandboxCredentialPolicy(env, session.id, sandboxId);
    if (!hasFreshUserToken) return;
    generation = await existingSandboxCredentialPolicyGeneration(env, session.id, sandboxId);
  }
  if (
    !hasFreshUserToken &&
    generation &&
    (await sandboxCredentialPolicyExists(env, sandboxId, generation))
  ) {
    if (
      !(await recordSandboxCredentialPolicyRefs(
        env,
        session.id,
        sandboxId,
        "active",
        generation,
        ownership,
      ))
    ) {
      throw new Error("sandbox credential policy lifecycle is unavailable");
    }
    return;
  }
  await registerSandboxCredentialPolicy(env, session, sandboxId, ownership);
}

async function recordSandboxCredentialPolicyRefs(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  state: "registering" | "active" | "cleanup_pending",
  generation: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now = Date.now(),
): Promise<boolean> {
  const lookupIds = sandboxLookupIds(env, sandboxId);
  if (state === "active") {
    await promoteSandboxCredentialPolicyRegistration(
      env,
      sessionId,
      sandboxId,
      generation,
      ownershipFence,
      now,
    );
  }
  await executeBatch(
    env,
    sandboxCredentialPolicyRefQueries(
      env,
      sessionId,
      sandboxId,
      state,
      generation,
      now,
      sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now),
    ),
  );
  const refs = await database(env)
    .selectFrom("interactive_session_credential_policies")
    .select(["lookup_id", "state", "registration_generation", "registration_claim"])
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", lookupIds)
    .execute();
  return (
    refs.length === lookupIds.length &&
    refs.every(
      (ref) =>
        ref.state === state &&
        ref.registration_generation === generation &&
        ref.registration_claim === null,
    )
  );
}

async function promoteSandboxCredentialPolicyRegistration(
  env: RuntimeEnv,
  sessionId: string,
  sandboxId: string,
  generation: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  now: number,
): Promise<void> {
  await database(env)
    .updateTable("interactive_session_credential_policies")
    .set({
      state: "active",
      registration_claim: null,
      registration_claim_expires_at: null,
      last_error: null,
      updated_at: now,
    })
    .where("session_id", "=", sessionId)
    .where("sandbox_id", "=", sandboxId)
    .where("lookup_id", "in", sandboxLookupIds(env, sandboxId))
    .where("state", "=", "registering")
    .where("registration_generation", "=", generation)
    .where((expression) =>
      expression.or([
        expression("registration_claim", "is", null),
        expression("registration_claim_expires_at", "<=", now),
      ]),
    )
    .where(sandboxCredentialPolicyOwnerCondition(sessionId, sandboxId, ownershipFence, now))
    .execute();
}

async function sandboxCredentialPolicyExists(
  env: RuntimeEnv,
  sandboxId: string,
  generation: string,
): Promise<boolean> {
  const stub = sandboxControlStub(env);
  if (!stub) return false;
  const responses = await Promise.all(
    sandboxLookupIds(env, sandboxId).map((lookupId) =>
      stub.fetch(
        `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(lookupId)}`,
      ),
    ),
  );
  if (responses.some((response) => !response.ok && response.status !== 404)) {
    throw new Error("sandbox credential policy lookup failed");
  }
  return responses.every(
    (response) =>
      response.ok && response.headers.get("x-crabfleet-policy-generation") === generation,
  );
}

async function fetchGithubRepoNodeId(repo: string, token: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "crabfleet",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub repository metadata lookup failed for ${repo}`);
  }
  const body = (await response.json()) as { node_id?: unknown };
  if (typeof body.node_id !== "string" || !body.node_id) {
    throw new Error(`GitHub repository metadata lookup did not include node_id for ${repo}`);
  }
  return body.node_id;
}

async function githubNodeBelongsToRepo(
  nodeId: string,
  repo: string,
  token: string,
): Promise<boolean> {
  const [owner, name] = repo.toLowerCase().split("/");
  if (!owner || !name) return false;
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    body: JSON.stringify({
      query: `query($id: ID!) {
        node(id: $id) {
          __typename
          ... on Repository {
            owner { login }
            name
          }
          ... on RepositoryNode {
            repository { owner { login } name }
          }
        }
      }`,
      variables: { id: nodeId },
    }),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "crabfleet",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) return false;
  const body = (await response.json().catch(() => null)) as {
    data?: {
      node?: {
        name?: unknown;
        owner?: { login?: unknown };
        repository?: { name?: unknown; owner?: { login?: unknown } };
      };
    };
    errors?: unknown;
  } | null;
  if (!body || body.errors) return false;
  const node = body.data?.node;
  const repository = node?.repository ?? node;
  return (
    typeof repository?.owner?.login === "string" &&
    typeof repository.name === "string" &&
    repository.owner.login.toLowerCase() === owner &&
    repository.name.toLowerCase() === name
  );
}

function sandboxLookupIds(env: RuntimeEnv, sandboxId: string): string[] {
  const ids = new Set([sandboxId]);
  if (env.SANDBOX) ids.add(env.SANDBOX.idFromName(sandboxId).toString());
  return [...ids];
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

async function prepareSandboxWorkspace(
  sandbox: SandboxSessionTarget,
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  workdir: string,
): Promise<void> {
  const repoUrl = `https://github.com/${session.repo}.git`;
  const quotedRepoUrl = shellQuote(repoUrl);
  const quotedBranch = shellQuote(session.branch);
  const quotedWorkdir = shellQuote(workdir);
  const quotedPrompt = shellQuote(session.prompt);
  const checkoutErrorPath = sandboxCheckoutErrorPath(session.id);
  const quotedCheckoutErrorPath = shellQuote(checkoutErrorPath);
  const resetResult = await sandbox.exec(
    [
      `if [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  rm -rf ${quotedWorkdir}`,
      `  mkdir -p ${quotedWorkdir}`,
      `fi`,
      `rm -f ${quotedCheckoutErrorPath}`,
    ].join("\n"),
    { timeout: 30_000 },
  );
  if (!resetResult.success) {
    throw new Error(
      clean(resetResult.stderr || resetResult.stdout || "workspace reset failed", 500),
    );
  }

  const result = await sandbox.exec(
    [
      "checkout_status=0",
      "cat > /tmp/crabbox-git-askpass-placeholder.sh <<'EOF'",
      "#!/bin/sh",
      'case "$1" in',
      "  *Username*) printf '%s\\n' x-access-token ;;",
      `  *Password*) printf '%s\\n' ${shellQuote(sandboxPlaceholderGitHubToken)} ;;`,
      "  *) exit 1 ;;",
      "esac",
      "EOF",
      "chmod 700 /tmp/crabbox-git-askpass-placeholder.sh",
      "git_with_github_auth() {",
      `  GIT_TERMINAL_PROMPT=0 GIT_USERNAME=x-access-token GIT_PASSWORD=${shellQuote(
        sandboxPlaceholderGitHubToken,
      )} GIT_ASKPASS=${shellQuote("/tmp/crabbox-git-askpass-placeholder.sh")} git -c credential.helper= "$@"`,
      "}",
      `if [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  tmp="${workdir}.clone.$$"`,
      `  rm -rf "$tmp"`,
      `  rm -f ${quotedCheckoutErrorPath}`,
      `  if git_with_github_auth clone --depth 1 --branch ${quotedBranch} ${quotedRepoUrl} "$tmp" 2>/tmp/crabbox-git-clone.log || git_with_github_auth clone --depth 1 ${quotedRepoUrl} "$tmp" 2>>/tmp/crabbox-git-clone.log; then`,
      `    if rm -rf ${quotedWorkdir} && mkdir -p ${quotedWorkdir} && cp -a "$tmp"/. ${quotedWorkdir}/; then`,
      `      :`,
      `    else`,
      `      checkout_status=$?`,
      `      printf 'Repository checkout copy failed for %s branch %s.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `    fi`,
      `  else`,
      `    printf 'Repository checkout failed for %s branch %s. See /tmp/crabbox-git-clone.log.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `    cat /tmp/crabbox-git-clone.log >> ${quotedCheckoutErrorPath} || true`,
      `    checkout_status=70`,
      `  fi`,
      `  rm -rf "$tmp"`,
      "fi",
      `if [ "$checkout_status" -eq 0 ] && [ ! -d ${quotedWorkdir}/.git ]; then`,
      `  if [ ! -s ${quotedCheckoutErrorPath} ]; then`,
      `    printf 'Repository checkout failed for %s branch %s.\\n' ${quotedRepoUrl} ${quotedBranch} > ${quotedCheckoutErrorPath}`,
      `  fi`,
      `  checkout_status=70`,
      `fi`,
      `if [ "$checkout_status" -eq 0 ]; then`,
      `  rm -f ${quotedCheckoutErrorPath}`,
      `  cd ${quotedWorkdir} || checkout_status=$?`,
      `fi`,
      `if [ "$checkout_status" -eq 0 ]; then git config --global --add safe.directory ${quotedWorkdir} || true; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git remote set-url origin ${quotedRepoUrl} || true; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git_with_github_auth fetch --depth 1 origin ${quotedBranch} || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git checkout -B ${quotedBranch} FETCH_HEAD || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then git rev-parse --verify HEAD >/dev/null || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then test "$(git rev-parse --abbrev-ref HEAD)" = ${quotedBranch} || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then test "$(git config --get remote.origin.url)" = ${quotedRepoUrl} || checkout_status=$?; fi`,
      quotedPrompt
        ? `if [ "$checkout_status" -eq 0 ]; then printf '%s\n' ${quotedPrompt} > .crabbox-initial-prompt.txt || checkout_status=$?; fi`
        : `if [ "$checkout_status" -eq 0 ]; then rm -f .crabbox-initial-prompt.txt || checkout_status=$?; fi`,
      `if [ "$checkout_status" -eq 0 ]; then`,
      `  printf '\\nCRABBOX_CHECKOUT_OK\\n'`,
      `else`,
      `  if [ -s ${quotedCheckoutErrorPath} ]; then cat ${quotedCheckoutErrorPath}; fi`,
      `  printf '\\nCRABBOX_CHECKOUT_FAILED %s\\n' "$checkout_status"`,
      `fi`,
    ].join("\n"),
    { timeout: 120_000 },
  );
  const checkoutMarker = result.stdout.trim().split(/\r?\n/).at(-1);
  if (!result.success || checkoutMarker !== "CRABBOX_CHECKOUT_OK") {
    throw new Error(
      clean(
        [result.stdout, result.stderr].filter(Boolean).join("\n") || "repository checkout failed",
        700,
      ),
    );
  }
}

async function prepareSandboxCodexAuth(
  sandbox: SandboxSessionTarget,
  env: RuntimeEnv,
  workdir: string,
): Promise<void> {
  const projectKey = JSON.stringify(workdir);
  const workspaceKey = JSON.stringify("/workspace");
  const result = await sandbox.exec(
    `
set -eu
export CODEX_HOME="$HOME/.codex"
mkdir -p "$CODEX_HOME"
cat > "$CODEX_HOME/config.toml" <<'EOF'
cli_auth_credentials_store = "file"
forced_login_method = "api"
preferred_auth_method = "apikey"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[shell_environment_policy]
inherit = "all"
ignore_default_excludes = true

[features]
goals = true

[projects.${projectKey}]
trust_level = "trusted"

[projects.${workspaceKey}]
trust_level = "trusted"
EOF
if command -v node >/dev/null 2>&1; then
  node - <<'NODE'
const fs = require("fs");
const path = require("path");
const home = process.env.CODEX_HOME;
const apiKey = process.env.OPENAI_API_KEY || "";
if (!apiKey) process.exit(0);
fs.writeFileSync(
  path.join(home, "auth.json"),
  JSON.stringify({ OPENAI_API_KEY: apiKey, auth_mode: "apikey" }),
  { mode: 0o600 }
);
NODE
elif command -v codex >/dev/null 2>&1 && [ -n "\${OPENAI_API_KEY:-}" ]; then
  printf '%s' "$OPENAI_API_KEY" | codex -c 'forced_login_method="api"' login --with-api-key >/dev/null 2>&1 || true
fi
`,
    {
      timeout: 60_000,
      env: {
        OPENAI_API_KEY: env.OPENAI_API_KEY ? sandboxPlaceholderOpenAIKey : undefined,
        OPENAI_BASE_URL: env.OPENAI_BASE_URL,
        OPENAI_ORG_ID: env.OPENAI_ORG_ID,
      },
    },
  );
  if (!result.success) {
    throw new Error(clean(result.stderr || result.stdout || "Codex auth setup failed", 700));
  }
}

async function prepareSandboxRuntimeTools(
  sandbox: SandboxSessionTarget,
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  workdir: string,
  commandEnv: Record<string, string | undefined> = {},
  agentToken?: string,
): Promise<void> {
  const autostartScript = sandboxAutostartScriptPath(session.id);
  const terminalShell = sandboxTerminalShellPath(session.id);
  const result = await sandbox.exec(
    `
set -eu
export CODEX_HOME="$HOME/.codex"
missing_tools=""
for tool in git node npm pnpm codex gh rg fd jq python3 make gcc time ssh rsync crabbox; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    missing_tools="$missing_tools $tool"
  fi
done
if [ -n "$missing_tools" ]; then
  printf 'Crabfleet sandbox image is missing required tools:%s\\n' "$missing_tools" >/tmp/crabbox-runtime-tools.log
  if command -v crabbox-diagnostics >/dev/null 2>&1; then
    crabbox-diagnostics >>/tmp/crabbox-runtime-tools.log 2>&1 || true
  fi
  cat /tmp/crabbox-runtime-tools.log
  exit 72
fi
installed_codex="$(npm list -g @openai/codex --depth=0 --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{const v=JSON.parse(s).dependencies?.["@openai/codex"]?.version||""; if (v) console.log(v);}catch{}})' || true)"
latest_codex="$(npm view @openai/codex version 2>/dev/null || true)"
if [ -z "$installed_codex" ] || { [ -n "$latest_codex" ] && [ "$installed_codex" != "$latest_codex" ]; }; then
  if command -v timeout >/dev/null 2>&1; then
    timeout 120s npm install -g @openai/codex@latest >/tmp/crabbox-codex-install.log 2>&1
  else
    npm install -g @openai/codex@latest >/tmp/crabbox-codex-install.log 2>&1
  fi
fi
rm -f "$HOME/.config/crabbox/github-credential" 2>/dev/null || true
rm -rf "$HOME/.config/gh" "$HOME/.local/share/gh" 2>/dev/null || true
git config --global --unset-all credential.helper 2>/dev/null || true
git config --global credential.helper "!f() { test \\"\\$1\\" = get || exit 0; printf 'username=x-access-token\\n'; printf 'password=%s\\n' ${shellQuote(sandboxPlaceholderGitHubToken)}; }; f"
git config --global user.name ${shellQuote(session.owner)}
git config --global user.email ${shellQuote(sandboxGitAuthorEmail(session.owner))}
mkdir -p "$(dirname ${shellQuote(autostartScript)})"
cat > ${shellQuote(autostartScript)} <<'EOF'
export CODEX_HOME="$HOME/.codex"
export GITHUB_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export GH_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export CRABBOX_SESSION_ID=${shellQuote(session.id)}
export CRABFLEET_SESSION_ID=${shellQuote(session.id)}
export CRABFLEET_PARENT_SESSION_ID=${shellQuote(session.parentSessionId ?? "")}
export CRABFLEET_ROOT_SESSION_ID=${shellQuote(session.rootSessionId ?? session.id)}
export CRABFLEET_AGENT_TOKEN=${shellQuote(agentToken ?? "")}
export CRABFLEET_API_URL=${shellQuote(deploymentConfig(env).canonicalUrl)}
export CRABBOX_REPO=${shellQuote(session.repo)}
export CRABBOX_BRANCH=${shellQuote(session.branch)}
export CRABBOX_RUNTIME=${shellQuote(session.runtime)}
export CRABBOX_COMMAND=${shellQuote(session.command)}
export CRABBOX_CHECKOUT_ERROR=${shellQuote(sandboxCheckoutErrorPath(session.id))}
export CRABBOX_WORKDIR=${shellQuote(workdir)}
if [ -z "\${CRABBOX_SHELL_BOOTSTRAPPED:-}" ]; then
  export CRABBOX_SHELL_BOOTSTRAPPED=1
  cd "$CRABBOX_WORKDIR" 2>/dev/null || true
fi
if [ -z "\${CRABBOX_CODEX_AUTOSTART_CHECKED:-}" ]; then
  export CRABBOX_CODEX_AUTOSTART_CHECKED=1
  crabbox_autostart_marker="$HOME/.cache/crabbox/\${CRABBOX_SESSION_ID:-session}.codex-autostarted"
  mkdir -p "$HOME/.cache/crabbox" 2>/dev/null || true
  if [ ! -e "$crabbox_autostart_marker" ]; then
    if [ -s "\${CRABBOX_CHECKOUT_ERROR:-}" ]; then
      printf '\\nCrabfleet repository checkout failed:\\n'
      cat "$CRABBOX_CHECKOUT_ERROR"
      printf '\\n'
    elif [ -n "\${CRABBOX_COMMAND:-}" ]; then
      touch "$crabbox_autostart_marker" 2>/dev/null || true
      (
        cd "$CRABBOX_WORKDIR" 2>/dev/null || {
          printf 'Crabfleet workdir is unavailable: %s\\n' "$CRABBOX_WORKDIR"
          exit 127
        }
        env -u BASH_ENV -u PROMPT_COMMAND /bin/bash -c "$CRABBOX_COMMAND"
      )
    fi
  fi
fi
EOF
marker=${shellQuote(sandboxBashrcMarker(session))}
bashrc_tmp="$HOME/.bashrc.crabbox.$$"
{
  printf '%s\\n' "$marker"
  printf '%s\\n' 'source ${shellQuote(autostartScript)} 2>/dev/null || true'
  if [ -f "$HOME/.bashrc" ]; then
    awk -v marker="$marker" '$0 == marker { getline; next } { print }' "$HOME/.bashrc"
  fi
} > "$bashrc_tmp"
mv "$bashrc_tmp" "$HOME/.bashrc"
cat > ${shellQuote(terminalShell)} <<'EOF'
#!/bin/bash
cd ${shellQuote(workdir)} 2>/dev/null || true
source ${shellQuote(autostartScript)} 2>/dev/null || true
exec /bin/bash -i
EOF
chmod +x ${shellQuote(terminalShell)}
`,
    {
      timeout: 300_000,
      env: commandEnv,
    },
  );
  if (!result.success) {
    throw new Error(clean(result.stderr || result.stdout || "runtime tool setup failed", 700));
  }
}

async function openSandboxTerminalResponse(
  request: Request,
  env: RuntimeEnv,
  sandbox: ReturnType<typeof getSandbox>,
  session: InteractiveSession & { githubToken?: string },
  size: { cols: number; rows: number },
): Promise<Response> {
  const lease = sandboxLeaseInfo(session);
  const options = {
    cols: size.cols,
    rows: size.rows,
    shell: sandboxTerminalShellPath(session.id),
  };
  await ensureSandboxTerminalPrepared(sandbox, env, session, lease.terminalSessionId);
  const open = async () => {
    const terminalSession = await sandbox.getSession(lease.terminalSessionId);
    return terminalSession.terminal(request, options);
  };

  try {
    const response = await open();
    if (response.webSocket && response.status === 101) return response;
  } catch {
    // A previous PTY disconnect can leave the SDK execution session terminated.
  }

  await recreateSandboxTerminalSession(sandbox, env, session, lease.terminalSessionId);
  return open();
}

async function ensureSandboxTerminalPrepared(
  sandbox: ReturnType<typeof getSandbox>,
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  terminalSessionId: string,
): Promise<void> {
  const workdir = sandboxWorkdir(session.id);
  try {
    if (await sandboxTerminalProfileExists(sandbox, env, session, workdir)) return;
    await setupSandboxTerminalSession(sandbox, env, session, workdir, terminalSessionId);
    return;
  } catch {
    // Missing or terminated default shell; recreate the sandbox below.
  }
  await recreateSandboxTerminalSession(sandbox, env, session, terminalSessionId);
}

async function sandboxTerminalProfileExists(
  sandbox: CloudflareSandbox,
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  workdir: string,
): Promise<boolean> {
  const setup = await createSandboxSession(
    sandbox,
    sandboxSetupSessionId(session.id),
    "/workspace",
    {
      CRABBOX_SESSION_ID: session.id,
    },
  );
  const marker = shellQuote(sandboxBashrcMarker(session));
  const autostartScript = sandboxAutostartScriptPath(session.id);
  const terminalShell = sandboxTerminalShellPath(session.id);
  const repoUrl = `https://github.com/${session.repo}.git`;
  const checks = [
    `test -d ${shellQuote(workdir)}`,
    `test -d ${shellQuote(workdir)}/.git`,
    `test ! -s ${shellQuote(sandboxCheckoutErrorPath(session.id))}`,
    `git -C ${shellQuote(workdir)} rev-parse --verify HEAD >/dev/null`,
    `test "$(git -C ${shellQuote(workdir)} rev-parse --abbrev-ref HEAD)" = ${shellQuote(session.branch)}`,
    `test "$(git -C ${shellQuote(workdir)} config --get remote.origin.url)" = ${shellQuote(repoUrl)}`,
    `test -s ${shellQuote(autostartScript)}`,
    `test -x ${shellQuote(terminalShell)}`,
    `grep -Fqx '[shell_environment_policy]' "$HOME/.codex/config.toml"`,
    `grep -Fqx '[projects."/workspace"]' "$HOME/.codex/config.toml"`,
    `node -e 'const fs=require("fs"); const p=process.env.HOME+"/.codex/auth.json"; const auth=JSON.parse(fs.readFileSync(p,"utf8")); process.exit(auth.OPENAI_API_KEY==="crabfleet-worker-injected"?0:1)'`,
    `grep -Fqx '        cd "$CRABBOX_WORKDIR" 2>/dev/null || {' ${shellQuote(autostartScript)}`,
    `grep -Fqx ${marker} "$HOME/.bashrc"`,
    `test ! -e "$HOME/.config/crabbox/github-credential"`,
  ];
  const result = await setup.exec(checks.join(" && "), { timeout: 10_000 });
  return result.success;
}

async function setupSandboxTerminalSession(
  sandbox: CloudflareSandbox,
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  workdir: string,
  terminalSessionId: string,
  agentToken?: string,
): Promise<void> {
  const sessionEnv = sandboxSessionEnv(env, session, agentToken);
  const setup = await createSandboxSession(
    sandbox,
    sandboxSetupSessionId(session.id),
    "/workspace",
    sessionEnv,
  );
  await runSandboxSetupStep("workspace mkdir", () => setup.mkdir(workdir, { recursive: true }));
  await runSandboxSetupStep("repository checkout", () =>
    prepareSandboxWorkspace(setup, env, session, workdir),
  );
  await runSandboxSetupStep("Codex auth", () => prepareSandboxCodexAuth(setup, env, workdir));
  await runSandboxSetupStep("runtime tools", () =>
    prepareSandboxRuntimeTools(setup, env, session, workdir, {}, agentToken),
  );
  await runSandboxSetupStep("terminal session", () =>
    createFreshSandboxSession(sandbox, terminalSessionId, workdir, sessionEnv),
  );
}

async function recreateSandboxTerminalSession(
  sandbox: ReturnType<typeof getSandbox>,
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  terminalSessionId: string,
): Promise<void> {
  await setupSandboxTerminalSession(
    sandbox,
    env,
    session,
    sandboxWorkdir(session.id),
    terminalSessionId,
  );
}

function sandboxSessionEnv(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  agentToken?: string,
): Record<string, string | undefined> {
  return {
    CRABBOX_SESSION_ID: session.id,
    CRABFLEET_SESSION_ID: session.id,
    CRABFLEET_PARENT_SESSION_ID: session.parentSessionId ?? undefined,
    CRABFLEET_ROOT_SESSION_ID: session.rootSessionId ?? session.id,
    CRABFLEET_AGENT_TOKEN: agentToken,
    CRABFLEET_API_URL: deploymentConfig(env).canonicalUrl,
    CRABBOX_REPO: session.repo,
    CRABBOX_BRANCH: session.branch,
    CRABBOX_RUNTIME: session.runtime,
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    GH_TOKEN: sandboxHasGitHubCredential(env, session) ? sandboxPlaceholderGitHubToken : undefined,
    GITHUB_TOKEN: sandboxHasGitHubCredential(env, session)
      ? sandboxPlaceholderGitHubToken
      : undefined,
    TERM_PROGRAM: "ghostty",
    TERM_PROGRAM_VERSION: "web",
    OPENAI_API_KEY: env.OPENAI_API_KEY ? sandboxPlaceholderOpenAIKey : undefined,
    OPENAI_BASE_URL: env.OPENAI_BASE_URL,
    OPENAI_ORG_ID: env.OPENAI_ORG_ID,
  };
}

function sandboxHasGitHubCredential(env: RuntimeEnv, session: SandboxRuntimeSession): boolean {
  return Boolean(("githubToken" in session && session.githubToken) || env.GITHUB_TOKEN);
}

function githubTokenEnv(session: Pick<InteractiveProvisionRequest, "githubToken">): {
  GITHUB_TOKEN?: string;
  GH_TOKEN?: string;
} {
  return session.githubToken
    ? { GITHUB_TOKEN: session.githubToken, GH_TOKEN: session.githubToken }
    : {};
}

async function provisionWithRuntimeAdapter(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  _agentToken?: string,
  reconciliationOwner?: RuntimeAdapterCreateAttemptFence,
): Promise<InteractiveProvisionResult> {
  const replayingPendingCreate = reconciliationOwner !== undefined;
  const namespace = normalizeAdapterNamespace(env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "");
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
  let baseUrl: string;
  try {
    baseUrl = requireRegisteredRuntimeAdapterControlPlane(
      env,
      session.profile,
      session.adapterControlPlane,
    );
  } catch (error) {
    return unresolvedRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      fallbackCapabilities,
      clean(error instanceof Error ? error.message : String(error), 240),
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
      );
    }
    return releaseFailedRuntimeAdapterProvision(
      env,
      session.id,
      runtimeAdapterFailureProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities ?? fallbackCapabilities,
        "runtime adapter provision failed: persisted create settings are incomplete",
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
    session.adapterCreatePayloadJson ?? (generatedPayload ? JSON.stringify(generatedPayload) : ""),
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
      );
    }
    return releaseFailedRuntimeAdapterProvision(
      env,
      session.id,
      runtimeAdapterFailureProvision(
        session,
        adapterWorkspaceId,
        requestedCapabilities,
        "runtime adapter provision failed: persisted create payload is invalid",
      ),
    );
  }
  const createAttempt = await stageRuntimeAdapterProvision(
    env,
    session,
    baseUrl,
    adapterWorkspaceId,
    requestedCapabilities,
    ttlSeconds,
    idleTimeoutSeconds,
    createPayloadJson,
    reconciliationOwner,
  );
  if (!createAttempt) {
    return unresolvedRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      "runtime adapter control-plane registration changed before create",
    );
  }
  let response: Response;
  try {
    response = await runtimeAdapterFetch(env, runtimeAdapterCollectionUrl(baseUrl), {
      method: "POST",
      headers: { "idempotency-key": adapterWorkspaceId },
      body: createPayloadJson,
    });
  } catch (error) {
    return ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      `runtime adapter create outcome unknown: ${safeProviderError(error, [adapterWorkspaceId])}`,
    );
  }
  let responseBody: unknown;
  try {
    responseBody = await readRuntimeAdapterResponseBody(response);
  } catch (error) {
    return ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      `runtime adapter create outcome unknown: ${safeProviderError(error, [adapterWorkspaceId])}`,
    );
  }
  if (!response.ok) {
    const responseMessage = redactedAdapterResponseMessage(
      responseBody,
      `HTTP ${response.status}`,
      [adapterWorkspaceId],
    );
    if (runtimeAdapterWorkspaceIdConflict(response.status, responseBody)) {
      const conflictResult = await failRuntimeAdapterWorkspaceIdConflict(
        env,
        session,
        baseUrl,
        adapterWorkspaceId,
        createPayloadJson,
        requestedCapabilities,
        createAttempt,
        `runtime adapter provision failed: ${responseMessage}`,
      );
      if (conflictResult) return conflictResult;
      throw conflict("runtime adapter workspace conflict response is stale");
    }
    if (!replayingPendingCreate && definitiveRuntimeAdapterCreateFailure(response.status)) {
      return releaseFailedRuntimeAdapterProvision(
        env,
        session.id,
        runtimeAdapterFailureProvision(
          session,
          adapterWorkspaceId,
          requestedCapabilities,
          `runtime adapter provision failed: ${responseMessage}`,
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
    );
  }
  const parsed = parseAdapterWorkspaceResult(responseBody, {
    workspaceId: adapterWorkspaceId,
    profile: session.profile,
  });
  if (!parsed) {
    return ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      "runtime adapter create outcome unknown: invalid workspace response",
    );
  }
  if (!adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
    return ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      "runtime adapter create outcome unknown: workspace identity mismatch",
    );
  }
  if (parsed.profile !== session.profile) {
    return ambiguousRuntimeAdapterProvision(
      session,
      adapterWorkspaceId,
      requestedCapabilities,
      "runtime adapter create outcome unknown: workspace profile mismatch",
    );
  }
  const result = runtimeAdapterProvisionResult(
    parsed,
    session,
    Date.now(),
    adapterWorkspaceId,
    true,
  );
  return result.status === "failed"
    ? releaseFailedRuntimeAdapterProvision(env, session.id, result)
    : result;
}

function persistedRuntimeAdapterSeconds(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

type RuntimeAdapterCreateAttemptFence = {
  status: InteractiveSessionStatus;
  updatedAt: number;
  lastReconciledAt: number | null;
  terminalStatus: "failed" | null;
};

async function stageRuntimeAdapterProvision(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
  adapterControlPlane: string,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  ttlSeconds: number,
  idleTimeoutSeconds: number,
  createPayloadJson: string,
  reconciliationOwner?: RuntimeAdapterCreateAttemptFence,
): Promise<RuntimeAdapterCreateAttemptFence | null> {
  const stageAt = Date.now();
  let stage = database(env)
    .updateTable("interactive_sessions")
    .set({
      adapter: runtimeAdapterName,
      profile: session.profile,
      adapter_workspace_id: adapterWorkspaceId,
      capabilities_json: JSON.stringify(capabilities),
      adapter_ttl_seconds: ttlSeconds,
      adapter_idle_timeout_seconds: idleTimeoutSeconds,
      adapter_requested_capabilities_json: JSON.stringify(capabilities),
      adapter_create_payload_json: createPayloadJson,
      adapter_create_pending: 1,
      reconcile_error: "runtime adapter create pending",
      ...(reconciliationOwner ? {} : { updated_at: sql<number>`MAX(updated_at + 1, ${stageAt})` }),
    })
    .where("id", "=", session.id)
    .where("adapter_control_plane", "=", adapterControlPlane)
    .where("adapter_workspace_id", "=", adapterWorkspaceId);
  if (reconciliationOwner) {
    stage = stage
      .where("status", "=", reconciliationOwner.status)
      .where("updated_at", "=", reconciliationOwner.updatedAt);
    stage =
      reconciliationOwner.lastReconciledAt === null
        ? stage.where("last_reconciled_at", "is", null)
        : stage.where("last_reconciled_at", "=", reconciliationOwner.lastReconciledAt);
    stage =
      reconciliationOwner.terminalStatus === null
        ? stage.where("terminal_status", "is", null)
        : stage.where("terminal_status", "=", reconciliationOwner.terminalStatus);
  } else {
    stage = stage.where("status", "in", ["provisioning", "pending_adapter"]);
  }
  const staged = await stage
    .returning(["status", "updated_at", "last_reconciled_at", "terminal_status"])
    .executeTakeFirst();
  return staged
    ? {
        status: staged.status,
        updatedAt: staged.updated_at,
        lastReconciledAt: staged.last_reconciled_at,
        terminalStatus: staged.terminal_status,
      }
    : null;
}

function ambiguousRuntimeAdapterProvision(
  session: Pick<InteractiveProvisionRequest, "runtime" | "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
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
    reconciledAt: Date.now(),
    reconcileError: message,
    terminalStatus: null,
    createPending: true,
  };
}

function runtimeAdapterFailureProvision(
  session: Pick<InteractiveProvisionRequest, "runtime" | "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
): InteractiveProvisionResult {
  return {
    ...ambiguousRuntimeAdapterProvision(session, adapterWorkspaceId, capabilities, message),
    status: "failed",
    terminalStatus: null,
    createPending: false,
  };
}

function unresolvedRuntimeAdapterProvision(
  session: Pick<InteractiveProvisionRequest, "runtime" | "profile">,
  adapterWorkspaceId: string,
  capabilities: RuntimeCapabilities,
  message: string,
): InteractiveProvisionResult {
  return {
    ...runtimeAdapterFailureProvision(session, adapterWorkspaceId, capabilities, message),
    status: "stopping",
    message: `${message}; runtime workspace outcome unresolved`,
    reconcileError: message,
    terminalStatus: "failed",
    createPending: true,
  };
}

async function failRuntimeAdapterWorkspaceIdConflict(
  env: RuntimeEnv,
  session: Pick<InteractiveProvisionRequest, "id" | "profile">,
  adapterControlPlane: string,
  adapterWorkspaceId: string,
  createPayloadJson: string,
  capabilities: RuntimeCapabilities,
  createAttempt: RuntimeAdapterCreateAttemptFence,
  message: string,
): Promise<InteractiveProvisionResult | null> {
  const now = Date.now();
  const failureMessage = clean(message, 500);
  const lastReconciledOwner =
    createAttempt.lastReconciledAt === null
      ? sql<boolean>`last_reconciled_at IS NULL`
      : sql<boolean>`last_reconciled_at = ${createAttempt.lastReconciledAt}`;
  const terminalStatusOwner =
    createAttempt.terminalStatus === null
      ? sql<boolean>`terminal_status IS NULL`
      : sql<boolean>`terminal_status = ${createAttempt.terminalStatus}`;
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND adapter = ${runtimeAdapterName}
    AND adapter_workspace_id = ${adapterWorkspaceId}
    AND adapter_control_plane = ${adapterControlPlane}
    AND adapter_create_payload_json = ${createPayloadJson}
    AND adapter_requested_capabilities_json = ${JSON.stringify(capabilities)}
    AND adapter_create_pending = 1
    AND status = ${createAttempt.status}
    AND updated_at = ${createAttempt.updatedAt}
    AND ${lastReconciledOwner}
    AND ${terminalStatusOwner}
  `;
  const db = database(env);
  const event = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, 'system', ${failureMessage}, ${now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const detach = db
    .updateTable("interactive_sessions")
    .set({
      status: "failed",
      adapter: null,
      adapter_workspace_id: null,
      adapter_control_plane: null,
      provider_resource_id: null,
      adapter_ttl_seconds: null,
      adapter_idle_timeout_seconds: null,
      adapter_requested_capabilities_json: null,
      adapter_create_payload_json: null,
      adapter_create_pending: 0,
      lease_id: null,
      attach_url: null,
      vnc_url: null,
      expires_at: null,
      last_reconciled_at: now,
      reconcile_error: failureMessage,
      terminal_status: null,
      terminal_failure_reason: failureMessage,
      terminal_finalize_pending: 1,
      stopped_at: now,
      agent_token_hash: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      last_event: failureMessage,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [event, detach].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  if (!results.at(-1)?.results.length) return null;
  await archiveInteractiveSessionLogs(env, session.id, now).catch(() => undefined);
  await finalizeTerminalInteractiveSession(env, session.id, "failed", now).catch(() => undefined);
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    attachUrlPresent: true,
    vncUrl: null,
    message: failureMessage,
    adapter: null,
    profile: session.profile,
    adapterWorkspaceId: null,
    providerResourceId: null,
    capabilities,
    capabilitiesPresent: true,
    expiresAt: null,
    expiresAtPresent: true,
    reconciledAt: now,
    reconcileError: failureMessage,
    terminalStatus: null,
    createPending: false,
  };
}

async function releaseFailedRuntimeAdapterProvision(
  env: RuntimeEnv,
  sessionId: string,
  result: InteractiveProvisionResult,
): Promise<InteractiveProvisionResult> {
  const adapterWorkspaceId = result.adapterWorkspaceId;
  if (!adapterWorkspaceId) return result;
  await stageFailedRuntimeAdapterRelease(env, sessionId, adapterWorkspaceId, result.message);
  try {
    const release = await stopRuntimeAdapterWorkspaceForSession(env, sessionId, adapterWorkspaceId);
    const releaseState = adapterFailureReleaseState(release.status);
    if (release.status === "stopped") {
      await recordConfirmedRuntimeAdapterRelease(
        env,
        sessionId,
        adapterWorkspaceId,
        Date.now(),
        release.message,
      );
    }
    const releaseMessage = `${result.message}; ${release.message}`;
    if (release.status === "stopping") {
      await persistRuntimeAdapterStopEvidence(
        env,
        sessionId,
        adapterWorkspaceId,
        releaseMessage,
        Date.now(),
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
    await persistRuntimeAdapterStopEvidence(
      env,
      sessionId,
      adapterWorkspaceId,
      pendingMessage,
      Date.now(),
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

async function persistRuntimeAdapterStopEvidence(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  message: string,
  now: number,
  reconcileError: string | null = message,
  eventActor = "system",
): Promise<void> {
  const evidence = clean(message, 500);
  const errorEvidence = reconcileError ? clean(reconcileError, 500) : null;
  const actorName = clean(eventActor, 120) || "system";
  const reconcileErrorOwner = errorEvidence
    ? sql<boolean>`reconcile_error = ${errorEvidence}`
    : sql<boolean>`reconcile_error IS NULL`;
  const db = database(env);
  await executeBatch(env, [
    db
      .updateTable("interactive_sessions")
      .set({
        last_reconciled_at: now,
        reconcile_error: errorEvidence,
        last_event: evidence,
        updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      })
      .where("id", "=", sessionId)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .where("status", "=", "stopping").where(sql<boolean>`
        COALESCE(last_event, '') != ${evidence}
        OR COALESCE(reconcile_error, '') != ${errorEvidence ?? ""}
      `),
    sql`
      INSERT INTO interactive_session_events (session_id, actor, message, created_at)
      SELECT ${sessionId}, ${actorName}, ${evidence}, ${now}
      WHERE EXISTS (
        SELECT 1
        FROM interactive_sessions
        WHERE id = ${sessionId}
          AND adapter = ${runtimeAdapterName}
          AND adapter_workspace_id = ${adapterWorkspaceId}
          AND status = 'stopping'
          AND last_event = ${evidence}
          AND ${reconcileErrorOwner}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_events
        WHERE session_id = ${sessionId}
          AND actor = ${actorName}
          AND message = ${evidence}
      )
    `,
  ]);
  await archiveInteractiveSessionLogs(env, sessionId, now).catch(() => undefined);
}

async function stageFailedRuntimeAdapterRelease(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  message: string,
): Promise<void> {
  const now = Date.now();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "stopping",
      lease_id: null,
      attach_url: null,
      vnc_url: null,
      terminal_status: "failed",
      terminal_failure_reason: message,
      adapter_create_pending: 0,
      last_reconciled_at: now,
      reconcile_error: message,
      agent_token_hash: null,
      controller: null,
      control_requested_by: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      last_event: `${message}; runtime workspace release pending`,
    })
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("status", "in", [
      "provisioning",
      "pending_adapter",
      "ready",
      "attached",
      "detached",
      "stopping",
    ])
    .execute();
}

function runtimeAdapterProvisionResult(
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
    // Desktop access is minted only after Crabfleet authenticates the viewer.
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

function runtimeAdapterRecord(session: InteractiveSessionRow): AdapterProvisionRecord {
  if (session.runtime === githubActionsRuntime) {
    throw new Error("GitHub Actions sessions cannot use the runtime adapter");
  }
  return { ...session, runtime: session.runtime };
}

async function inspectRuntimeAdapterWorkspace(
  env: RuntimeEnv,
  session: InteractiveSessionRow,
  reconciliationClaimAt: number,
): Promise<InteractiveProvisionResult> {
  const adapterWorkspaceId = session.adapter_workspace_id;
  const providerResourceId = session.provider_resource_id;
  if (!adapterWorkspaceId) {
    throw new Error("runtime adapter workspace reference is incomplete");
  }
  const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
    env,
    session.profile,
    session.adapter_control_plane,
  );
  if (session.status === "stopping") {
    return reconcileStoppingRuntimeAdapterWorkspace(env, session, reconciliationClaimAt);
  }
  if (shouldReplayRuntimeAdapterCreate(session.status, session.adapter_create_pending === 1)) {
    return provisionWithRuntimeAdapter(
      env,
      runtimeAdapterReplayRequest(runtimeAdapterRecord(session)),
      undefined,
      {
        status: session.status,
        updatedAt: session.updated_at,
        lastReconciledAt: reconciliationClaimAt,
        terminalStatus: session.terminal_status,
      },
    );
  }
  const response = await runtimeAdapterFetch(
    env,
    runtimeAdapterWorkspaceUrl(controlPlane, adapterWorkspaceId),
    { method: "GET" },
  );
  const responseBody = await readRuntimeAdapterResponseBody(response);
  if (response.status === 404) {
    return {
      status: "expired",
      leaseId: null,
      attachUrl: null,
      attachUrlPresent: true,
      vncUrl: null,
      message: "runtime adapter workspace is gone",
      adapter: runtimeAdapterName,
      profile: session.profile,
      adapterWorkspaceId,
      providerResourceId,
      reconciledAt: Date.now(),
      reconcileError: null,
      createPending: false,
    };
  }
  if (!response.ok) {
    throw new Error(
      redactedAdapterResponseMessage(
        responseBody,
        `runtime adapter inspect HTTP ${response.status}`,
        [adapterWorkspaceId, providerResourceId],
      ),
    );
  }
  const parsed = parseAdapterWorkspaceResult(responseBody, {
    workspaceId: adapterWorkspaceId,
    providerResourceId,
    profile: session.profile,
  });
  if (!parsed) throw new Error("runtime adapter inspect returned an invalid workspace");
  if (!adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
    throw new Error("runtime adapter inspect returned a different workspace id");
  }
  if (parsed.profile !== session.profile) {
    throw new Error("runtime adapter inspect returned a different workspace profile");
  }
  const result = runtimeAdapterProvisionResult(
    parsed,
    runtimeAdapterRecord(session),
    Date.now(),
    adapterWorkspaceId,
    false,
  );
  return result.status === "failed"
    ? releaseFailedRuntimeAdapterProvision(env, session.id, result)
    : result;
}

async function reconcileStoppingRuntimeAdapterWorkspace(
  env: RuntimeEnv,
  session: InteractiveSessionRow,
  reconciliationClaimAt: number,
): Promise<InteractiveProvisionResult> {
  const adapterWorkspaceId = session.adapter_workspace_id;
  if (!adapterWorkspaceId) throw new Error("runtime adapter workspace reference is incomplete");

  let replayMessage: string | null = null;
  if (session.adapter_create_pending === 1) {
    const replay = await replayStoppingRuntimeAdapterCreate(env, session, reconciliationClaimAt);
    replayMessage = replay.message;
    if (replay.terminalResult) return replay.terminalResult;
    if (!replay.resolved) {
      return {
        status: "stopping",
        leaseId: null,
        attachUrl: null,
        attachUrlPresent: true,
        vncUrl: null,
        message: replay.message,
        adapter: runtimeAdapterName,
        profile: session.profile,
        adapterWorkspaceId,
        providerResourceId: session.provider_resource_id,
        reconciledAt: Date.now(),
        reconcileError: replay.message,
        terminalStatus: session.terminal_status,
        createPending: true,
      };
    }
  }

  let release: RuntimeAdapterStopResult;
  try {
    release = await stopRuntimeAdapterWorkspace(
      env,
      session.profile,
      requireRegisteredRuntimeAdapterControlPlane(
        env,
        session.profile,
        session.adapter_control_plane,
      ),
      adapterWorkspaceId,
    );
  } catch (error) {
    const message = `runtime adapter stop pending: ${safeProviderError(
      error,
      [adapterWorkspaceId, session.provider_resource_id],
      [session.attach_url],
    )}`;
    return {
      status: "stopping",
      leaseId: null,
      attachUrl: null,
      attachUrlPresent: true,
      vncUrl: null,
      message: replayMessage ? `${replayMessage}; ${message}` : message,
      adapter: runtimeAdapterName,
      profile: session.profile,
      adapterWorkspaceId,
      providerResourceId: session.provider_resource_id,
      reconciledAt: Date.now(),
      reconcileError: message,
      terminalStatus: session.terminal_status,
      createPending: session.adapter_create_pending === 1,
    };
  }
  if (release.status === "stopped") {
    await recordConfirmedRuntimeAdapterRelease(
      env,
      session.id,
      adapterWorkspaceId,
      Date.now(),
      release.message,
    );
  }
  const lifecycle = await database(env)
    .selectFrom("interactive_sessions")
    .select(["status", "terminal_status", "adapter_create_pending"])
    .where("id", "=", session.id)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .executeTakeFirst();
  const status = lifecycle?.status ?? (release.status === "stopped" ? "stopped" : "stopping");
  const createPending = lifecycle?.adapter_create_pending === 1;
  const releaseMessage = createPending
    ? `${release.message}; runtime adapter stop waiting for create resolution`
    : release.message;
  return {
    status,
    leaseId: null,
    attachUrl: null,
    attachUrlPresent: true,
    vncUrl: null,
    message: replayMessage ? `${replayMessage}; ${releaseMessage}` : releaseMessage,
    adapter: runtimeAdapterName,
    profile: session.profile,
    adapterWorkspaceId,
    providerResourceId: session.provider_resource_id,
    reconciledAt: Date.now(),
    reconcileError: null,
    terminalStatus: lifecycle?.terminal_status ?? null,
    createPending,
  };
}

type StoppingRuntimeAdapterReplay = {
  message: string;
  resolved: boolean;
  terminalResult?: InteractiveProvisionResult;
};

async function replayStoppingRuntimeAdapterCreate(
  env: RuntimeEnv,
  session: InteractiveSessionRow,
  reconciliationClaimAt: number,
): Promise<StoppingRuntimeAdapterReplay> {
  const adapterWorkspaceId = session.adapter_workspace_id;
  const replay = runtimeAdapterReplayRequest(runtimeAdapterRecord(session));
  const requestedCapabilities = replay.adapterRequestedCapabilities;
  const ttlSeconds = persistedRuntimeAdapterSeconds(replay.adapterTtlSeconds);
  const idleTimeoutSeconds = persistedRuntimeAdapterSeconds(replay.adapterIdleTimeoutSeconds);
  if (
    !adapterWorkspaceId ||
    !requestedCapabilities ||
    !ttlSeconds ||
    !idleTimeoutSeconds ||
    !session.adapter_requested_capabilities_json
  ) {
    return {
      message: "runtime adapter create replay blocked: persisted lifecycle is incomplete",
      resolved: false,
    };
  }
  let controlPlane: string;
  try {
    controlPlane = requireRegisteredRuntimeAdapterControlPlane(
      env,
      session.profile,
      session.adapter_control_plane,
    );
  } catch (error) {
    return {
      message: safeProviderError(error, [adapterWorkspaceId]),
      resolved: false,
    };
  }
  const createPayloadJson = validatedRuntimeAdapterCreatePayloadJson(
    replay.adapterCreatePayloadJson ?? "",
    {
      workspaceId: adapterWorkspaceId,
      ttlSeconds,
      idleTimeoutSeconds,
      desktop: requestedCapabilities.desktop,
    },
  );
  if (!createPayloadJson) {
    return {
      message: "runtime adapter create replay blocked: persisted payload is invalid",
      resolved: false,
    };
  }
  let ownership = database(env)
    .selectFrom("interactive_sessions")
    .select("id")
    .where("id", "=", session.id)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("adapter_control_plane", "=", controlPlane)
    .where("adapter_create_payload_json", "=", createPayloadJson)
    .where("adapter_requested_capabilities_json", "=", session.adapter_requested_capabilities_json)
    .where("adapter_ttl_seconds", "=", ttlSeconds)
    .where("adapter_idle_timeout_seconds", "=", idleTimeoutSeconds)
    .where("adapter_create_pending", "=", 1)
    .where("status", "=", "stopping")
    .where("updated_at", "=", session.updated_at)
    .where("last_reconciled_at", "=", reconciliationClaimAt);
  ownership = session.terminal_status
    ? ownership.where("terminal_status", "=", session.terminal_status)
    : ownership.where("terminal_status", "is", null);
  if (!(await ownership.executeTakeFirst())) {
    return {
      message: "runtime adapter create replay deferred: lifecycle ownership changed",
      resolved: false,
    };
  }

  let response: Response;
  try {
    response = await runtimeAdapterFetch(env, runtimeAdapterCollectionUrl(controlPlane), {
      method: "POST",
      headers: { "idempotency-key": adapterWorkspaceId },
      body: createPayloadJson,
    });
  } catch (error) {
    return {
      message: `runtime adapter create replay pending: ${safeProviderError(error, [adapterWorkspaceId])}`,
      resolved: false,
    };
  }

  let responseBody: unknown;
  try {
    responseBody = await readRuntimeAdapterResponseBody(response);
  } catch (error) {
    return {
      message: `runtime adapter create replay pending: ${safeProviderError(error, [adapterWorkspaceId])}`,
      resolved: false,
    };
  }
  if (!response.ok) {
    const responseMessage = redactedAdapterResponseMessage(
      responseBody,
      `HTTP ${response.status}`,
      [adapterWorkspaceId],
    );
    if (runtimeAdapterWorkspaceIdConflict(response.status, responseBody)) {
      const terminalResult = await failRuntimeAdapterWorkspaceIdConflict(
        env,
        session,
        controlPlane,
        adapterWorkspaceId,
        createPayloadJson,
        requestedCapabilities,
        {
          status: "stopping",
          updatedAt: session.updated_at,
          lastReconciledAt: reconciliationClaimAt,
          terminalStatus: session.terminal_status,
        },
        `runtime adapter create replay failed: ${responseMessage}`,
      );
      if (!terminalResult) {
        return {
          message: "runtime adapter create replay deferred: conflict response is stale",
          resolved: false,
        };
      }
      return { message: terminalResult.message, resolved: true, terminalResult };
    }
    return {
      message: `runtime adapter create replay pending: ${responseMessage}`,
      resolved: false,
    };
  }
  const parsed = parseAdapterWorkspaceResult(responseBody, {
    workspaceId: adapterWorkspaceId,
    profile: session.profile,
  });
  if (!parsed || !adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
    return {
      message: "runtime adapter create replay pending: invalid workspace identity",
      resolved: false,
    };
  }
  const message = `runtime adapter create replay resolved: ${parsed.status}`;

  const resolvedAt = Date.now();
  const terminalStatusOwner = session.terminal_status
    ? sql<boolean>`terminal_status = ${session.terminal_status}`
    : sql<boolean>`terminal_status IS NULL`;
  const expectedOwner = sql<boolean>`
    id = ${session.id}
    AND adapter = ${runtimeAdapterName}
    AND adapter_workspace_id = ${adapterWorkspaceId}
    AND adapter_control_plane = ${controlPlane}
    AND adapter_create_payload_json = ${createPayloadJson}
    AND adapter_requested_capabilities_json = ${session.adapter_requested_capabilities_json}
    AND adapter_ttl_seconds = ${ttlSeconds}
    AND adapter_idle_timeout_seconds = ${idleTimeoutSeconds}
    AND adapter_create_pending = 1
    AND status = 'stopping'
    AND updated_at = ${session.updated_at}
    AND last_reconciled_at = ${reconciliationClaimAt}
    AND ${terminalStatusOwner}
  `;
  const db = database(env);
  const update = db
    .updateTable("interactive_sessions")
    .set({
      adapter_create_pending: 0,
      last_reconciled_at: resolvedAt,
      reconcile_error: message,
      last_event: message,
      updated_at: sql<number>`MAX(updated_at + 1, ${resolvedAt})`,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const event = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${session.id}, 'system', ${clean(message, 1000)}, ${resolvedAt}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const results = await env.DB.batch<{ updated_at: number }>(
    [event, update].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  const resolved = Boolean(results.at(-1)?.results.length);
  if (resolved) {
    await archiveInteractiveSessionLogs(env, session.id, resolvedAt).catch(() => undefined);
  }
  return { message, resolved };
}

async function stopRuntimeAdapterWorkspace(
  env: RuntimeEnv,
  profile: string,
  registeredControlPlane: string,
  adapterWorkspaceId: string,
): Promise<RuntimeAdapterStopResult> {
  const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
    env,
    profile,
    registeredControlPlane,
  );
  const response = await runtimeAdapterFetch(
    env,
    runtimeAdapterWorkspaceUrl(controlPlane, adapterWorkspaceId),
    { method: "DELETE" },
  );
  const body = response.status === 204 ? null : await readRuntimeAdapterResponseBody(response);
  const parsed = parseAdapterWorkspaceResult(body, { workspaceId: adapterWorkspaceId });
  if (parsed && !adapterWorkspaceIdMatches(parsed, adapterWorkspaceId)) {
    throw new Error("runtime adapter stop returned a different workspace id");
  }
  const fallbackMessage =
    response.status === 404 || response.status === 204
      ? "runtime adapter workspace released"
      : `runtime adapter stop HTTP ${response.status}`;
  const message =
    parsed?.message ?? redactedAdapterResponseMessage(body, fallbackMessage, [adapterWorkspaceId]);
  if (response.status === 404 || response.status === 204) {
    return { status: "stopped", message };
  }
  if (!response.ok) throw new Error(message);
  const outcome = runtimeAdapterStopOutcome(response.status, parsed, adapterWorkspaceId);
  if (outcome === "identity_mismatch") {
    throw new Error("runtime adapter stop returned a different workspace id");
  }
  return { status: outcome, message };
}

type RuntimeAdapterStopResult = {
  status: "stopping" | "stopped";
  message: string;
};

async function stopRuntimeAdapterWorkspaceForSession(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
): Promise<RuntimeAdapterStopResult> {
  const registration = await database(env)
    .selectFrom("interactive_sessions")
    .select(["adapter_control_plane", "adapter_create_pending", "profile"])
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .executeTakeFirst();
  const controlPlane = requireRegisteredRuntimeAdapterControlPlane(
    env,
    registration?.profile ?? "",
    registration?.adapter_control_plane,
  );
  if (registration?.adapter_create_pending !== 0) {
    return {
      status: "stopping",
      message: "runtime adapter stop waiting for create resolution",
    };
  }
  return stopRuntimeAdapterWorkspace(
    env,
    registration?.profile ?? "",
    controlPlane,
    adapterWorkspaceId,
  );
}

async function runtimeAdapterFetch(
  env: RuntimeEnv,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const token = runtimeAdapterToken(env);
  if (!token) throw new Error("runtime adapter token is not configured");
  const safeTarget = safeDesktopUrl(url);
  if (!safeTarget) throw new Error("runtime adapter URL must use HTTPS or loopback HTTP");
  const target = new URL(safeTarget);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${token}`);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  const fetcher = runtimeAdapterFetcher(env, target);
  const response = await fetcher.fetch(target, {
    ...init,
    headers,
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status >= 300 && response.status < 400) {
    throw new Error("runtime adapter redirect refused");
  }
  return response;
}

function runtimeAdapterFetcher(env: RuntimeEnv, target: URL): Fetcher | typeof globalThis {
  const coordinator =
    runtimeAdapterControlPlaneIdentity(env.CRABBOX_COORDINATOR_ORIGIN) ??
    runtimeAdapterControlPlaneIdentity(env.CRABBOX_RUNTIME_ADAPTER_URL);
  if (!env.CRABBOX_COORDINATOR || !coordinator) return globalThis;
  const normalizedTarget = new URL(target);
  if (normalizedTarget.protocol === "wss:") normalizedTarget.protocol = "https:";
  if (normalizedTarget.protocol === "ws:") normalizedTarget.protocol = "http:";
  return new URL(coordinator).origin === normalizedTarget.origin
    ? env.CRABBOX_COORDINATOR
    : globalThis;
}

async function interactiveTerminalFetch(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "adapter">,
  url: string,
  headers: Headers,
): Promise<Response> {
  const target = new URL(url);
  const fetchTarget = new URL(target);
  if (fetchTarget.protocol === "wss:") fetchTarget.protocol = "https:";
  if (fetchTarget.protocol === "ws:") fetchTarget.protocol = "http:";
  const fetcher =
    session.adapter === runtimeAdapterName ? runtimeAdapterFetcher(env, target) : globalThis;
  return fetcher.fetch(fetchTarget, { headers });
}

async function readRuntimeAdapterResponseBody(response: Response): Promise<unknown> {
  const body = await readBoundedResponseText(response);
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { message: body };
  }
}

function runtimeAdapterToken(env: RuntimeEnv): string {
  return clean(env.CRABBOX_RUNTIME_ADAPTER_TOKEN, 4000);
}

function runtimeAdapterProviderConfigured(env: RuntimeEnv): boolean {
  return Boolean(
    configuredRuntimeAdapterControlPlane(env, "profile-route") && runtimeAdapterToken(env),
  );
}

async function forwardRuntimeProvision(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  let response: Response;
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (env.CRABBOX_RUNTIME_PROVISION_TOKEN) {
      headers.set("authorization", `Bearer ${env.CRABBOX_RUNTIME_PROVISION_TOKEN}`);
    }
    response = await fetch(env.CRABBOX_RUNTIME_PROVISION_URL as string, {
      method: "POST",
      headers,
      body: JSON.stringify(session),
    });
  } catch (error) {
    return failedProvision(`interactive provision failed: ${safeProviderError(error)}`);
  }
  if (!response.ok) {
    return failedProvision(`interactive provision failed: runtime HTTP ${response.status}`);
  }
  return provisionResultFromBody(
    (await response.json().catch(() => ({}))) as Record<string, unknown>,
    "interactive provision failed: invalid runtime response",
  );
}

async function provisionWithCloudflareRunner(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  if (!env.CRABBOX_CLOUDFLARE_RUNNER_TOKEN) {
    return failedProvision("cloudflare runner token is not configured");
  }

  const runnerUrl = env.CRABBOX_CLOUDFLARE_RUNNER_URL as string;
  const sandboxId = clean(`crabbox-${session.id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 64);
  const workdir = cloudflareRunnerWorkdir(env, session);
  const instanceType = cloudflareRunnerInstanceType(env);
  let response: Response;
  try {
    response = await fetch(joinUrl(runnerUrl, "/v1/sandboxes"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.CRABBOX_CLOUDFLARE_RUNNER_TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        id: sandboxId,
        leaseId: sandboxId,
        repo: session.repo,
        branch: session.branch,
        workdir,
        instanceType,
        ttlSeconds: clampedSeconds(env.CRABBOX_CLOUDFLARE_RUNNER_TTL_SECONDS, 14_400),
        idleTimeoutSeconds: clampedSeconds(env.CRABBOX_CLOUDFLARE_RUNNER_IDLE_SECONDS, 1_800),
        env: githubTokenEnv(session),
        labels: {
          app: "crabbox",
          session: session.id,
          repo: session.repo,
          branch: session.branch,
          owner: session.owner,
          runtime: session.runtime,
          command: session.command,
        },
      }),
    });
  } catch (error) {
    return failedProvision(`cloudflare runner provision failed: ${safeProviderError(error)}`);
  }
  if (!response.ok) {
    return failedProvision(`cloudflare runner provision failed: HTTP ${response.status}`);
  }

  const body = (await response.json().catch(() => ({}))) as CloudflareSandboxPayload;
  const state = clean(body.state, 80);
  const ready = state === "running" || state === "healthy";
  return {
    status: ready ? "ready" : "provisioning",
    leaseId: `cloudflare:${clean(body.id, 120) || sandboxId}`,
    attachUrl: null,
    vncUrl: null,
    message: ready
      ? `cloudflare sandbox ready (${clean(body.instanceType, 80) || instanceType}); PTY bridge pending`
      : `cloudflare sandbox ${state || "provisioning"}`,
  };
}

async function provisionWithClawFleet(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  if (session.runtime !== "crabbox") {
    return {
      status: "pending_adapter",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      message: "container runtime requires CRABBOX_RUNTIME_PROVISION_URL",
    };
  }

  let response: Response;
  try {
    const headers = new Headers({ "content-type": "application/json" });
    if (env.CRABBOX_CLAWFLEET_TOKEN) {
      headers.set("authorization", `Bearer ${env.CRABBOX_CLAWFLEET_TOKEN}`);
    }
    response = await fetch(joinUrl(env.CRABBOX_CLAWFLEET_URL as string, "/api/v1/instances"), {
      method: "POST",
      headers,
      body: JSON.stringify({ count: 1, runtime_type: "openclaw" }),
    });
  } catch (error) {
    return failedProvision(`clawfleet provision failed: ${safeProviderError(error)}`);
  }
  if (!response.ok) {
    return failedProvision(`clawfleet provision failed: HTTP ${response.status}`);
  }

  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const instances = Array.isArray(body.data) ? body.data : [];
  const instance = (instances[0] ?? {}) as ClawFleetInstancePayload;
  const name = clean(instance.name, 120);
  if (!name) return failedProvision("clawfleet provision failed: missing instance name");

  const publicUrl = env.CRABBOX_CLAWFLEET_PUBLIC_URL || env.CRABBOX_CLAWFLEET_URL || "";
  const status = instance.status === "running" ? "ready" : "provisioning";
  return {
    status,
    leaseId: `clawfleet:${name}`,
    attachUrl: joinUrl(publicUrl, `/console/${encodeURIComponent(name)}/`),
    vncUrl: directPortUrl(publicUrl, instance.novnc_port, "/vnc.html?autoconnect=1&resize=remote"),
    message: `clawfleet instance ${name} ${status}`,
  };
}

function provisionResultFromBody(
  body: Record<string, unknown>,
  invalidMessage: string,
): InteractiveProvisionResult {
  const status = createOnlyAdapterStatus(body.status);
  if (!status) return failedProvision(invalidMessage);
  const leaseId = clean(body.leaseId ?? body.lease_id, 240) || null;
  const attachUrl = clean(body.attachUrl ?? body.attach_url, 1000) || null;
  const vncUrl = clean(body.vncUrl ?? body.vnc_url, 1000) || null;
  return {
    status,
    leaseId,
    attachUrl,
    vncUrl,
    message: redactedAdapterMessage(
      clean(body.message, 500) || null,
      status,
      [leaseId],
      [attachUrl, vncUrl],
    ),
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

function cloudflareRunnerWorkdir(env: RuntimeEnv, session: InteractiveProvisionRequest): string {
  const base = clean(env.CRABBOX_CLOUDFLARE_RUNNER_WORKDIR, 160) || "/workspace/crabbox";
  const suffix = session.id.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return `${base.replace(/\/+$/, "")}/${suffix}`;
}

function cloudflareRunnerInstanceType(env: RuntimeEnv): string {
  return (
    optionalOneOf(env.CRABBOX_CLOUDFLARE_RUNNER_INSTANCE_TYPE, [
      "lite",
      "basic",
      "standard-1",
      "standard-2",
      "standard-3",
      "standard-4",
    ] as const) ?? "standard-4"
  );
}

function clampedSeconds(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(86_400, Math.max(300, Math.trunc(parsed)));
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
  const rows = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("preparation_pending", "=", 0)
    .orderBy("updated_at", "desc")
    .limit(80)
    .execute();
  if (!rows.length) return [];
  const logs = await readInteractiveSessionLogs(
    env,
    rows.map((row) => row.id),
  );
  const archives = await readInteractiveSessionLogArchives(
    env,
    rows.map((row) => row.id),
  );
  return rows.map((row) =>
    decorateInteractiveSession(
      interactiveSession(row, logs.get(row.id) ?? [], archives.get(row.id) ?? null),
      user,
      env,
    ),
  );
}

async function readInteractiveSession(
  env: RuntimeEnv,
  id: string,
): Promise<InteractiveSession | null> {
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("preparation_pending", "=", 0)
    .executeTakeFirst();
  if (!row) return null;
  const logs = await readInteractiveSessionLogs(env, [id]);
  const archives = await readInteractiveSessionLogArchives(env, [id]);
  return interactiveSession(row, logs.get(id) ?? [], archives.get(id) ?? null);
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
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .where("preparation_pending", "=", 0)
    .where("share_mode", "=", "link_read")
    .executeTakeFirst();
  if (!row || !row.share_token_hash || !token) throw notFound("shared session not found");
  if ((await sha256(token)) !== row.share_token_hash) throw notFound("shared session not found");
  const logs = await readInteractiveSessionLogs(env, [id]);
  const archives = await readInteractiveSessionLogArchives(env, [id]);
  const session = interactiveSession(row, logs.get(id) ?? [], archives.get(id) ?? null);
  const activeController = activeDelegatedController(session, Date.now());
  return {
    session: {
      ...session,
      adapter: null,
      profile: "",
      adapterWorkspaceId: null,
      providerResourceId: null,
      lastReconciledAt: null,
      reconcileError: null,
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      ptyAvailable: false,
      controller: activeController,
      controlGrantedAt: activeController ? session.controlGrantedAt : null,
      controlExpiresAt: activeController ? session.controlExpiresAt : null,
      multiplayerMode: session.multiplayerMode,
      canControl: false,
      canManage: false,
      canRequestControl: false,
      sharedReadOnly: true,
    },
  };
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
  await mutateInteractiveSessionMetadataAtomically(
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
  const { session, user } = await requireAgentSession(request, env, id);
  if (session.runtime !== githubActionsRuntime || !session.workKey) {
    throw badRequest("session is not a GitHub Actions work session");
  }
  const body = await readJson<{
    state?: string;
    phase?: string;
    summary?: string;
    codexThreadId?: string | null;
    codexTurnId?: string | null;
    completionReason?: string | null;
  }>(request);
  const state = parseGitHubActionsWorkState(body.state);
  if (!state) throw badRequest("invalid work state");
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (!row) throw notFound("interactive session not found");
  const phase = body.phase === undefined ? row.work_phase : clean(body.phase, 160);
  const summary = body.summary === undefined ? row.summary : clean(body.summary, 500);
  const codexThreadId =
    body.codexThreadId === undefined ? row.codex_thread_id : clean(body.codexThreadId, 240) || null;
  const codexTurnId =
    body.codexTurnId === undefined ? row.codex_turn_id : clean(body.codexTurnId, 240) || null;
  const completionReason =
    body.completionReason === undefined
      ? isTerminalGitHubActionsWorkState(state)
        ? row.completion_reason
        : null
      : clean(body.completionReason, 500) || null;
  const terminal = isTerminalGitHubActionsWorkState(state);
  const status = terminal
    ? gitHubActionsSessionStatus(state)
    : ["ready", "attached", "detached"].includes(row.status)
      ? row.status
      : "ready";
  const lastEvent = gitHubActionsWorkEvent(state, phase);
  const changed =
    row.work_state !== state ||
    row.work_phase !== phase ||
    row.summary !== summary ||
    row.codex_thread_id !== codexThreadId ||
    row.codex_turn_id !== codexTurnId ||
    row.completion_reason !== completionReason;
  const now = Date.now();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status,
      summary,
      work_state: state,
      work_phase: phase,
      codex_thread_id: codexThreadId,
      codex_turn_id: codexTurnId,
      last_heartbeat_at: now,
      completion_reason: completionReason,
      last_event: lastEvent,
      last_seen_at: now,
      updated_at: now,
      stopped_at: terminal ? now : null,
    })
    .where("id", "=", id)
    .execute();
  if (changed) {
    await appendInteractiveSessionEvent(env, id, user, lastEvent, now);
  }
  if (terminal) {
    await disconnectGitHubActionsRunner(env, id).catch(() => undefined);
  }
  return {
    session: decorateInteractiveSession(
      (await readInteractiveSession(env, id)) as InteractiveSession,
      user,
      env,
    ),
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
  const { session, user } = await requireAgentSession(request, env, id, {
    allowQueryToken: true,
  });
  if (session.runtime !== githubActionsRuntime || !session.workKey) {
    throw badRequest("session is not a GitHub Actions work session");
  }
  const stub = githubActionsRelayStub(env, id);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  const now = Date.now();
  const state =
    session.workState === "registered" || !session.workState ? "running" : session.workState;
  const phase =
    !session.workPhase || session.workPhase === "waiting_for_runner"
      ? "runner_connected"
      : session.workPhase;
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: ["attached", "detached"].includes(session.status) ? session.status : "ready",
      work_state: state,
      work_phase: phase,
      last_heartbeat_at: now,
      last_seen_at: now,
      updated_at: now,
      last_event: "GitHub Actions runner connected",
    })
    .where("id", "=", id)
    .execute();
  await appendInteractiveSessionEvent(env, id, user, "GitHub Actions runner connected", now);
  return stub.fetch("https://crabfleet.internal/api/session-control/github-actions/runner", {
    headers: { upgrade: "websocket" },
  });
}

async function readInteractiveSessionLogs(
  env: RuntimeEnv,
  ids: string[],
): Promise<Map<string, string[]>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return new Map();
  const eventRows = (
    await sql<{ session_id: string; message: string; created_at: number }>`
      SELECT session_id, message, created_at
      FROM (
        SELECT session_id, message, created_at, id,
          row_number() OVER (PARTITION BY session_id ORDER BY created_at DESC, id DESC) AS rank
        FROM interactive_session_events
        WHERE session_id IN (${sql.join(uniqueIds)})
      )
      WHERE rank <= 80
      ORDER BY session_id ASC, created_at ASC, id ASC
    `.execute(database(env))
  ).rows;
  const logs = new Map<string, string[]>();
  for (const row of eventRows) {
    const line = `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`;
    logs.set(row.session_id, [...(logs.get(row.session_id) ?? []), line]);
  }
  return logs;
}

async function readInteractiveSessionLogArchives(
  env: RuntimeEnv,
  ids: string[],
): Promise<Map<string, InteractiveSessionLogArchive>> {
  const uniqueIds = [...new Set(ids)].filter(Boolean);
  if (!uniqueIds.length) return new Map();
  const rows = await database(env)
    .selectFrom("interactive_session_log_archives")
    .selectAll()
    .where("session_id", "in", uniqueIds)
    .execute();
  return new Map(rows.map((row) => [row.session_id, interactiveSessionLogArchive(row)]));
}

async function readInteractiveSessionEventRows(
  env: RuntimeEnv,
  id: string,
  options: { limit?: number; newest?: boolean } = {},
): Promise<InteractiveSessionEventRow[]> {
  const limit = options.limit ? Math.max(1, Math.min(10000, Math.floor(options.limit))) : 0;
  const base = database(env)
    .selectFrom("interactive_session_events")
    .selectAll()
    .where("session_id", "=", id);
  if (limit && options.newest) {
    const rows = await base
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .limit(limit)
      .execute();
    return rows.reverse();
  }
  const ordered = base.orderBy("created_at", "asc").orderBy("id", "asc");
  return (limit ? ordered.limit(limit) : ordered).execute();
}

async function countInteractiveSessionEvents(env: RuntimeEnv, id: string): Promise<number> {
  const row = await database(env)
    .selectFrom("interactive_session_events")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .where("session_id", "=", id)
    .executeTakeFirst();
  return Number(row?.count ?? 0);
}

async function appendInteractiveSessionEvent(
  env: RuntimeEnv,
  id: string,
  user: User,
  message: string,
  now = Date.now(),
): Promise<void> {
  const db = database(env);
  await executeBatch(env, [
    db.insertInto("interactive_session_events").values({
      session_id: id,
      actor: actor(user),
      message: clean(message, 1000),
      created_at: now,
    }),
    terminalFinalizationPendingQuery(db, id),
  ]);
  await archiveInteractiveSessionLogs(env, id, now).catch(() => undefined);
}

async function appendInteractiveSessionLog(
  env: RuntimeEnv,
  id: string,
  user: User | null,
  message: string,
  now = Date.now(),
): Promise<void> {
  if (user) {
    await appendInteractiveSessionEvent(env, id, user, message, now);
    return;
  }
  const db = database(env);
  await executeBatch(env, [
    db.insertInto("interactive_session_events").values({
      session_id: id,
      actor: "system",
      message: clean(message, 1000),
      created_at: now,
    }),
    terminalFinalizationPendingQuery(db, id),
  ]);
  await archiveInteractiveSessionLogs(env, id, now).catch(() => undefined);
}

function terminalFinalizationPendingQuery(db: Kysely<Database>, id: string): CompilableQuery {
  return db
    .updateTable("interactive_sessions")
    .set({ terminal_finalize_pending: 1 })
    .where("id", "=", id)
    .where("status", "in", deadInteractiveSessionStatuses);
}

async function finalizeTerminalInteractiveSession(
  env: RuntimeEnv,
  id: string,
  status: "stopped" | "expired" | "failed",
  now: number,
): Promise<void> {
  const db = database(env);
  const terminal = await db
    .selectFrom("interactive_sessions")
    .select(["terminal_failure_reason", "reconcile_error", "last_event"])
    .where("id", "=", id)
    .where("status", "=", status)
    .executeTakeFirst();
  const message =
    status === "failed"
      ? retainedRuntimeAdapterFailureMessage(
          terminal?.terminal_failure_reason ?? null,
          terminal?.reconcile_error ?? null,
          terminal?.last_event ?? null,
        )
      : status === "expired"
        ? "interactive workspace expired"
        : "interactive workspace stopped";
  await completeTerminalFinalization({
    ensureEvent: async () => {
      await executeBatch(env, [
        sql`
          INSERT INTO interactive_session_events (session_id, actor, message, created_at)
          SELECT ${id}, 'system', ${message}, COALESCE(stopped_at, ${now})
          FROM interactive_sessions AS session
          WHERE session.id = ${id}
            AND session.status = ${status}
            AND NOT EXISTS (
              SELECT 1
              FROM interactive_session_events AS event
              WHERE event.session_id = session.id
                AND event.actor = 'system'
                AND event.message = ${message}
            )
        `,
        terminalFinalizationPendingQuery(db, id),
      ]);
      return true;
    },
    readArchiveState: async () => {
      const [currentArchive, eventCount, currentSession] = await Promise.all([
        db
          .selectFrom("interactive_session_log_archives")
          .selectAll()
          .where("session_id", "=", id)
          .executeTakeFirst(),
        countInteractiveSessionEvents(env, id),
        db
          .selectFrom("interactive_sessions")
          .select("updated_at")
          .where("id", "=", id)
          .executeTakeFirst(),
      ]);
      return {
        eventCount,
        archiveEventCount: currentArchive?.event_count ?? null,
        archiveSessionVersionMatches:
          currentArchive?.session_updated_at === currentSession?.updated_at,
        archiveObjectsReady: Boolean(
          !env.SESSION_LOGS ||
          (currentArchive?.events_key &&
            currentArchive.transcript_key &&
            currentArchive.summary_key),
        ),
      };
    },
    archive: () => archiveInteractiveSessionLogs(env, id, now, { force: true }),
    clearPending: async () => {
      const cleared = await sql`
        UPDATE interactive_sessions
        SET terminal_finalize_pending = 0
        WHERE id = ${id}
          AND status = ${status}
          AND terminal_finalize_pending > 0
          AND EXISTS (
            SELECT 1
            FROM interactive_session_log_archives AS archive
            WHERE archive.session_id = interactive_sessions.id
              AND archive.session_updated_at = interactive_sessions.updated_at
          )
          AND NOT EXISTS (
            SELECT 1
            FROM interactive_session_credential_policies
            WHERE session_id = ${id}
          )
          AND COALESCE(
            (
              SELECT event_count
              FROM interactive_session_log_archives
              WHERE session_id = ${id}
            ),
            -1
          ) >= (
            SELECT count(*)
            FROM interactive_session_events
            WHERE session_id = ${id}
          )
          AND (
            ${env.SESSION_LOGS ? 1 : 0} = 0
            OR EXISTS (
              SELECT 1
              FROM interactive_session_log_archives
              WHERE session_id = ${id}
                AND events_key IS NOT NULL
                AND transcript_key IS NOT NULL
                AND summary_key IS NOT NULL
            )
          )
      `.execute(db);
      if ((cleared.numAffectedRows ?? 0n) > 0n) return true;
      const current = await db
        .selectFrom("interactive_sessions")
        .select("terminal_finalize_pending")
        .where("id", "=", id)
        .executeTakeFirst();
      return !current || current.terminal_finalize_pending === 0;
    },
  });
}

async function archiveInteractiveSessionLogs(
  env: RuntimeEnv,
  id: string,
  now = Date.now(),
  options: { force?: boolean } = {},
): Promise<void> {
  const db = database(env);
  const [sessionRow, currentArchive, eventCount] = await Promise.all([
    db.selectFrom("interactive_sessions").selectAll().where("id", "=", id).executeTakeFirst(),
    db
      .selectFrom("interactive_session_log_archives")
      .selectAll()
      .where("session_id", "=", id)
      .executeTakeFirst(),
    countInteractiveSessionEvents(env, id),
  ]);
  if (!sessionRow) return;
  if (!shouldArchiveInteractiveSessionLogs(currentArchive, eventCount, now, options.force)) {
    return;
  }
  const events = await readInteractiveSessionEventRows(env, id);
  const latestEventAt = events.at(-1)?.created_at ?? now;
  const attemptedArchive = sessionArchiveAttemptKeys(
    sessionLogArchiveBase(id),
    events.length,
    latestEventAt,
    now,
    crypto.randomUUID(),
  );
  const eventsKey = attemptedArchive.events_key;
  const transcriptKey = attemptedArchive.transcript_key;
  const summaryKey = attemptedArchive.summary_key;
  if (env.SESSION_LOGS) {
    await Promise.all([
      env.SESSION_LOGS.put(
        eventsKey,
        events.map((row) => JSON.stringify(interactiveSessionEvent(row))).join("\n") + "\n",
        { httpMetadata: { contentType: "application/x-ndjson; charset=utf-8" } },
      ),
      env.SESSION_LOGS.put(transcriptKey, sessionLogTranscript(sessionRow, events), {
        httpMetadata: { contentType: "text/markdown; charset=utf-8" },
      }),
      env.SESSION_LOGS.put(
        summaryKey,
        JSON.stringify(sessionLogSummary(sessionRow, events), null, 2),
        { httpMetadata: { contentType: "application/json; charset=utf-8" } },
      ),
    ]);
  }
  await sql`
    INSERT INTO interactive_session_log_archives (
      session_id,
      event_count,
      session_updated_at,
      events_key,
      transcript_key,
      summary_key,
      archived_at,
      updated_at
    )
    VALUES (
      ${id},
      ${events.length},
      ${sessionRow.updated_at},
      ${env.SESSION_LOGS ? eventsKey : null},
      ${env.SESSION_LOGS ? transcriptKey : null},
      ${env.SESSION_LOGS ? summaryKey : null},
      ${now},
      ${now}
    )
    ON CONFLICT(session_id) DO UPDATE SET
      event_count = excluded.event_count,
      session_updated_at = excluded.session_updated_at,
      events_key = excluded.events_key,
      transcript_key = excluded.transcript_key,
      summary_key = excluded.summary_key,
      updated_at = excluded.updated_at
    WHERE excluded.event_count > interactive_session_log_archives.event_count
      OR (
        excluded.event_count = interactive_session_log_archives.event_count
        AND (
          (
            excluded.session_updated_at IS NOT NULL
            AND interactive_session_log_archives.session_updated_at IS NULL
          )
          OR (
            excluded.session_updated_at > interactive_session_log_archives.session_updated_at
          )
          OR (
            excluded.session_updated_at IS interactive_session_log_archives.session_updated_at
            AND (
              interactive_session_log_archives.events_key IS NULL
              OR interactive_session_log_archives.transcript_key IS NULL
              OR interactive_session_log_archives.summary_key IS NULL
              OR excluded.updated_at >= interactive_session_log_archives.updated_at
            )
          )
        )
      )
  `.execute(db);
  if (!env.SESSION_LOGS) return;
  const latestArchive = await db
    .selectFrom("interactive_session_log_archives")
    .selectAll()
    .where("session_id", "=", id)
    .executeTakeFirst();
  await cleanupSessionLogArchiveObjects(
    env,
    obsoleteSessionArchiveObjectKeys(latestArchive, currentArchive, attemptedArchive),
  );
}

function shouldArchiveInteractiveSessionLogs(
  current: InteractiveSessionLogArchiveTable | undefined,
  eventCount: number,
  now: number,
  force = false,
): boolean {
  if (force) return true;
  if (!current) return true;
  if (eventCount < current.event_count) return false;
  if (eventCount <= 2 && eventCount > current.event_count) return true;
  if (eventCount >= current.event_count + 20) return true;
  return now >= current.updated_at + 60_000;
}

async function cleanupSessionLogArchiveObjects(
  env: RuntimeEnv,
  archive:
    | Pick<InteractiveSessionLogArchiveTable, "events_key" | "transcript_key" | "summary_key">
    | undefined,
): Promise<void> {
  if (!env.SESSION_LOGS || !archive) return;
  const keys = [archive.events_key, archive.transcript_key, archive.summary_key].filter(
    (key): key is string => Boolean(key),
  );
  if (!keys.length) return;
  await Promise.all(keys.map((key) => env.SESSION_LOGS?.delete(key)));
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
    (await sshGatewayKeyGitHubToken(request, env, user));
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

function sessionLogArchiveBase(id: string): string {
  return `orgs/openclaw/interactive-sessions/${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function sessionLogTranscript(
  session: InteractiveSession | InteractiveSessionRow,
  events: InteractiveSessionEventRow[],
): string {
  const parentSessionId =
    "parentSessionId" in session ? session.parentSessionId : session.parent_session_id;
  const rootSessionId =
    "rootSessionId" in session ? session.rootSessionId : session.root_session_id;
  const createdBy = "createdBy" in session ? session.createdBy : session.created_by;
  const lines = [
    `# ${session.id}`,
    "",
    `repo: ${session.repo}`,
    `branch: ${session.branch}`,
    `runtime: ${session.runtime}`,
    `owner: ${session.owner}`,
    `created_by: ${createdBy}`,
    `parent: ${parentSessionId ?? "none"}`,
    `root: ${rootSessionId ?? session.id}`,
    `status: ${session.status}`,
    ...("workKey" in session
      ? [
          `work_key: ${session.workKey ?? "none"}`,
          `work_kind: ${session.workKind ?? "none"}`,
          `work_state: ${session.workState ?? "none"}`,
          `work_phase: ${session.workPhase || "none"}`,
          `source_url: ${session.sourceUrl ?? "none"}`,
          `github_run_url: ${session.githubRunUrl ?? "none"}`,
          `codex_thread_id: ${session.codexThreadId ?? "none"}`,
          `codex_turn_id: ${session.codexTurnId ?? "none"}`,
          `last_heartbeat_at: ${session.lastHeartbeatAt ?? "none"}`,
          `completion_reason: ${session.completionReason ?? "none"}`,
        ]
      : [
          `work_key: ${session.work_key ?? "none"}`,
          `work_kind: ${session.work_kind ?? "none"}`,
          `work_state: ${session.work_state || "none"}`,
          `work_phase: ${session.work_phase || "none"}`,
          `source_url: ${session.source_url ?? "none"}`,
          `github_run_url: ${session.github_run_url ?? "none"}`,
          `codex_thread_id: ${session.codex_thread_id ?? "none"}`,
          `codex_turn_id: ${session.codex_turn_id ?? "none"}`,
          `last_heartbeat_at: ${session.last_heartbeat_at ?? "none"}`,
          `completion_reason: ${session.completion_reason ?? "none"}`,
        ]),
    `purpose: ${session.purpose}`,
    `summary: ${session.summary}`,
    "",
    "## Events",
    "",
  ];
  for (const event of events) {
    lines.push(`- ${new Date(event.created_at).toISOString()} ${event.actor}: ${event.message}`);
  }
  return `${lines.join("\n")}\n`;
}

function sessionLogSummary(
  session: InteractiveSessionRow,
  events: InteractiveSessionEventRow[],
): Record<string, unknown> {
  return {
    id: session.id,
    parentSessionId: session.parent_session_id,
    rootSessionId: session.root_session_id ?? session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    owner: session.owner,
    createdBy: session.created_by,
    purpose: session.purpose,
    summary: session.summary,
    status: session.status,
    workKey: session.work_key,
    workKind: session.work_kind,
    workState: parseGitHubActionsWorkState(session.work_state),
    workPhase: session.work_phase,
    sourceUrl: session.source_url,
    githubRunUrl: session.github_run_url,
    codexThreadId: session.codex_thread_id,
    codexTurnId: session.codex_turn_id,
    lastHeartbeatAt: session.last_heartbeat_at,
    completionReason: session.completion_reason,
    eventCount: events.length,
    firstEventAt: events[0]?.created_at ?? null,
    lastEventAt: events.at(-1)?.created_at ?? null,
    lastEvent: events.at(-1)?.message ?? session.last_event,
    updatedAt: session.updated_at,
  };
}

function decorateInteractiveSession(
  session: InteractiveSession,
  user: User,
  env: RuntimeEnv,
): InteractiveSession {
  const now = Date.now();
  const delegatedControl = canGrantDelegatedControl(env, session);
  const canManage = canManageInteractiveSession(user, session);
  const canChangeMultiplayer = canChangeInteractiveSessionMultiplayer(user, session);
  const canControl = canControlInteractiveSession(user, session, now, delegatedControl);
  const activeController = activeDelegatedController(session, now);
  const desktopActive = !["stopping", "stopped", "expired", "failed"].includes(session.status);
  const versionedDesktopReady = ["ready", "attached", "detached"].includes(session.status);
  const versionedDesktopAvailable =
    versionedDesktopReady &&
    session.adapter === runtimeAdapterName &&
    (session.capabilities.vnc || session.capabilities.desktop);
  const legacyDesktopUrl = desktopActive ? safeDesktopUrl(session.vncUrl) : null;
  const routeKind = interactivePtyRouteKind(env, session);
  const routeAvailable =
    session.runtime === githubActionsRuntime ||
    (routeKind === "sandbox"
      ? Boolean(env.SANDBOX)
      : Boolean(interactiveTerminalTarget(env, session, routeKind)));
  const ptyAvailable =
    canControl &&
    session.capabilities.terminal &&
    ["ready", "attached", "detached"].includes(session.status) &&
    routeAvailable;
  const attachUrl = ptyAvailable ? "/api/terminal/ws" : null;
  const codexSshReady =
    session.adapter === runtimeAdapterName &&
    session.capabilities.terminal &&
    ["ready", "attached", "detached"].includes(session.status) &&
    Boolean(session[interactiveSessionAdapterControlPlane]) &&
    configuredRuntimeAdapterControlPlane(env, session.profile) ===
      session[interactiveSessionAdapterControlPlane];
  const runtimeProfile = runtimeProfileByID(deploymentConfig(env).runtimeProfiles, session.profile);
  const codexSsh =
    canManage && codexSshReady
      ? resolveRuntimeProfileCodexSsh(runtimeProfile, {
          providerResourceId: session.providerResourceId,
          workspaceId: session.adapterWorkspaceId,
          sessionId: session.id,
          profile: session.profile,
        })
      : null;
  return {
    ...session,
    adapter: canControl ? session.adapter : null,
    profile: canControl ? session.profile : "",
    adapterWorkspaceId: canControl ? session.adapterWorkspaceId : null,
    providerResourceId: canControl ? session.providerResourceId : null,
    lastReconciledAt: canControl ? session.lastReconciledAt : null,
    reconcileError: canControl ? session.reconcileError : null,
    leaseId: canControl ? legacyInteractiveSessionLeaseId(session) : null,
    attachUrl,
    ptyAvailable,
    codexSsh,
    vncUrl: canControl
      ? versionedDesktopAvailable
        ? runtimeAdapterBrowserVncUrl(browserAppOrigin(env), session.id)
        : legacyDesktopUrl
      : null,
    controller: activeController,
    controlGrantedAt: activeController ? session.controlGrantedAt : null,
    controlExpiresAt: activeController ? session.controlExpiresAt : null,
    canManage,
    canChangeMultiplayer,
    canControl,
    canRequestControl: delegatedControl && !canControl,
  };
}

function canChangeInteractiveSessionMultiplayer(user: User, session: InteractiveSession): boolean {
  return userActorCandidates(user).has(session.owner);
}

function canManageInteractiveSession(user: User, session: InteractiveSession): boolean {
  return (
    userActorCandidates(user).has(session.owner) ||
    user.role === "maintainer" ||
    user.role === "owner"
  );
}

function userActorCandidates(user: User): Set<string> {
  return new Set(
    [actor(user), user.subject, user.login, user.email].filter((value): value is string =>
      Boolean(value),
    ),
  );
}

function canControlInteractiveSession(
  user: User,
  session: InteractiveSession,
  now: number,
  delegatedControl = true,
): boolean {
  if (canManageInteractiveSession(user, session)) return true;
  if (!delegatedControl) return false;
  const userActor = actor(user);
  return (
    session.controller === userActor &&
    typeof session.controlExpiresAt === "number" &&
    session.controlExpiresAt > now
  );
}

function activeDelegatedController(session: InteractiveSession, now: number): string | null {
  if (!session.controller) return null;
  if (typeof session.controlExpiresAt !== "number" || session.controlExpiresAt <= now) return null;
  return session.controller;
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

function shareToken(): string {
  const first = crypto.randomUUID().replaceAll("-", "");
  const second = crypto.randomUUID().replaceAll("-", "");
  return `${first}${second}`;
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

function htmlEscape(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
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

function joinUrl(base: string, path: string): string {
  try {
    return new URL(path, base.endsWith("/") ? base : `${base}/`).toString();
  } catch {
    return "";
  }
}

function addQuery(rawUrl: string, params: Record<string, string>): string {
  try {
    const url = new URL(rawUrl);
    for (const [key, value] of Object.entries(params)) {
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  } catch {
    return "";
  }
}

function httpToWebSocketUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.protocol === "http:") url.protocol = "ws:";
    if (url.protocol === "https:") url.protocol = "wss:";
    return url.toString();
  } catch {
    return "";
  }
}

function sandboxIdForSession(id: string): string {
  return clean(`crabbox-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 63);
}

function newSandboxLease(id: string): { sandboxId: string; terminalSessionId: string } {
  const suffix = crypto.randomUUID().slice(0, 8).toLowerCase();
  const base = sandboxIdForSession(id);
  const sandboxId = `${base.slice(0, 63 - suffix.length - 1)}-${suffix}`;
  return {
    sandboxId,
    terminalSessionId: sandboxTerminalSessionId(id, suffix),
  };
}

function sandboxLeaseId(lease: { sandboxId: string; terminalSessionId: string }): string {
  return `${sandboxLeasePrefix}${lease.sandboxId}:${lease.terminalSessionId}:${sandboxLeaseProfile}`;
}

function isCurrentSandboxLease(leaseId: string | null | undefined): boolean {
  return (
    leaseId?.startsWith(sandboxLeasePrefix) === true && leaseId.endsWith(`:${sandboxLeaseProfile}`)
  );
}

function sandboxLeaseRefreshStartedAt(leaseId: string): number | null {
  const match = /:refreshing-(\d+)-[a-f0-9]+$/.exec(leaseId);
  return match ? Number(match[1]) : null;
}

function sandboxLeaseWithoutRefresh(leaseId: string): string {
  return leaseId.replace(/:refreshing-\d+-[a-f0-9]+$/, "");
}

function sandboxLeaseInfo(
  session: Pick<InteractiveSession | InteractiveProvisionRequest, "id"> & {
    leaseId?: string | null;
    adapter?: string | null;
  },
): { sandboxId: string; terminalSessionId: string } {
  const rawLease = legacyLeaseIdForAdapter(session.adapter ?? null, session.leaseId ?? null);
  const raw = rawLease?.startsWith(sandboxLeasePrefix)
    ? rawLease.slice(sandboxLeasePrefix.length)
    : "";
  const [sandboxId, terminalSessionId] = raw.split(":");
  const fallbackSandboxId = clean(sandboxId, 80) || sandboxIdForSession(session.id);
  return {
    sandboxId: fallbackSandboxId,
    terminalSessionId: clean(terminalSessionId, 100) || sandboxTerminalSessionId(session.id),
  };
}

function sandboxTerminalSessionId(id: string, suffix?: string): string {
  const base = clean(`terminal-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 80);
  if (!suffix) return base;
  return `${base.slice(0, 80 - suffix.length - 1)}-${suffix}`;
}

function sandboxSetupSessionId(id: string): string {
  return clean(`setup-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 80);
}

function sandboxWorkdir(id: string): string {
  return `/workspace/${sandboxIdForSession(id)}`;
}

function sandboxAutostartScriptPath(id: string): string {
  return `/tmp/.crabbox-autostart-${sandboxIdForSession(id)}.sh`;
}

function sandboxTerminalShellPath(id: string): string {
  return `/tmp/.crabbox-terminal-${sandboxIdForSession(id)}.sh`;
}

function sandboxCheckoutErrorPath(id: string): string {
  return `/tmp/crabbox-checkout-error-${sandboxIdForSession(id)}.txt`;
}

function sandboxBashrcMarker(
  session: Pick<InteractiveSession | InteractiveProvisionRequest, "id">,
): string {
  return `# crabbox session ${session.id} autostart-v4`;
}

function terminalSize(request: Request, name: "cols" | "rows", fallback: number): number {
  const url = new URL(request.url);
  const value = Number(url.searchParams.get(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(300, Math.max(10, Math.trunc(value)));
}

function terminalDimension(value: number | null, fallback: number): number {
  if (!Number.isFinite(value ?? Number.NaN)) return fallback;
  return Math.min(300, Math.max(10, Math.trunc(value as number)));
}

function terminalCloseMessage(code: number, reason: string): string {
  const suffix = reason ? `: ${clean(redactedAdapterMessage(reason, "detached"), 120)}` : "";
  return `PTY detached ${code || 1000}${suffix}`;
}

function isPassiveTerminalClose(reason: string | undefined): boolean {
  return (
    reason === "unsubscribed" || reason === "client closed" || reason === "no terminals mounted"
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function compactEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

type SandboxErrorDetails = {
  code?: CloudflareSandboxSessionError["code"];
  context?: unknown;
};

function isSandboxSessionAlreadyExists(error: unknown, sessionId: string): boolean {
  return hasSandboxSessionErrorCode(error, "SESSION_ALREADY_EXISTS", sessionId);
}

function isSandboxSessionAlreadyGone(error: unknown, sessionId: string): boolean {
  return (
    hasSandboxSessionErrorCode(error, "SESSION_DESTROYED", sessionId) ||
    hasSandboxSessionErrorCode(error, "SESSION_TERMINATED", sessionId) ||
    hasSandboxSessionErrorCode(error, "FILE_NOT_FOUND", sessionId) ||
    sandboxSessionNotFoundMessage(error, sessionId)
  );
}

function hasSandboxSessionErrorCode(
  error: unknown,
  code: CloudflareSandboxSessionError["code"],
  sessionId: string,
): boolean {
  const response = sandboxErrorResponse(error);
  if (response?.code !== code) return false;
  const responseSessionId = sandboxErrorSessionId(response);
  return responseSessionId === null || responseSessionId === sessionId;
}

function sandboxErrorResponse(error: unknown): SandboxErrorDetails | null {
  if (!error || typeof error !== "object") return null;
  const response = (error as { errorResponse?: unknown }).errorResponse;
  if (response && typeof response === "object") {
    return response as SandboxErrorDetails;
  }
  return error as SandboxErrorDetails;
}

function sandboxErrorSessionId(response: SandboxErrorDetails): string | null {
  const context = response.context;
  if (!context || typeof context !== "object") return null;
  const sessionId = (context as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" ? sessionId : null;
}

function sandboxSessionNotFoundMessage(error: unknown, sessionId: string): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return (
    message === `Session '${sessionId}' not found` || message === `Session "${sessionId}" not found`
  );
}

async function createNewSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  return sandbox.createSession({
    id,
    cwd,
    env: compactEnvVars(env),
    commandTimeoutMs: 300_000,
  });
}

async function createSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    return sandbox.getSession(id);
  }
}

async function createFreshSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    await sandbox.deleteSession(id);
  } catch (error) {
    if (!isSandboxSessionAlreadyGone(error, id)) throw error;
  }
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    throw new Error(`fresh sandbox session ${id} still exists after delete`, { cause: error });
  }
}

async function runSandboxSetupStep(step: string, operation: () => Promise<unknown>): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : String(error), 500);
    throw new Error(`${step}: ${message || "failed"}`);
  }
}

function interactiveCommand(value: unknown): string {
  return (
    clean(value, 240)
      .replace(/\s+/g, " ")
      .replace(/--yolosandbox\b/g, "--yolo")
      .trim() || defaultInteractiveCommand
  );
}

function directPortUrl(base: string, port: unknown, path: string): string | null {
  const parsedPort = Number(port);
  if (!Number.isInteger(parsedPort) || parsedPort <= 0) return null;
  try {
    const url = new URL(path, base.endsWith("/") ? base : `${base}/`);
    url.port = String(parsedPort);
    return url.toString();
  } catch {
    return null;
  }
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
