import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  sql,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Generated,
  type QueryResult,
} from "kysely";
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
import { buildFleetState, type FleetSandboxPolicySummary, type FleetState } from "./fleet-state";
import { githubRequestCanUseRepoCredential, matchesAnyHost } from "./sandbox-security";
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

type Role = "viewer" | "maintainer" | "owner";

const defaultInteractiveCommand = "codex --yolo";

type RuntimeEnv = Env & {
  DB: D1Database;
  BACKUP_BUCKET?: R2Bucket;
  SESSION_LOGS?: R2Bucket;
  SANDBOX?: DurableObjectNamespace<CloudflareSandbox>;
  SESSION_CONTROL?: DurableObjectNamespace<SessionControlDO>;
  CRABBOX_BOOTSTRAP_TOKEN?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_TOKEN?: string;
  GITHUB_ORG?: string;
  CRABBOX_INTERACTIVE_PROVISION_URL?: string;
  CRABBOX_INTERACTIVE_PROVISION_TOKEN?: string;
  CRABBOX_RUNTIME_PROVISION_URL?: string;
  CRABBOX_RUNTIME_PROVISION_TOKEN?: string;
  CRABBOX_CLOUDFLARE_RUNNER_URL?: string;
  CRABBOX_CLOUDFLARE_RUNNER_TOKEN?: string;
  CRABBOX_CLOUDFLARE_RUNNER_INSTANCE_TYPE?: string;
  CRABBOX_CLOUDFLARE_RUNNER_WORKDIR?: string;
  CRABBOX_CLOUDFLARE_RUNNER_TTL_SECONDS?: string;
  CRABBOX_CLOUDFLARE_RUNNER_IDLE_SECONDS?: string;
  CRABBOX_PTY_BRIDGE_URL?: string;
  CRABBOX_PTY_BRIDGE_TOKEN?: string;
  CRABBOX_CLAWFLEET_URL?: string;
  CRABBOX_CLAWFLEET_TOKEN?: string;
  CRABBOX_CLAWFLEET_PUBLIC_URL?: string;
  CRABBOX_SSH_GATEWAY_TOKEN?: string;
  CRABFLEET_SSH_GATEWAY_TOKEN?: string;
  CRABBOX_OPENCLAW_TOKEN?: string;
  CRABBOX_TOKEN_ENCRYPTION_KEY?: string;
  BACKUP_BUCKET_NAME?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  CRABFLEET_LOCAL_SANDBOX_BACKUPS?: string;
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OPENAI_ORG_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
};

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

type User = {
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  allowed: boolean;
  teams: string[];
};

type GitHubProfile = {
  id: number;
  login: string;
  email: string | null;
  name: string | null;
};

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

type WorkflowStatus = "ok" | "missing" | "invalid" | "error";

type WorkflowConfig = {
  runtime?: string;
  policy?: string;
  stallMs?: number;
  cap?: number;
  promptPrefix?: string;
};

