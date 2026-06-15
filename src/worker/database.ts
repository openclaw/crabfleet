import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type DatabaseIntrospector,
  type Dialect,
  type Driver,
  type Generated,
  type Selectable,
} from "kysely";

import { D1Connection } from "../d1-execution.ts";
import type { RuntimeEnv } from "./env.ts";
import type {
  InteractiveRuntime,
  InteractiveSessionStatus,
  Role,
  RunStatus,
  WorkflowStatus,
} from "./models.ts";

export type SettingsTable = {
  key: string;
  value: string;
};

export type AllowEntryTable = {
  value: string;
  role: Role;
  created_at: number;
  updated_at: number;
};

export type RepoTable = {
  repo: string;
  enabled: number;
  created_at: number;
  updated_at: number;
};

export type UserTable = {
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

export type SessionTable = {
  token_hash: string;
  subject: string;
  expires_at: number;
  created_at: number;
  github_token_ciphertext: string | null;
};

export type CardTable = {
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

export type RunAttemptTable = {
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

export type InteractiveSessionTable = {
  id: string;
  parent_session_id: string | null;
  root_session_id: string | null;
  repo: string;
  branch: string;
  runtime: InteractiveRuntime;
  adapter: string | null;
  profile: string;
  adapter_workspace_id: string | null;
  adapter_control_plane: string | null;
  provider_resource_id: string | null;
  capabilities_json: string;
  expires_at: number | null;
  last_reconciled_at: number | null;
  reconcile_error: string | null;
  terminal_status: "failed" | null;
  terminal_failure_reason: Generated<string | null>;
  adapter_ttl_seconds: number | null;
  adapter_idle_timeout_seconds: number | null;
  adapter_requested_capabilities_json: string | null;
  adapter_create_payload_json: string | null;
  adapter_create_pending: number;
  preparation_pending: Generated<number>;
  openclaw_request_id: Generated<string | null>;
  openclaw_request_hash: Generated<string | null>;
  openclaw_admission_closed: Generated<number>;
  terminal_finalize_pending: Generated<number>;
  credential_cleanup_terminal_status: Generated<"stopped" | "expired" | "failed" | null>;
  sandbox_refresh_sandbox_id: Generated<string | null>;
  sandbox_refresh_claim: Generated<string | null>;
  sandbox_refresh_claim_expires_at: Generated<number | null>;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  created_by: string;
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
  agent_token_hash: string | null;
  work_key: string | null;
  work_kind: string | null;
  work_state: string;
  work_phase: string;
  source_url: string | null;
  github_run_url: string | null;
  codex_thread_id: string | null;
  codex_turn_id: string | null;
  last_heartbeat_at: number | null;
  completion_reason: string | null;
};

export type InteractiveSessionRow = Selectable<InteractiveSessionTable>;

export type OpenClawRequestReplayTable = {
  request_id: string;
  request_hash: string;
  session_id: string;
  created_at: number;
  updated_at: number;
};

export type RepoWorkflowTable = {
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

export type EventTable = {
  id: Generated<number>;
  card_id: string;
  actor: string;
  message: string;
  created_at: number;
};

export type InteractiveSessionEventTable = {
  id: Generated<number>;
  session_id: string;
  actor: string;
  message: string;
  created_at: number;
};

export type InteractiveSessionLogArchiveTable = {
  session_id: string;
  event_count: number;
  session_updated_at: number | null;
  events_key: string | null;
  transcript_key: string | null;
  summary_key: string | null;
  archived_at: number;
  updated_at: number;
};

export type InteractiveSessionCredentialPolicyTable = {
  session_id: string;
  sandbox_id: string;
  lookup_id: string;
  state: "registering" | "active" | "cleanup_pending";
  registration_generation: string;
  registration_claim: string | null;
  registration_claim_expires_at: number | null;
  attempt_count: Generated<number>;
  last_attempt_at: number | null;
  last_error: string | null;
  cleanup_claim: string | null;
  cleanup_claim_expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type CredentialPolicyReconcileStateTable = {
  id: number;
  last_rowid: number;
  scan_max_rowid: number;
  group_session_id: string;
  group_sandbox_id: string;
  group_max_session_id: string;
  group_max_sandbox_id: string;
  updated_at: number;
};

export type StandaloneSandboxProvisionTable = {
  id: string;
  request_hash: string;
  sandbox_id: string;
  state: "provisioning" | "active" | "cleanup_pending";
  ownership_claim: string | null;
  ownership_claim_expires_at: number | null;
  lease_id: string | null;
  attach_url: string | null;
  vnc_url: string | null;
  expires_at: Generated<number | null>;
  message: string;
  created_at: number;
  updated_at: number;
};

export type StandaloneSandboxProvisionRow = Selectable<StandaloneSandboxProvisionTable>;

export type AuditEventTable = {
  id: Generated<number>;
  actor: string;
  message: string;
  created_at: number;
};

export type SshKeyTable = {
  fingerprint: string;
  subject: string;
  public_key: string;
  label: string | null;
  github_token_ciphertext: string | null;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
};

export type SshLinkCodeTable = {
  code_hash: string;
  fingerprint: string;
  public_key: string;
  label: string | null;
  remote_ip: string | null;
  expires_at: number;
  consumed_at: number | null;
  created_at: number;
};

export type IdSequenceTable = {
  name: string;
  last_id: number;
};

export type Database = {
  settings: SettingsTable;
  allow_entries: AllowEntryTable;
  repos: RepoTable;
  users: UserTable;
  sessions: SessionTable;
  cards: CardTable;
  run_attempts: RunAttemptTable;
  interactive_sessions: InteractiveSessionTable;
  openclaw_request_replays: OpenClawRequestReplayTable;
  interactive_session_events: InteractiveSessionEventTable;
  interactive_session_log_archives: InteractiveSessionLogArchiveTable;
  interactive_session_credential_policies: InteractiveSessionCredentialPolicyTable;
  credential_policy_reconcile_state: CredentialPolicyReconcileStateTable;
  standalone_sandbox_provisions: StandaloneSandboxProvisionTable;
  repo_workflows: RepoWorkflowTable;
  events: EventTable;
  audit_events: AuditEventTable;
  ssh_keys: SshKeyTable;
  ssh_link_codes: SshLinkCodeTable;
  id_sequences: IdSequenceTable;
};

export type CompilableQuery = {
  compile(executorProvider: Kysely<Database>): CompiledQuery;
};

class D1Dialect implements Dialect {
  private readonly d1: D1Database;

  constructor(d1: D1Database) {
    this.d1 = d1;
  }

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

export function database(env: Pick<RuntimeEnv, "DB">): Kysely<Database> {
  return new Kysely<Database>({ dialect: new D1Dialect(env.DB) });
}

export async function executeBatch(
  env: Pick<RuntimeEnv, "DB">,
  queries: readonly CompilableQuery[],
): Promise<void> {
  const db = database(env);
  await env.DB.batch(
    queries.map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
}