type RuntimeCapabilities = {
  terminal: boolean;
  takeover: boolean;
  vnc: boolean;
  desktop: boolean;
  logs: boolean;
  artifacts: boolean;
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

type RunStatus =
  | "queued"
  | "leasing"
  | "running"
  | "review"
  | "completed"
  | "failed"
  | "stalled"
  | "canceled";

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

type InteractiveSessionStatus =
  | "provisioning"
  | "pending_adapter"
  | "ready"
  | "attached"
  | "detached"
  | "stopped"
  | "expired"
  | "failed";

type InteractiveSession = {
  id: string;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  command: string;
  prompt: string;
  owner: string;
  status: InteractiveSessionStatus;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  lastEvent: string;
  createdAt: number;
  updatedAt: number;
  lastSeenAt: number;
  stoppedAt: number | null;
  shareMode: "private" | "link_read";
  shareTokenPreview: string | null;
  controlRequestedBy: string | null;
  controlRequestedAt: number | null;
  controller: string | null;
  controlGrantedAt: number | null;
  controlExpiresAt: number | null;
  multiplayerMode: boolean;
  canControl?: boolean;
  canManage?: boolean;
  canChangeMultiplayer?: boolean;
  canRequestControl?: boolean;
  sharedReadOnly?: boolean;
  logs: string[];
  logArchive: InteractiveSessionLogArchive | null;
};

type InteractiveSessionLogArchive = {
  sessionId: string;
  eventCount: number;
  eventsKey: string | null;
  transcriptKey: string | null;
  summaryKey: string | null;
  archivedAt: number;
  updatedAt: number;
};

type InteractiveSessionEvent = {
  actor: string;
  message: string;
  createdAt: number;
};

type InteractiveSessionEventRow = {
  id: number;
  session_id: string;
  actor: string;
  message: string;
  created_at: number;
};

type SandboxRuntimeSession = (InteractiveProvisionRequest | InteractiveSession) & {
  githubToken?: string;
};

type InteractiveProvisionRequest = {
  id: string;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  command: string;
  prompt: string;
  owner: string;
  githubToken?: string;
};

type InteractiveProvisionResult = {
  status: InteractiveSessionStatus;
  leaseId: string | null;
  attachUrl: string | null;
  vncUrl: string | null;
  message: string;
};

type SandboxCredentialPolicy = {
  allowedHosts: string[];
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
};

type PendingTerminalSubscription = {
  unsubscribeRequested: boolean;
};

type TerminalUpstream = {
  socket: WebSocket;
  markConnected: () => Promise<void>;
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

type SettingsTable = {
  key: string;
  value: string;
};

type AllowEntryTable = {
  value: string;
  role: Role;
  created_at: number;
  updated_at: number;
};

type RepoTable = {
  repo: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

type UserTable = {
  subject: string;
  login: string | null;
  email: string | null;
  name: string | null;
  role: Role;
  allowed: number;
  teams: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
};

type SessionTable = {
  token_hash: string;
  subject: string;
  expires_at: number;
  created_at: number;
  github_token_ciphertext: string | null;
};

type CardTable = {
  id: string;
  title: string;
  prompt: string;
  repo: string;
  source: string;
  runtime: string;
  policy: string;
  lane: string;
  owner: string;
  started_at: number | null;
  created_at: number;
  updated_at: number;
  last_event: string | null;
  changed_files: string;
  diff_patch: string;
  active_run_id: string | null;
};

type RunAttemptTable = {
  id: string;
  card_id: string;
  attempt: number;
  runtime: string;
  status: RunStatus;
  control_intent: string | null;
  lease_id: string | null;
  attach_url: string | null;
  vnc_url: string | null;
  selection_reason: string | null;
  capabilities_json: string;
  operator: string | null;
  last_heartbeat_at: number;
  started_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
  error: string | null;
};

type InteractiveSessionTable = {
  id: string;
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  command: string;
  prompt: string;
  owner: string;
  status: InteractiveSessionStatus;
  lease_id: string | null;
  attach_url: string | null;
  vnc_url: string | null;
  last_event: string;
  created_at: number;
  updated_at: number;
  last_seen_at: number;
  stopped_at: number | null;
  share_mode: "private" | "link_read";
  share_token_hash: string | null;
  share_token_preview: string | null;
  control_requested_by: string | null;
  control_requested_at: number | null;
  controller: string | null;
  control_granted_at: number | null;
  control_expires_at: number | null;
  multiplayer_mode: number;
};

type RepoWorkflowTable = {
  repo: string;
  status: WorkflowStatus;
  source_path: string;
  source_sha: string | null;
  config_json: string;
  prompt: string;
  error: string | null;
  evaluated_at: number;
  updated_at: number;
};

type EventTable = {
  id: Generated<number>;
  card_id: string;
  actor: string;
  message: string;
  created_at: number;
};

type InteractiveSessionEventTable = {
  id: Generated<number>;
  session_id: string;
  actor: string;
  message: string;
  created_at: number;
};

type InteractiveSessionLogArchiveTable = {
  session_id: string;
  event_count: number;
  events_key: string | null;
  transcript_key: string | null;
  summary_key: string | null;
  archived_at: number;
  updated_at: number;
};

type AuditEventTable = {
  id: Generated<number>;
  actor: string;
  message: string;
  created_at: number;
};

type SshKeyTable = {
  fingerprint: string;
  subject: string;
  public_key: string;
  label: string | null;
  github_token_ciphertext: string | null;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
};

type SshLinkCodeTable = {
  code_hash: string;
  fingerprint: string;
  public_key: string;
  label: string | null;
  remote_ip: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

type Database = {
  settings: SettingsTable;
  allow_entries: AllowEntryTable;
  repos: RepoTable;
  users: UserTable;
  sessions: SessionTable;
  cards: CardTable;
  run_attempts: RunAttemptTable;
  interactive_sessions: InteractiveSessionTable;
  interactive_session_events: InteractiveSessionEventTable;
  interactive_session_log_archives: InteractiveSessionLogArchiveTable;
  repo_workflows: RepoWorkflowTable;
  events: EventTable;
  audit_events: AuditEventTable;
  ssh_keys: SshKeyTable;
  ssh_link_codes: SshLinkCodeTable;
};

type CompilableQuery = {
  compile(): CompiledQuery;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const terminalInputStates = new Map<string, TerminalInputState>();
const sessionCookie = "crabbox_session";
const oauthStateCookie = "crabbox_oauth_state";
const sshLinkCookie = "crabbox_ssh_link";
const bootstrapSessionSeconds = 60 * 60;
const githubSessionSeconds = 60 * 15;
const sshLinkSeconds = 5 * 60;
const terminalClipboardMaxBytes = 10 * 1024 * 1024;
const lanes = ["Todo", "Running", "Human Review", "Done"];
const preferredRepo = "openclaw/crabfleet";
const appCanonicalHost = "clawfleet.openclaw.ai";
const appCanonicalOrigin = `https://${appCanonicalHost}`;
const appRedirectHosts = new Set([
  "crabfleet.ai",
  "www.crabfleet.ai",
  "crabfleet.openclaw.ai",
  "crabyard.openclaw.ai",
  "crabbox-ai.services-91b.workers.dev",
]);
const sandboxLeasePrefix = "sandbox:";
const sandboxLeaseProfile = "autostart-v4";
const activeRunStatuses: readonly RunStatus[] = ["queued", "leasing", "running"];
const interactiveSessionStatuses: readonly InteractiveSessionStatus[] = [
  "provisioning",
  "pending_adapter",
  "ready",
  "attached",
  "detached",
  "stopped",
  "expired",
  "failed",
];
const deadInteractiveSessionStatuses: readonly InteractiveSessionStatus[] = [
  "stopped",
  "expired",
  "failed",
];
const roleOptions = new Set<Role>(["viewer", "maintainer", "owner"]);
const runtimeOptions = ["auto", "container", "crabbox"] as const;
const mergePolicyOptions = ["open_pr", "merge_when_green", "fix_until_green_and_merge"] as const;
const defaultStallMs = 5 * 60 * 1000;
const workflowCacheMs = 60 * 60 * 1000;
const containerCapabilities: RuntimeCapabilities = {
  terminal: true,
  takeover: false,
  vnc: false,
  desktop: false,
  logs: true,
  artifacts: true,
};
const crabboxCapabilities: RuntimeCapabilities = {
  terminal: true,
  takeover: true,
  vnc: true,
  desktop: true,
  logs: true,
  artifacts: true,
};

class D1Dialect implements Dialect {
  constructor(private readonly d1: D1Database) {}

  createDriver(): Driver {
    return new D1Driver(this.d1);
  }

  createQueryCompiler(): SqliteQueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): SqliteAdapter {
    return new SqliteAdapter();
  }

  createIntrospector(db: Kysely<unknown>): DatabaseIntrospector {
    return new SqliteIntrospector(db);
  }
}

class D1Driver implements Driver {
  private readonly connection: D1Connection;

  constructor(d1: D1Database) {
    this.connection = new D1Connection(d1);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return this.connection;
  }

  async beginTransaction(): Promise<void> {
    throw new Error("D1 batch transactions are not exposed through this Kysely dialect");
  }

  async commitTransaction(): Promise<void> {}

  async rollbackTransaction(): Promise<void> {}

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {}
}

class D1Connection implements DatabaseConnection {
  constructor(private readonly d1: D1Database) {}

  async executeQuery<R>(compiledQuery: CompiledQuery): Promise<QueryResult<R>> {
    const statement = this.d1.prepare(compiledQuery.sql).bind(...compiledQuery.parameters);
    if (isReadQuery(compiledQuery.sql)) {
      const result = await statement.all<R>();
      return { rows: result.results ?? [] };
    }

    const result = await statement.run();
    const changes = result.meta.changes;
    const lastRowId = result.meta.last_row_id;
    const queryResult: QueryResult<R> = { rows: [] };
    if (typeof changes === "number") {
      Object.assign(queryResult, { numAffectedRows: BigInt(changes) });
    }
    if (typeof lastRowId === "number") {
      Object.assign(queryResult, { insertId: BigInt(lastRowId) });
    }
    return queryResult;
  }

  async *streamQuery<R>(compiledQuery: CompiledQuery): AsyncIterableIterator<QueryResult<R>> {
    yield await this.executeQuery<R>(compiledQuery);
  }
}

function database(env: RuntimeEnv): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect(env.DB) });
}

async function executeBatch(env: RuntimeEnv, queries: readonly CompilableQuery[]): Promise<void> {
  await env.DB.batch(
    queries.map((query) => {
      const compiled = query.compile();
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
}

function isReadQuery(sqlText: string): boolean {
  return /^(?:select|with|pragma)\b/i.test(sqlText.trim());
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

async function sandboxCredentialPolicy(
  env: RuntimeEnv,
  sandboxId: string,
): Promise<SandboxCredentialPolicy | null> {
  const stub = sandboxControlStub(env);
  if (!stub) return null;
  const response = await stub.fetch(
    `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(sandboxId)}`,
  );
  if (!response.ok) return null;
  return (await response.json()) as SandboxCredentialPolicy;
}

async function sandboxOutbound(
  request: Request,
  env: RuntimeEnv,
  context: SandboxOutboundContext,
): Promise<Response> {
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const policy = await sandboxCredentialPolicy(env, context.containerId);
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
      if (request.method === "POST" && url.pathname === "/api/session-control/register") {
        const policy = (await request.json()) as SandboxCredentialPolicy;
        await this.ctx.storage.put(sandboxPolicyKey(policy.sandboxId), policy);
        return json({ ok: true });
      }

      if (request.method === "GET" && url.pathname === "/api/session-control/policies") {
        const entries = await this.ctx.storage.list<SandboxCredentialPolicy>({
          prefix: "sandbox:",
        });
        const policies = dedupeSandboxPolicies([...entries.values()]).map((policy) =>
          redactSandboxPolicy(policy, Boolean(this.env.GITHUB_TOKEN)),
        );
        return json({ policies });
      }

      const egressMatch = url.pathname.match(/^\/api\/session-control\/egress\/([^/]+)$/);
      if (request.method === "GET" && egressMatch) {
        const sandboxId = decodeURIComponent(egressMatch[1] ?? "");
        const policy = await this.ctx.storage.get<SandboxCredentialPolicy>(
          sandboxPolicyKey(sandboxId),
        );
        return policy ? json(policy) : json({ error: "not found" }, { status: 404 });
      }

      const sandboxMatch = url.pathname.match(/^\/api\/session-control\/sandbox\/([^/]+)$/);
      if (request.method === "DELETE" && sandboxMatch) {
        await this.ctx.storage.delete(sandboxPolicyKey(decodeURIComponent(sandboxMatch[1] ?? "")));
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
  async fetch(request: Request, env: RuntimeEnv): Promise<Response> {
    const url = new URL(request.url);

    try {
      const canonicalRedirect = canonicalAppRedirect(url);
      if (canonicalRedirect) return canonicalRedirect;

      if (url.pathname === "/healthz") {
        return text("ok\n", "text/plain; charset=utf-8");
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
        return await sshLink(request, env, decodeURIComponent(sshLinkMatch[1] ?? ""));
      }

      if (url.pathname.startsWith("/api/")) {
        return await api(request, env);
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
} satisfies ExportedHandler<RuntimeEnv>;

async function api(request: Request, env: RuntimeEnv): Promise<Response> {
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
    return json({ auth: authMethods(env, request) });
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

  if (request.method === "POST" && url.pathname === "/api/ssh/interactive-sessions") {
    return json(await sshCreateInteractiveSession(request, env), { status: 201 });
  }

  const sshInteractiveReadMatch = url.pathname.match(/^\/api\/ssh\/interactive-sessions\/([^/]+)$/);
  if (request.method === "GET" && sshInteractiveReadMatch) {
    const user = await requireSshGatewayUser(request, env);
    requireRole(user, "viewer");
    const session = await readInteractiveSession(
      env,
      decodeURIComponent(sshInteractiveReadMatch[1] ?? ""),
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

  if (request.method === "POST" && url.pathname === "/api/openclaw/crabboxes") {
    return json(await openClawCreateCrabbox(request, env), { status: 201 });
  }

  const sshInteractivePtyMatch = url.pathname.match(
    /^\/api\/ssh\/interactive-sessions\/([^/]+)\/pty$/,
  );
  if (request.method === "GET" && sshInteractivePtyMatch) {
    const user = await requireSshGatewayUser(request, env);
    return interactiveSessionPty(
      request,
      env,
      user,
      decodeURIComponent(sshInteractivePtyMatch[1] ?? ""),
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
    return interactiveTerminalHub(request, env, await optionalUser(request, env));
  }

  const user = await requireUser(request, env);

  if (request.method === "GET" && url.pathname === "/api/session") {
    return json({ user, auth: authMethods(env, request) });
  }

  if (request.method === "GET" && url.pathname === "/api/state") {
    return json(await readState(request, env, user));
  }

  if (request.method === "GET" && url.pathname === "/api/fleet") {
    requireRole(user, "viewer");
    return json({ fleet: await readFleetState(env, user) });
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
    const session = await readInteractiveSession(
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

  const interactivePtyMatch = url.pathname.match(/^\/api\/interactive-sessions\/([^/]+)\/pty$/);
  if (request.method === "GET" && interactivePtyMatch) {
    requireRole(user, "viewer");
    return interactiveSessionPty(
      request,
      env,
      user,
      decodeURIComponent(interactivePtyMatch[1] ?? ""),
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
  if (!isLocalDevRequest(request)) return json({ error: "not found" }, { status: 404 });

  const body = await readJson<{ id?: string; name?: string; role?: string }>(request);
  const id = devIdentityId(body.id);
  const role = roleOptions.has(body.role as Role) ? (body.role as Role) : "owner";
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

async function githubLogin(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text("GitHub OAuth is not configured.\n", "text/plain; charset=utf-8", {}, 503);
  }

  const url = new URL(request.url);
  const redirectUri = `${url.origin}/auth/github/callback`;
  const state = crypto.randomUUID();
  const target = new URL("https://github.com/login/oauth/authorize");
  target.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  target.searchParams.set("redirect_uri", redirectUri);
  target.searchParams.set("scope", "read:user read:org repo");
  target.searchParams.set("state", state);

  return redirect(target.toString(), {
    "set-cookie": cookie(request, oauthStateCookie, state, 600),
  });
}

async function githubCallback(request: Request, env: RuntimeEnv): Promise<Response> {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    return text("GitHub OAuth is not configured.\n", "text/plain; charset=utf-8", {}, 503);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state || state !== cookies(request).get(oauthStateCookie)) {
    return text("Invalid OAuth state.\n", "text/plain; charset=utf-8", {}, 400);
  }

  const redirectUri = `${url.origin}/auth/github/callback`;
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "user-agent": "crabbox-ai",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri,
      state,
    }),
  });
  const tokenBody = await tokenResponse.json<{ access_token?: string; error?: string }>();
  if (!tokenBody.access_token) {
    return text(
      tokenBody.error ?? "OAuth token exchange failed.\n",
      "text/plain; charset=utf-8",
      {},
      401,
    );
  }

  const freshUser = await refreshGitHubUser(env, tokenBody.access_token).catch(() => {
    throw serviceUnavailable("GitHub membership refresh failed; retry later");
  });
  if (!freshUser) {
    return text(
      "GitHub user is not an active OpenClaw org member.\n",
      "text/plain; charset=utf-8",
      {},
      403,
    );
  }
  const authorized = await authorize(env, freshUser);
  if (!authorized.allowed) {
    return text(
      "GitHub user is not in the Crabfleet allowlist.\n",
      "text/plain; charset=utf-8",
      {},
      403,
    );
  }

  const now = Date.now();
  await upsertUser(env, authorized, now);
  const session = await createSession(
    env,
    request,
    authorized.subject,
    now,
    githubSessionSeconds,
    tokenBody.access_token,
  );
  const pendingSshCode = cookies(request).get(sshLinkCookie);
  return redirect(
    pendingSshCode ? `/ssh/link/${encodeURIComponent(pendingSshCode)}` : "/app?login=github",
    {
      "set-cookie": session,
    },
  );
}

async function sshLink(request: Request, env: RuntimeEnv, code: string): Promise<Response> {
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
    const user = await requireUser(request, env);
    if (!user.subject.startsWith("github:")) {
      throw forbidden("Sign in with GitHub before linking an SSH key");
    }
    const githubToken = await sessionGitHubToken(request, env);
    if (!githubToken) {
      throw forbidden("Sign in with GitHub again before linking an SSH key");
    }
    await consumeSshLink(env, user, code, Date.now(), githubToken);
    return redirect("/app?ssh=linked&login=github", {
      "set-cookie": cookie(request, sshLinkCookie, "", 0),
    });
  }

  const user = await optionalUser(request, env);
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

async function logout(request: Request, env: RuntimeEnv): Promise<Response> {
  const token = cookies(request).get(sessionCookie);
  if (token) {
    await database(env)
      .deleteFrom("sessions")
      .where("token_hash", "=", await sha256(token))
      .execute();
  }
  return json({ ok: true }, { headers: { "set-cookie": cookie(request, sessionCookie, "", 0) } });
}

async function requireUser(request: Request, env: RuntimeEnv): Promise<User> {
  const token = cookies(request).get(sessionCookie);
  if (!token) throw unauthorized();
  const tokenHash = await sha256(token);
  const db = database(env);
  const row = await db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.subject", "s.subject")
    .select(["u.subject", "u.login", "u.email", "u.name", "u.role", "u.allowed", "u.teams"])
    .where("s.token_hash", "=", tokenHash)
    .where("s.expires_at", ">", Date.now())
    .executeTakeFirst();
  if (!row) throw unauthorized();

  const user = {
    subject: row.subject,
    login: row.login,
    email: row.email,
    name: row.name,
    role: row.role,
    allowed: row.allowed === 1,
    teams: parseJson(row.teams, []),
  };

  if (user.subject.startsWith("bootstrap:")) {
    if (!env.CRABBOX_BOOTSTRAP_TOKEN || user.subject !== (await bootstrapSubject(env))) {
      await db.deleteFrom("sessions").where("token_hash", "=", tokenHash).execute();
      throw unauthorized();
    }
    return user;
  }

  if (user.subject.startsWith("dev:")) {
    if (!isLocalDevRequest(request)) {
      await db.deleteFrom("sessions").where("token_hash", "=", tokenHash).execute();
      throw unauthorized();
    }
    return user;
  }

  if (!user.subject.startsWith("github:")) return user;

  const authorized = await authorize(env, user);
  if (!authorized.allowed) {
    await db.deleteFrom("sessions").where("token_hash", "=", tokenHash).execute();
    throw forbidden("user is no longer allowlisted");
  }
  if (authorized.role !== user.role || authorized.allowed !== user.allowed) {
    await upsertUser(env, authorized, Date.now());
  }
  return authorized;
}

async function optionalUser(request: Request, env: RuntimeEnv): Promise<User | null> {
  try {
    return await requireUser(request, env);
  } catch (error) {
    const status =
      typeof error === "object" && error && "status" in error ? Number(error.status) : 0;
    const url = new URL(request.url);
    if (
      status === 401 ||
      (status === 403 && url.pathname === "/api/terminal/ws" && url.searchParams.has("token"))
    ) {
      return null;
    }
    throw error;
  }
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
    await database(env)
      .updateTable("ssh_keys")
      .set({ last_used_at: now })
      .where("fingerprint", "=", fingerprint)
      .execute();
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
  const linkUrl = new URL(request.url);
  linkUrl.pathname = `/ssh/link/${encodeURIComponent(code)}`;
  linkUrl.search = "";
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
    command?: string;
    prompt?: string;
  }>(request);
  if (!normalizeRepo(body.repo)) {
    const repo = await database(env)
      .selectFrom("repos")
      .select("repo")
      .where("enabled", "=", 1)
      .orderBy("repo")
      .executeTakeFirst();
    body.repo = repo?.repo ?? preferredRepo;
  }
  const result = await createInteractiveSessionFromInput(env, user, body, githubToken);
  await audit(env, user, `ssh interactive session created ${result.session.id}`, Date.now());
  return result;
}

async function openClawCreateCrabbox(
  request: Request,
  env: RuntimeEnv,
): Promise<{ session: InteractiveSession }> {
  requireOpenClawService(request, env);
  const body = await readJson<{
    repo?: string;
    branch?: string;
    runtime?: string;
    command?: string;
    prompt?: string;
    owner?: string;
    githubToken?: string;
  }>(request);
  const owner = openClawOwner(body.owner);
  const serviceUser: User = {
    subject: "service:openclaw",
    login: "openclaw",
    email: null,
    name: "OpenClaw",
    role: "owner",
    allowed: true,
    teams: [],
  };
  const result = await createInteractiveSessionFromInput(
    env,
    serviceUser,
    body,
    clean(body.githubToken, 4000) || undefined,
    { owner },
  );
  await audit(
    env,
    serviceUser,
    `openclaw crabbox created ${result.session.id} owner=${owner}`,
    Date.now(),
  );
  return result;
}

function requireOpenClawService(request: Request, env: RuntimeEnv): void {
  if (!env.CRABBOX_OPENCLAW_TOKEN) {
    throw serviceUnavailable("OpenClaw service token is not configured");
  }
  if (request.headers.get("authorization") !== `Bearer ${env.CRABBOX_OPENCLAW_TOKEN}`) {
    throw unauthorized();
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

function sshGatewayTokens(env: RuntimeEnv): string[] {
  return [env.CRABFLEET_SSH_GATEWAY_TOKEN, env.CRABBOX_SSH_GATEWAY_TOKEN].filter(
    (token): token is string => Boolean(token),
  );
}

async function readState(
  request: Request,
  env: RuntimeEnv,
  user: User,
): Promise<Record<string, unknown>> {
  await reconcileStalledRuns(env, Date.now());
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
  const repoNames = sortRepos(repos.map((row) => row.repo));
  const fleet = await readFleetState(env, user, interactiveSessions);

  return {
    user,
    auth: authMethods(env, request),
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
): Promise<FleetState> {
  const [interactiveSessions, policyResult] = await Promise.all([
    sessions ? Promise.resolve(sessions) : readInteractiveSessions(env, user),
    readSandboxFleetPolicies(env),
  ]);
  return buildFleetState(interactiveSessions, policyResult.policies, {
    canonicalUrl: appCanonicalOrigin,
    productUrl: "https://clawfleet.ai",
    defaultEgressHosts: defaultSandboxEgressHosts,
    generatedAt: Date.now(),
    registryAvailable: policyResult.available,
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
  }>(request);
  const githubToken = await sessionGitHubToken(request, env);
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
    command?: string;
    prompt?: string;
  },
  githubToken?: string,
  options: { owner?: string } = {},
): Promise<{ session: InteractiveSession }> {
  const repo = normalizeRepo(body.repo);
  if (!repo) throw badRequest("repo is required");
  await requireRepo(env, repo);
  const branch = clean(body.branch, 120) || "main";
  const runtime = oneOf(body.runtime, ["crabbox", "container"], "container") as
    | "crabbox"
    | "container";
  const command = interactiveCommand(body.command);
  const prompt = clean(body.prompt, 4000);
  const owner = options.owner || actor(user);
  const now = Date.now();
  const db = database(env);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const id = await nextInteractiveSessionId(env);
    try {
      await db
        .insertInto("interactive_sessions")
        .values({
          id,
          repo,
          branch,
          runtime,
          command,
          prompt,
          owner,
          status: "provisioning",
          lease_id: null,
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
        })
        .execute();
      await appendInteractiveSessionEvent(env, id, user, "interactive workspace requested", now);
      const provisioned = await provisionInteractiveSession(env, {
        id,
        repo,
        branch,
        runtime,
        command,
        prompt,
        owner,
        ...(githubToken ? { githubToken } : {}),
      });
      if (provisioned) {
        await db
          .updateTable("interactive_sessions")
          .set({
            status: provisioned.status,
            lease_id: provisioned.leaseId,
            attach_url: provisioned.attachUrl,
            vnc_url: provisioned.vncUrl,
            last_event: provisioned.message,
            updated_at: now + 1,
          })
          .where("id", "=", id)
          .execute();
        await appendInteractiveSessionEvent(env, id, user, provisioned.message, now + 1);
      } else {
        await db
          .updateTable("interactive_sessions")
          .set({
            status: "pending_adapter",
            last_event: "waiting for interactive runtime adapter",
            updated_at: now + 1,
          })
          .where("id", "=", id)
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
      if (!isConstraintError(error) || attempt === 2) throw error;
    }
  }
  throw new Error("failed to allocate interactive session id");
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
    .where("status", "in", deadInteractiveSessionStatuses);
  if (ids.length) query = query.where("id", "in", ids);
  const removedSessions = (await query.execute())
    .map((row) => interactiveSession(row, []))
    .filter((session) => canManageInteractiveSession(user, session));
  const removedIds = removedSessions.map((session) => session.id);
  if (removedIds.length) {
    await Promise.all(
      removedSessions.map((session) => unregisterInteractiveSessionCredentialPolicy(env, session)),
    );
    const archives = await db
      .selectFrom("interactive_session_log_archives")
      .selectAll()
      .where("session_id", "in", removedIds)
      .execute();
    await Promise.all(archives.map((archive) => cleanupSessionLogArchiveObjects(env, archive)));
    await db
      .deleteFrom("interactive_session_log_archives")
      .where("session_id", "in", removedIds)
      .execute();
    await db
      .deleteFrom("interactive_session_events")
      .where("session_id", "in", removedIds)
      .execute();
    await db.deleteFrom("interactive_sessions").where("id", "in", removedIds).execute();
    await audit(env, user, `interactive sessions cleaned ${removedIds.join(",")}`, Date.now());
  }
  return { state: await readState(request, env, user), removedIds };
}

async function mutateInteractiveSession(
  request: Request,
  env: RuntimeEnv,
  user: User,
  id: string,
  action: string,
): Promise<{ session: InteractiveSession; shareUrl?: string }> {
  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  const now = Date.now();
  const userActor = actor(user);
  const canManage = canManageInteractiveSession(user, session);
  if (action === "attach") {
    if (!canControlInteractiveSession(user, session, now, canGrantDelegatedControl(env, session))) {
      throw forbidden("terminal control has not been granted");
    }
    if (["expired", "failed", "stopped"].includes(session.status)) {
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        status: nextStatus,
        last_seen_at: now,
        updated_at: now,
        last_event: message,
      })
      .where("id", "=", id)
      .where("status", "!=", "stopped")
      .execute();
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        share_mode: "link_read",
        share_token_hash: tokenHash,
        share_token_preview: preview,
        updated_at: now,
        last_event: "read-only share link enabled",
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(env, id, user, "read-only share link enabled", now);
    await audit(env, user, `interactive session share enabled ${id}`, now);
    return {
      session: decorateInteractiveSession(
        (await readInteractiveSession(env, id)) as InteractiveSession,
        user,
        env,
      ),
      shareUrl: shareUrl(request, id, token),
    };
  }

  if (action === "disable_share") {
    if (!canManage) throw forbidden("only the session owner or maintainer can disable sharing");
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        share_mode: "private",
        share_token_hash: null,
        share_token_preview: null,
        control_requested_by: null,
        control_requested_at: null,
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
        updated_at: now,
        last_event: "session sharing disabled",
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(env, id, user, "session sharing disabled", now);
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        multiplayer_mode: enabled ? 1 : 0,
        updated_at: now,
        last_event: message,
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(env, id, user, message, now);
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
    if (["expired", "failed", "stopped"].includes(session.status)) {
      throw badRequest(`session is ${session.status}`);
    }
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        control_requested_by: userActor,
        control_requested_at: now,
        updated_at: now,
        last_event: `${userActor} requested terminal control`,
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(
      env,
      id,
      user,
      `${userActor} requested terminal control`,
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        controller: session.controlRequestedBy,
        control_granted_at: now,
        control_expires_at: expires,
        control_requested_by: null,
        control_requested_at: null,
        updated_at: now,
        last_event: `control granted to ${session.controlRequestedBy}`,
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(
      env,
      id,
      user,
      `control granted to ${session.controlRequestedBy}`,
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        control_requested_by: null,
        control_requested_at: null,
        updated_at: now,
        last_event: requester
          ? `control request denied for ${requester}`
          : "control request denied",
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(
      env,
      id,
      user,
      requester ? `control request denied for ${requester}` : "control request denied",
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
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        controller: null,
        control_granted_at: null,
        control_expires_at: null,
        updated_at: now,
        last_event: "terminal control revoked",
      })
      .where("id", "=", id)
      .execute();
    await appendInteractiveSessionEvent(env, id, user, "terminal control revoked", now);
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
    await unregisterInteractiveSessionCredentialPolicy(env, session);
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        status: "stopped",
        stopped_at: now,
        controller: null,
        control_requested_by: null,
        control_requested_at: null,
        updated_at: now,
        last_event: "interactive workspace stopped",
      })
      .where("id", "=", id)
      .where("status", "!=", "stopped")
      .execute();
    await appendInteractiveSessionEvent(env, id, user, "interactive workspace stopped", now);
    await archiveInteractiveSessionLogs(env, id, now, { force: true }).catch(() => undefined);
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

async function unregisterSandboxCredentialPolicy(
  env: RuntimeEnv,
  sandboxId: string,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) return;
  await Promise.all(
    sandboxLookupIds(env, sandboxId).map((lookupId) =>
      stub.fetch(
        `https://crabfleet.internal/api/session-control/sandbox/${encodeURIComponent(lookupId)}`,
        { method: "DELETE" },
      ),
    ),
  );
}

async function unregisterInteractiveSessionCredentialPolicy(
  env: RuntimeEnv,
  session: Pick<InteractiveSession, "id" | "leaseId">,
): Promise<void> {
  if (session.leaseId?.startsWith(sandboxLeasePrefix)) {
    await unregisterSandboxCredentialPolicy(env, sandboxLeaseInfo(session).sandboxId);
  }
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
  if (!session.leaseId?.startsWith(sandboxLeasePrefix) || !env.SANDBOX) {
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

  const session = await readInteractiveSession(env, id);
  if (!session) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: "interactive session not found",
    });
    return;
  }
  if (["expired", "failed", "stopped"].includes(session.status)) {
    sendTerminalJson(client, TerminalMessageType.Error, id, {
      error: `session is ${session.status}`,
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
    const cols = canInputNow ? terminalDimension(subscription.cols, 120) : 120;
    const rows = canInputNow ? terminalDimension(subscription.rows, 34) : 34;
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
      const message = `terminal unavailable: ${
        error instanceof Error ? clean(error.message, 180) : "terminal connection failed"
      }`;
      if (session.leaseId?.startsWith(sandboxLeasePrefix) && env.SANDBOX) {
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
      void canView()
        .then((allowed) => {
          if (!allowed) revokeView();
        })
        .catch(() => revokeView());
    }, 5000);
    subscriptions.set(id, {
      session,
      upstream,
      canView,
      canInput,
      markClosing,
      viewCheck,
      cols,
      rows,
    });
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
            sendTerminalFrame(client, TerminalMessageType.Output, id, encoder.encode(data));
            return;
          }
          sendTerminalFrame(client, TerminalMessageType.Output, id, new Uint8Array(data));
        });
    });
    upstream.addEventListener("close", (event) => {
      const closeReason = consumeCloseReason();
      subscriptions.delete(id);
      if (viewCheck !== null) clearInterval(viewCheck);
      if (!isPassiveTerminalClose(closeReason)) {
        const message = terminalCloseMessage(event.code, event.reason);
        void markInteractiveTerminalDetached(env, user, id, Date.now(), message);
      }
      if (client.readyState === WebSocket.OPEN) {
        sendTerminalJson(client, TerminalMessageType.Event, id, {
          type: "closed",
          code: event.code,
          reason: closeReason || event.reason,
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
          session.leaseId?.startsWith(sandboxLeasePrefix) && env.SANDBOX
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
      error: error instanceof Error ? clean(error.message, 180) : "terminal subscription failed",
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
  const now = Date.now();
  if (session.leaseId?.startsWith(sandboxLeasePrefix) && env.SANDBOX) {
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

  const target = interactiveTerminalTarget(env, session);
  if (!target) throw serviceUnavailable("PTY bridge is not configured for this session");
  const upstreamResponse = await fetch(
    addQuery(target.url, { cols: String(cols), rows: String(rows) }),
    {
      headers: interactiveTerminalHeaders(session, target.authorization),
    },
  );
  const upstream = upstreamResponse.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    throw serviceUnavailable(`PTY bridge HTTP ${upstreamResponse.status}`);
  }
  upstream.accept();
  return {
    socket: upstream,
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
  if (!existing || ["expired", "failed", "stopped"].includes(existing.status)) return;
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
    .select(["id", "lease_id", "status"])
    .where("id", "=", id)
    .executeTakeFirst();
  if (!existing || ["expired", "failed", "stopped"].includes(existing.status)) return;
  const update = await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "expired",
      updated_at: now,
      stopped_at: now,
      last_event: message,
    })
    .where("id", "=", id)
    .where("status", "not in", ["expired", "failed", "stopped"])
    .executeTakeFirst();
  if ((update.numUpdatedRows ?? 0n) > 0n) {
    await unregisterInteractiveSessionCredentialPolicy(env, {
      id: existing.id,
      leaseId: existing.lease_id,
    });
  }
  await appendInteractiveSessionLog(env, id, user, message, now);
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
  if (["expired", "failed", "stopped"].includes(session.status)) {
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
  if (!user) return async () => false;
  if (canManageInteractiveSession(user, session)) return async () => true;
  return () => canControlInteractiveSessionById(env, user, session.id);
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
    .select(["share_token_hash", "share_mode", "status"])
    .where("id", "=", id)
    .where("share_mode", "=", "link_read")
    .executeTakeFirst();
  return Boolean(
    row?.share_token_hash &&
    !["expired", "failed", "stopped"].includes(row.status) &&
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

async function interactiveSessionPty(
  request: Request,
  env: RuntimeEnv,
  user: User,
  id: string,
): Promise<Response> {
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
    throw badRequest("websocket upgrade required");
  }

  const session = await readInteractiveSession(env, id);
  if (!session) throw notFound("interactive session not found");
  if (["expired", "failed", "stopped"].includes(session.status)) {
    throw badRequest(`session is ${session.status}`);
  }
  if (
    !canControlInteractiveSession(user, session, Date.now(), canGrantDelegatedControl(env, session))
  ) {
    throw forbidden("terminal control has not been granted");
  }
  const canManage = canManageInteractiveSession(user, session);

  if (session.leaseId?.startsWith(sandboxLeasePrefix) && env.SANDBOX) {
    return interactiveSandboxTerminal(
      request,
      env,
      user,
      session,
      canManage ? undefined : () => canControlInteractiveSessionById(env, user, id),
    );
  }

  const target = interactiveTerminalTarget(env, session);
  if (!target) throw serviceUnavailable("PTY bridge is not configured for this session");

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(target.url, {
      headers: interactiveTerminalHeaders(session, target.authorization),
    });
  } catch (error) {
    server.accept();
    server.close(1011, `PTY bridge failed: ${clean(String(error), 120)}`);
    return new Response(null, { status: 101, webSocket: client });
  }
  const upstream = upstreamResponse.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    server.accept();
    server.close(1011, `PTY bridge HTTP ${upstreamResponse.status}`);
    return new Response(null, { status: 101, webSocket: client });
  }

  server.accept();
  upstream.accept();
  bridgeWebSockets(
    server,
    upstream,
    canManage ? undefined : () => canControlInteractiveSessionById(env, user, id),
  );

  const now = Date.now();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status:
        session.status === "ready" || session.status === "detached" ? "attached" : session.status,
      last_seen_at: now,
      updated_at: now,
      last_event: "PTY terminal connected",
    })
    .where("id", "=", id)
    .where("status", "!=", "stopped")
    .execute();
  await appendInteractiveSessionEvent(env, id, user, "PTY terminal connected", now);

  return new Response(null, { status: 101, webSocket: client });
}

async function interactiveSandboxTerminal(
  request: Request,
  env: RuntimeEnv,
  user: User,
  session: InteractiveSession,
  canSendLeft?: () => Promise<boolean>,
): Promise<Response> {
  if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
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
      cols: terminalSize(request, "cols", 120),
      rows: terminalSize(request, "rows", 34),
    },
  );
  const upstream = upstreamResponse.webSocket;
  if (!upstream || upstreamResponse.status !== 101) {
    await markInteractiveTerminalUnavailable(
      env,
      user,
      sandboxSession.id,
      Date.now(),
      `terminal unavailable: Cloudflare Sandbox terminal HTTP ${upstreamResponse.status}`,
    );
    return upstreamResponse;
  }

  const pair = new WebSocketPair();
  const client = pair[0];
  const server = pair[1];
  server.accept();
  upstream.accept();
  await markInteractiveTerminalConnected(
    env,
    user,
    sandboxSession.id,
    Date.now(),
    "Cloudflare Sandbox terminal connected",
  );
  bridgeWebSockets(server, upstream, canSendLeft);
  return new Response(null, { status: 101, webSocket: client });
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
  if (!env.SANDBOX || !session.leaseId?.startsWith(sandboxLeasePrefix)) {
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
  if (!env.SANDBOX || !session.leaseId?.startsWith(sandboxLeasePrefix)) {
    throw badRequest("checkpoints require a Cloudflare Sandbox session");
  }
  if (["expired", "failed", "stopped"].includes(session.status)) {
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

function interactiveTerminalTarget(
  env: RuntimeEnv,
  session: InteractiveSession,
): InteractiveTerminalTarget | null {
  if (env.CRABBOX_PTY_BRIDGE_URL) {
    const url = interactiveBridgeUrl(env.CRABBOX_PTY_BRIDGE_URL, session);
    if (!url) return null;
    return {
      url,
      authorization: bearer(env.CRABBOX_PTY_BRIDGE_TOKEN),
    };
  }

  if (session.attachUrl && /^wss?:\/\//i.test(session.attachUrl)) {
    return { url: session.attachUrl, authorization: null };
  }

  if (session.leaseId?.startsWith("cloudflare:") && env.CRABBOX_CLOUDFLARE_RUNNER_URL) {
    const sandboxId = session.leaseId.slice("cloudflare:".length);
    const url = addQuery(
      joinUrl(
        env.CRABBOX_CLOUDFLARE_RUNNER_URL,
        `/v1/sandboxes/${encodeURIComponent(sandboxId)}/pty`,
      ),
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

function interactiveBridgeUrl(base: string, session: InteractiveSession): string {
  const replacements: Record<string, string> = {
    id: session.id,
    leaseId: session.leaseId ?? "",
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
  };
  let url = base;
  for (const [key, value] of Object.entries(replacements)) {
    url = url.replaceAll(`{${key}}`, encodeURIComponent(value));
  }
  return addQuery(httpToWebSocketUrl(url), terminalQuery(session));
}

function terminalQuery(session: InteractiveSession): Record<string, string> {
  return {
    sessionId: session.id,
    leaseId: session.leaseId ?? "",
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
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
): void {
  let leftInputQueue = Promise.resolve();
  let rightOutputQueue = Promise.resolve();
  let controlCheckTimer: ReturnType<typeof setInterval> | undefined;
  let controlCheckInFlight: Promise<void> | undefined;
  let leftCanSend = true;
  const stopControlCheck = () => {
    if (controlCheckTimer !== undefined) clearInterval(controlCheckTimer);
    controlCheckTimer = undefined;
  };
  const verifyControl = async () => {
    const canSend = canSendLeft ? await canSendLeft().catch(() => false) : true;
    leftCanSend = canSend;
    if (!canSend) {
      stopControlCheck();
      closePair(left, right, 1008, "terminal control revoked");
      return false;
    }
    return true;
  };
  const scheduleControlCheck = () => {
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
          closePair(left, right, 1008, "terminal control revoked");
          return;
        }
        right.send(await webSocketMessageData(data));
      });
  });
  right.addEventListener("message", (event) => {
    const data = event.data;
    rightOutputQueue = rightOutputQueue
      .catch(() => undefined)
      .then(async () => {
        if (left.readyState !== WebSocket.OPEN || right.readyState !== WebSocket.OPEN) return;
        left.send(await webSocketMessageData(data));
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
    to.close(event.code || 1000, event.reason || "peer closed");
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
): Promise<InteractiveProvisionResult | null> {
  if (session.runtime === "container" && env.SANDBOX) return provisionWithSandbox(env, session);
  if (!env.CRABBOX_INTERACTIVE_PROVISION_URL) return null;
  if (isBuiltInInteractiveProvisionUrl(env.CRABBOX_INTERACTIVE_PROVISION_URL)) {
    return provisionInteractivePayload(env, session);
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
  const status = optionalOneOf(body.status, interactiveSessionStatuses);
  if (!status) {
    return {
      status: "failed",
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
      message: "interactive provision failed: invalid adapter response",
    };
  }
  return {
    status,
    leaseId: clean(body.leaseId ?? body.lease_id, 240) || null,
    attachUrl: clean(body.attachUrl ?? body.attach_url, 1000) || null,
    vncUrl: clean(body.vncUrl ?? body.vnc_url, 1000) || null,
    message: clean(body.message, 500) || `interactive workspace ${status}`,
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
  const prompt = clean(session.prompt, 4000);
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
    command,
    prompt,
    owner,
    ...(githubToken ? { githubToken } : {}),
  };
  return provisionInteractivePayload(env, payload);
}

function isBuiltInInteractiveProvisionUrl(value: string): boolean {
  if (value === "/api/provision/interactive") return true;
  try {
    const url = new URL(value);
    return (
      url.pathname === "/api/provision/interactive" &&
      (url.hostname === appCanonicalHost || appRedirectHosts.has(url.hostname))
    );
  } catch {
    return false;
  }
}

async function provisionInteractivePayload(
  env: RuntimeEnv,
  payload: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  if (payload.runtime === "container" && env.SANDBOX) {
    return provisionWithSandbox(env, payload);
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
    vncUrl: null,
    message: "provision route live; runtime backend not configured",
  };
}

function authorizeProvisionEndpoint(request: Request, env: RuntimeEnv): void {
  const hasBackend = Boolean(
    env.SANDBOX ||
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
  const expected = `Bearer ${env.CRABBOX_INTERACTIVE_PROVISION_TOKEN}`;
  if (request.headers.get("authorization") !== expected) throw unauthorized();
}

async function provisionWithSandbox(
  env: RuntimeEnv,
  session: InteractiveProvisionRequest,
): Promise<InteractiveProvisionResult> {
  if (!env.SANDBOX) {
    return failedProvision("Cloudflare Sandbox binding is not configured");
  }
  if (!env.SESSION_CONTROL) {
    return failedProvision("SESSION_CONTROL Durable Object is not configured");
  }
  if (!env.OPENAI_API_KEY) {
    return failedProvision("OPENAI_API_KEY is not configured for Cloudflare Sandbox Codex");
  }

  const lease = newSandboxLease(session.id);
  const workdir = sandboxWorkdir(session.id);
  const sandbox = getSandbox(env.SANDBOX, lease.sandboxId);
  try {
    await registerSandboxCredentialPolicy(env, session, lease.sandboxId);
    await setupSandboxTerminalSession(sandbox, env, session, workdir, lease.terminalSessionId);
  } catch (error) {
    await unregisterSandboxCredentialPolicy(env, lease.sandboxId);
    const message = clean(error instanceof Error ? error.message : String(error), 240);
    return failedProvision(`Cloudflare Sandbox provision failed: ${message}`);
  }

  return {
    status: "ready",
    leaseId: sandboxLeaseId(lease),
    attachUrl: `/api/interactive-sessions/${encodeURIComponent(session.id)}/pty`,
    vncUrl: null,
    message: `Cloudflare Sandbox ready for ${session.repo}`,
  };
}

async function registerSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  sandboxId: string,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) throw new Error("SESSION_CONTROL Durable Object is not configured");
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
  for (const lookupId of sandboxLookupIds(env, sandboxId)) {
    const response = await stub.fetch("https://crabfleet.internal/api/session-control/register", {
      method: "POST",
      body: JSON.stringify({ ...policy, sandboxId: lookupId }),
      headers: { "content-type": "application/json" },
    });
    if (!response.ok) {
      throw new Error("sandbox credential policy registration failed");
    }
  }
}

async function ensureSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  sandboxId: string,
): Promise<void> {
  const hasFreshUserToken = Boolean("githubToken" in session && session.githubToken);
  if (!hasFreshUserToken && (await sandboxCredentialPolicyExists(env, sandboxId))) return;
  await registerSandboxCredentialPolicy(env, session, sandboxId);
}

async function sandboxCredentialPolicyExists(env: RuntimeEnv, sandboxId: string): Promise<boolean> {
  const stub = sandboxControlStub(env);
  if (!stub) return false;
  const responses = await Promise.all(
    sandboxLookupIds(env, sandboxId).map((lookupId) =>
      stub.fetch(
        `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(lookupId)}`,
      ),
    ),
  );
  return responses.some((response) => response.ok);
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
    ? (session.githubToken ?? (await sessionGitHubToken(request, env)))
    : undefined;
  if (user.subject.startsWith("github:") && !githubToken) {
    throw forbidden("GitHub PR credentials are not connected; sign in with GitHub again");
  }
  const fallbackLeaseId = sandboxLeaseWithoutRefresh(originalLeaseId);
  const oldSandboxId = originalLeaseId.startsWith(sandboxLeasePrefix)
    ? sandboxLeaseInfo({ id: session.id, leaseId: fallbackLeaseId }).sandboxId
    : null;
  const refreshLeaseId = `${fallbackLeaseId}:refreshing-${now}-${crypto.randomUUID().slice(0, 8)}`;
  const claim = await database(env)
    .updateTable("interactive_sessions")
    .set({
      lease_id: refreshLeaseId,
      last_event: "Cloudflare Sandbox lease refresh started",
      updated_at: now,
    })
    .where("id", "=", session.id)
    .where("lease_id", "=", originalLeaseId)
    .where("status", "in", ["ready", "attached", "detached"])
    .executeTakeFirst();
  if ((claim.numUpdatedRows ?? 0n) === 0n) {
    const current = await readInteractiveSession(env, session.id);
    if (current && isCurrentSandboxLease(current.leaseId)) return current;
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  const provisioned = await provisionWithSandbox(env, {
    id: session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    command: session.command,
    prompt: session.prompt,
    owner: session.owner,
    ...(githubToken ? { githubToken } : {}),
  });
  if (provisioned.status === "failed") {
    await database(env)
      .updateTable("interactive_sessions")
      .set({
        lease_id: fallbackLeaseId,
        last_event: provisioned.message,
        updated_at: Date.now(),
      })
      .where("id", "=", session.id)
      .where("lease_id", "=", refreshLeaseId)
      .execute();
    throw serviceUnavailable(provisioned.message);
  }
  const refreshedAt = Date.now();
  const update = await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: provisioned.status,
      lease_id: provisioned.leaseId,
      attach_url: provisioned.attachUrl,
      vnc_url: provisioned.vncUrl,
      last_event: "Cloudflare Sandbox lease refreshed",
      updated_at: refreshedAt,
    })
    .where("id", "=", session.id)
    .where("lease_id", "=", refreshLeaseId)
    .where("status", "in", ["ready", "attached", "detached"])
    .executeTakeFirst();
  if ((update.numUpdatedRows ?? 0n) === 0n) {
    if (provisioned.leaseId?.startsWith(sandboxLeasePrefix)) {
      await unregisterSandboxCredentialPolicy(
        env,
        sandboxLeaseInfo({ id: session.id, leaseId: provisioned.leaseId }).sandboxId,
      );
    }
    const current = await readInteractiveSession(env, session.id);
    if (current && isCurrentSandboxLease(current.leaseId)) return current;
    throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
  }
  const newSandboxId = provisioned.leaseId?.startsWith(sandboxLeasePrefix)
    ? sandboxLeaseInfo({ id: session.id, leaseId: provisioned.leaseId }).sandboxId
    : null;
  if (oldSandboxId && oldSandboxId !== newSandboxId) {
    await unregisterSandboxCredentialPolicy(env, oldSandboxId);
  }
  await appendInteractiveSessionLog(
    env,
    session.id,
    user,
    "Cloudflare Sandbox lease refreshed",
    refreshedAt,
  );
  return {
    ...session,
    status: provisioned.status,
    leaseId: provisioned.leaseId,
    attachUrl: provisioned.attachUrl,
    vncUrl: provisioned.vncUrl,
    lastEvent: "Cloudflare Sandbox lease refreshed",
    ...(githubToken ? { githubToken } : {}),
  };
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
  session: SandboxRuntimeSession,
  workdir: string,
  commandEnv: Record<string, string | undefined> = {},
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
git config --global user.email ${shellQuote(`${session.owner}@users.noreply.github.com`)}
mkdir -p "$(dirname ${shellQuote(autostartScript)})"
cat > ${shellQuote(autostartScript)} <<'EOF'
export CODEX_HOME="$HOME/.codex"
export GITHUB_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export GH_TOKEN=${shellQuote(sandboxPlaceholderGitHubToken)}
export CRABBOX_SESSION_ID=${shellQuote(session.id)}
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
): Promise<void> {
  const sessionEnv = sandboxSessionEnv(env, session);
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
    prepareSandboxRuntimeTools(setup, session, workdir),
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
): Record<string, string | undefined> {
  return {
    CRABBOX_SESSION_ID: session.id,
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
    return failedProvision(`interactive provision failed: ${clean(String(error), 240)}`);
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
    return failedProvision(`cloudflare runner provision failed: ${clean(String(error), 240)}`);
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
    return failedProvision(`clawfleet provision failed: ${clean(String(error), 240)}`);
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
  const status = optionalOneOf(body.status, interactiveSessionStatuses);
  if (!status) return failedProvision(invalidMessage);
  return {
    status,
    leaseId: clean(body.leaseId ?? body.lease_id, 240) || null,
    attachUrl: clean(body.attachUrl ?? body.attach_url, 1000) || null,
    vncUrl: clean(body.vncUrl ?? body.vnc_url, 1000) || null,
    message: clean(body.message, 500) || `interactive workspace ${status}`,
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
  const repo = normalizeRepo(body.repo) || preferredRepo;
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
    .sort((left, right) => sortRepoNames(left.repo, right.repo));
}

async function fetchPublicGitHubReferences(
  env: RuntimeEnv,
  repos: string[],
  number: number,
): Promise<GitHubReference[]> {
  const repo = repos.includes(preferredRepo) ? preferredRepo : repos[0];
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

async function readInteractiveSessions(
  env: RuntimeEnv,
  user?: User,
): Promise<InteractiveSession[]> {
  const rows = await database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
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
    .executeTakeFirst();
  if (!row) return null;
  const logs = await readInteractiveSessionLogs(env, [id]);
  const archives = await readInteractiveSessionLogArchives(env, [id]);
  return interactiveSession(row, logs.get(id) ?? [], archives.get(id) ?? null);
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
      leaseId: null,
      attachUrl: null,
      vncUrl: null,
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
  await database(env)
    .insertInto("interactive_session_events")
    .values({
      session_id: id,
      actor: actor(user),
      message: clean(message, 1000),
      created_at: now,
    })
    .execute();
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
  await database(env)
    .insertInto("interactive_session_events")
    .values({
      session_id: id,
      actor: "system",
      message: clean(message, 1000),
      created_at: now,
    })
    .execute();
  await archiveInteractiveSessionLogs(env, id, now).catch(() => undefined);
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
  const archiveVersion = `${String(events.length).padStart(8, "0")}-${String(latestEventAt).padStart(13, "0")}-${now}`;
  const base = `${sessionLogArchiveBase(id)}/${archiveVersion}`;
  const eventsKey = `${base}/events.ndjson`;
  const transcriptKey = `${base}/transcript.md`;
  const summaryKey = `${base}/summary.json`;
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
      events_key,
      transcript_key,
      summary_key,
      archived_at,
      updated_at
    )
    VALUES (
      ${id},
      ${events.length},
      ${env.SESSION_LOGS ? eventsKey : null},
      ${env.SESSION_LOGS ? transcriptKey : null},
      ${env.SESSION_LOGS ? summaryKey : null},
      ${now},
      ${now}
    )
    ON CONFLICT(session_id) DO UPDATE SET
      event_count = excluded.event_count,
      events_key = excluded.events_key,
      transcript_key = excluded.transcript_key,
      summary_key = excluded.summary_key,
      updated_at = excluded.updated_at
    WHERE excluded.event_count > interactive_session_log_archives.event_count
      OR (
        excluded.event_count = interactive_session_log_archives.event_count
        AND excluded.updated_at >= interactive_session_log_archives.updated_at
      )
  `.execute(db);
  if (!env.SESSION_LOGS) return;
  const latestArchive = await db
    .selectFrom("interactive_session_log_archives")
    .selectAll()
    .where("session_id", "=", id)
    .executeTakeFirst();
  const archiveWon = latestArchive?.events_key === eventsKey;
  await cleanupSessionLogArchiveObjects(
    env,
    archiveWon
      ? currentArchive
      : { events_key: eventsKey, transcript_key: transcriptKey, summary_key: summaryKey },
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

async function authorize(env: RuntimeEnv, user: User): Promise<User> {
  const entries = await database(env)
    .selectFrom("allow_entries")
    .select(["value", "role"])
    .execute();
  const candidates = new Set([
    user.login ? `@${user.login.toLowerCase()}` : "",
    user.email ? user.email.toLowerCase() : "",
    ...user.teams.map((team) => team.toLowerCase()),
  ]);
  let role: Role | null = null;
  for (const row of entries) {
    if (!candidates.has(row.value.toLowerCase())) continue;
    role = strongerRole(role, row.role);
  }
  return { ...user, role: role ?? "viewer", allowed: role !== null };
}

async function upsertUser(env: RuntimeEnv, user: User, now: number): Promise<void> {
  const row = {
    subject: user.subject,
    login: user.login,
    email: user.email,
    name: user.name,
    role: user.role,
    allowed: user.allowed ? 1 : 0,
    teams: JSON.stringify(user.teams),
    created_at: now,
    updated_at: now,
    last_seen_at: now,
  };
  await database(env)
    .insertInto("users")
    .values(row)
    .onConflict((oc) =>
      oc.column("subject").doUpdateSet({
        login: row.login,
        email: row.email,
        name: row.name,
        role: row.role,
        allowed: row.allowed,
        teams: row.teams,
        updated_at: row.updated_at,
        last_seen_at: row.last_seen_at,
      }),
    )
    .execute();
}

async function createSession(
  env: RuntimeEnv,
  request: Request,
  subject: string,
  now: number,
  maxAgeSeconds = bootstrapSessionSeconds,
  githubToken?: string,
): Promise<string> {
  const token = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await sha256(token);
  const expires = now + maxAgeSeconds * 1000;
  const githubTokenCiphertext = githubToken ? await sealSecret(env, githubToken) : null;
  const db = database(env);
  await db.deleteFrom("sessions").where("expires_at", "<", now).execute();
  await db
    .insertInto("sessions")
    .values({
      token_hash: tokenHash,
      subject,
      expires_at: expires,
      created_at: now,
      github_token_ciphertext: githubTokenCiphertext,
    })
    .execute();
  return cookie(request, sessionCookie, token, maxAgeSeconds);
}

async function sessionGitHubToken(request: Request, env: RuntimeEnv): Promise<string | undefined> {
  const token = cookies(request).get(sessionCookie);
  if (!token) return undefined;
  const row = await database(env)
    .selectFrom("sessions")
    .select("github_token_ciphertext")
    .where("token_hash", "=", await sha256(token))
    .where("expires_at", ">", Date.now())
    .executeTakeFirst();
  return row?.github_token_ciphertext
    ? ((await openSecret(env, row.github_token_ciphertext)) ?? undefined)
    : undefined;
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
    (await sessionGitHubToken(request, env)) ??
    (await sshGatewayKeyGitHubToken(request, env, user));
  return githubToken ? { ...session, githubToken } : session;
}

async function sealSecret(env: RuntimeEnv, value: string): Promise<string | null> {
  const key = await secretEncryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    encoder.encode(value),
  );
  return `v1.${base64UrlFromBytes(iv)}.${base64UrlFromBytes(new Uint8Array(ciphertext))}`;
}

async function openSecret(env: RuntimeEnv, sealed: string): Promise<string | null> {
  const [version, iv, ciphertext] = sealed.split(".");
  if (version !== "v1" || !iv || !ciphertext) return null;
  const key = await secretEncryptionKey(env);
  if (!key) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytesFromBase64Url(iv) },
      key,
      bytesFromBase64Url(ciphertext),
    );
    return decoder.decode(plaintext);
  } catch {
    return null;
  }
}

async function secretEncryptionKey(env: RuntimeEnv): Promise<CryptoKey | null> {
  const material = env.CRABBOX_TOKEN_ENCRYPTION_KEY || env.GITHUB_CLIENT_SECRET;
  if (!material) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`crabbox-secret-v1:${material}`),
  );
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
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
  const row = await database(env)
    .selectFrom("interactive_sessions")
    .select(sql<number | null>`max(CAST(substr(id, 4) AS INTEGER))`.as("max_id"))
    .where("id", "like", "IS-%")
    .executeTakeFirst();
  return `IS-${String((row?.max_id ?? 100) + 1)}`;
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

async function githubFetch<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      ...githubHeaders(),
      authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) throw new GitHubApiError(response.status);
  return response.json<T>();
}

function githubHeaders(env?: RuntimeEnv): HeadersInit {
  return {
    accept: "application/vnd.github+json",
    ...(env?.GITHUB_TOKEN ? { authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}),
    "user-agent": "crabbox-ai",
    "x-github-api-version": "2022-11-28",
  };
}

async function githubFetchPages<T>(path: string, token: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; page <= 10; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const batch = await githubFetch<T[]>(`${path}${separator}per_page=100&page=${page}`, token);
    rows.push(...batch);
    if (batch.length < 100) break;
  }
  return rows;
}

async function refreshGitHubUser(env: RuntimeEnv, token: string): Promise<User | null> {
  const org = env.GITHUB_ORG ?? "openclaw";
  const [githubUser, emails, membership, teamRows] = await Promise.all([
    githubFetch<GitHubProfile>("/user", token),
    githubFetch<Array<{ email: string; primary: boolean; verified: boolean }>>(
      "/user/emails",
      token,
    ).catch(() => []),
    githubFetch<{ state: string }>(`/user/memberships/orgs/${org}`, token).catch((error) => {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }),
    githubFetchPages<{ slug: string; organization?: { login?: string } }>("/user/teams", token),
  ]);
  if (membership?.state !== "active") return null;
  const email =
    githubUser.email ??
    emails.find((item) => item.primary && item.verified)?.email ??
    emails.find((item) => item.verified)?.email ??
    null;
  const teams = teamRows
    .filter((team) => (team.organization?.login ?? "").toLowerCase() === org.toLowerCase())
    .map((team) => `@${org}/${team.slug}`);
  return {
    subject: `github:${githubUser.id}`,
    login: githubUser.login,
    email,
    name: githubUser.name,
    role: "viewer",
    allowed: false,
    teams,
  };
}

class GitHubApiError extends Error {
  constructor(readonly status: number) {
    super(`GitHub API failed: ${status}`);
  }
}

function requireRole(user: User, needed: Role): void {
  const rank: Record<Role, number> = { viewer: 1, maintainer: 2, owner: 3 };
  if (rank[user.role] < rank[needed]) throw forbidden("insufficient role");
}

function strongerRole(left: Role | null, right: Role): Role {
  const rank: Record<Role, number> = { viewer: 1, maintainer: 2, owner: 3 };
  if (!left) return right;
  return rank[right] > rank[left] ? right : left;
}

function authMethods(env: RuntimeEnv, request?: Request): Record<string, boolean> {
  return {
    github: Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET),
    token: Boolean(env.CRABBOX_BOOTSTRAP_TOKEN),
    devIdentity: request ? isLocalDevRequest(request) : false,
  };
}

function actor(user: Pick<User, "subject" | "login" | "email">): string {
  return user.login ?? user.email ?? user.subject;
}

function isLocalDevRequest(request: Request): boolean {
  const hostname = new URL(request.url).hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    hostname === "[::1]"
  );
}

function devIdentityId(value: unknown): string {
  const id = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^dev:/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return id || "dev";
}

async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw badRequest("invalid json");
  }
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
  return {
    id: row.id,
    cardId: row.card_id,
    attempt: row.attempt,
    runtime: row.runtime,
    status: row.status,
    controlIntent: row.control_intent,
    leaseId: row.lease_id,
    attachUrl: row.attach_url,
    vncUrl: row.vnc_url,
    selectionReason: row.selection_reason,
    capabilities: runtimeCapabilities(row.runtime, row.capabilities_json),
    operator: row.operator,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function interactiveSession(
  row: InteractiveSessionTable,
  logs: string[],
  logArchive: InteractiveSessionLogArchive | null = null,
): InteractiveSession {
  return {
    id: row.id,
    repo: row.repo,
    branch: row.branch,
    runtime: row.runtime,
    command: row.command,
    prompt: row.prompt,
    owner: row.owner,
    status: row.status,
    leaseId: row.lease_id,
    attachUrl: row.attach_url,
    vncUrl: row.vnc_url,
    lastEvent: row.last_event,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
    stoppedAt: row.stopped_at,
    shareMode: row.share_mode,
    shareTokenPreview: row.share_token_preview,
    controlRequestedBy: row.control_requested_by,
    controlRequestedAt: row.control_requested_at,
    controller: row.controller,
    controlGrantedAt: row.control_granted_at,
    controlExpiresAt: row.control_expires_at,
    multiplayerMode: row.multiplayer_mode === 1,
    logs,
    logArchive,
  };
}

function interactiveSessionEvent(row: InteractiveSessionEventRow): InteractiveSessionEvent {
  return {
    actor: row.actor,
    message: row.message,
    createdAt: row.created_at,
  };
}

function interactiveSessionLogArchive(
  row: InteractiveSessionLogArchiveTable,
): InteractiveSessionLogArchive {
  return {
    sessionId: row.session_id,
    eventCount: row.event_count,
    eventsKey: row.events_key,
    transcriptKey: row.transcript_key,
    summaryKey: row.summary_key,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
  };
}

function sessionLogArchiveBase(id: string): string {
  return `orgs/openclaw/interactive-sessions/${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`;
}

function sessionLogTranscript(
  session: InteractiveSessionTable,
  events: InteractiveSessionEventRow[],
): string {
  const lines = [
    `# ${session.id}`,
    "",
    `repo: ${session.repo}`,
    `branch: ${session.branch}`,
    `runtime: ${session.runtime}`,
    `owner: ${session.owner}`,
    `status: ${session.status}`,
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
  session: InteractiveSessionTable,
  events: InteractiveSessionEventRow[],
): Record<string, unknown> {
  return {
    id: session.id,
    repo: session.repo,
    branch: session.branch,
    runtime: session.runtime,
    owner: session.owner,
    status: session.status,
    eventCount: events.length,
    firstEventAt: events[0]?.created_at ?? null,
    lastEventAt: events.at(-1)?.created_at ?? null,
    lastEvent: events.at(-1)?.message ?? session.last_event,
    updatedAt: session.updated_at,
  };
}

function decorateInteractiveSession(
  session: InteractiveSession,
  user?: User,
  env?: RuntimeEnv,
): InteractiveSession {
  if (!user) return session;
  const now = Date.now();
  const delegatedControl = env ? canGrantDelegatedControl(env, session) : true;
  const canManage = canManageInteractiveSession(user, session);
  const canChangeMultiplayer = canChangeInteractiveSessionMultiplayer(user, session);
  const canControl = canControlInteractiveSession(user, session, now, delegatedControl);
  const activeController = activeDelegatedController(session, now);
  return {
    ...session,
    leaseId: canControl ? session.leaseId : null,
    attachUrl: canControl ? session.attachUrl : null,
    vncUrl: canControl ? session.vncUrl : null,
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
  if (["expired", "failed", "stopped"].includes(session.status)) return false;
  return canControlInteractiveSession(
    user,
    session,
    Date.now(),
    canGrantDelegatedControl(env, session),
  );
}

function canGrantDelegatedControl(env: RuntimeEnv, session: InteractiveSession): boolean {
  if (!env.SANDBOX && session.leaseId?.startsWith(sandboxLeasePrefix)) return false;
  return true;
}

function shareToken(): string {
  const first = crypto.randomUUID().replaceAll("-", "");
  const second = crypto.randomUUID().replaceAll("-", "");
  return `${first}${second}`;
}

function shareUrl(request: Request, id: string, token: string): string {
  const url = new URL(request.url);
  return `${url.origin}/sessions/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
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

function runtimeCapabilities(runtime: string, value: string): RuntimeCapabilities {
  const fallback = runtime === "crabbox" ? crabboxCapabilities : containerCapabilities;
  const parsed = parseJson<Partial<RuntimeCapabilities>>(value, fallback);
  return {
    terminal: booleanCapability(parsed.terminal, fallback.terminal),
    takeover: booleanCapability(parsed.takeover, fallback.takeover),
    vnc: booleanCapability(parsed.vnc, fallback.vnc),
    desktop: booleanCapability(parsed.desktop, fallback.desktop),
    logs: booleanCapability(parsed.logs, fallback.logs),
    artifacts: booleanCapability(parsed.artifacts, fallback.artifacts),
  };
}

function booleanCapability(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
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

function cookies(request: Request): Map<string, string> {
  const result = new Map<string, string>();
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    result.set(part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim()));
  }
  return result;
}

function cookie(request: Request, name: string, value: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; HttpOnly${secure}; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function bootstrapSubject(env: RuntimeEnv): Promise<string> {
  if (!env.CRABBOX_BOOTSTRAP_TOKEN) throw unauthorized();
  return `bootstrap:${(await sha256(env.CRABBOX_BOOTSTRAP_TOKEN)).slice(0, 24)}`;
}

function normalizeRepo(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
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

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64UrlFromBytes(bytes: Uint8Array): string {
  return base64FromBytes(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function bytesFromBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
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

function bearer(token: string | undefined): string | null {
  return token ? `Bearer ${token}` : null;
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
  },
): { sandboxId: string; terminalSessionId: string } {
  const rawLease = "leaseId" in session ? session.leaseId : null;
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
  const suffix = reason ? `: ${clean(reason, 120)}` : "";
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

function sortRepos(repos: string[]): string[] {
  return [...repos].sort(sortRepoNames);
}

function sortRepoNames(left: string, right: string): number {
  if (left === preferredRepo) return -1;
  if (right === preferredRepo) return 1;
  return left.localeCompare(right);
}

function isConstraintError(error: unknown): boolean {
  return error instanceof Error && /constraint|unique/i.test(error.message);
}

function wantsMarkdown(request: Request): boolean {
  const accept = request.headers.get("accept") ?? "";
  return accept.includes("text/markdown");
}

function canonicalAppRedirect(url: URL): Response | null {
  if (!appRedirectHosts.has(url.hostname)) return null;
  const target = new URL(appCanonicalOrigin);
  target.pathname = url.pathname;
  target.search = url.search;
  return Response.redirect(target.toString(), 308);
}

function text(
  body: string,
  contentType: string,
  extraHeaders: HeadersInit = {},
  status = 200,
): Response {
  return new Response(body, {
    status,
    headers: {
      ...securityHeaders(contentType),
      ...extraHeaders,
      "content-length": String(encoder.encode(body).byteLength),
    },
  });
}

function json(body: unknown, init: ResponseInit & { headers?: HeadersInit } = {}): Response {
  const textBody = JSON.stringify(body);
  return new Response(textBody, {
    ...init,
    headers: {
      ...securityHeaders("application/json; charset=utf-8", false),
      ...init.headers,
      "content-length": String(encoder.encode(textBody).byteLength),
    },
  });
}

function redirect(location: string, headers: HeadersInit = {}): Response {
  return new Response(null, {
    status: 302,
    headers: {
      location,
      ...headers,
    },
  });
}

function securityHeaders(contentType: string, cache = true): HeadersInit {
  return {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "cache-control": cache ? "public, max-age=300" : "no-store",
  };
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

function unauthorized(): Error {
  return Object.assign(new Error("unauthorized"), { status: 401 });
}

function forbidden(message: string): Error {
  return Object.assign(new Error(message), { status: 403 });
}

function serviceUnavailable(message: string): Error {
  return Object.assign(new Error(message), { status: 503 });
}

function badRequest(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
}

function tooManyRequests(message: string): Error {
  return Object.assign(new Error(message), { status: 429 });
}

function notFound(message: string): Error {
  return Object.assign(new Error(message), { status: 404 });
}
