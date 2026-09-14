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
} from "kysely";

import { D1Connection } from "../d1-execution.ts";
import type { RuntimeEnv } from "./env.ts";
import type { Role } from "./models.ts";

export type AllowEntryTable = {
  value: string;
  role: Role;
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

export type DesktopHostTable = {
  relay_only: Generated<number>;
  owner_subject: string;
  id: string;
  owner: string;
  name: string;
  address: string;
  port: number;
  quic_port: number | null;
  quic_cert_hash: string | null;
  webtransport: Generated<number>;
  ownership_token: string;
  publication_id: string;
  publication_write_token: Generated<string>;
  created_at: number;
  updated_at: number;
};

export type NativeDeviceAuthorizationTable = {
  scope: Generated<string>;
  device_code_hash: string;
  link_code_hash: string;
  client_name: string;
  remote_ip: string | null;
  subject: string | null;
  access_token_hash: string | null;
  access_token_ciphertext: string | null;
  access_token_expires_at: number | null;
  expires_at: number;
  next_poll_at: number;
  approved_at: number | null;
  consumed_at: number | null;
  created_at: number;
};

export type NativeAccessTokenTable = {
  token_hash: string;
  subject: string;
  scope: string;
  client_name: string;
  github_token_ciphertext: string | null;
  expires_at: number;
  created_at: number;
  last_used_at: number;
  revoked_at: number | null;
};

export type AuditEventTable = {
  id: Generated<number>;
  actor: string;
  message: string;
  created_at: number;
};

export type Database = {
  allow_entries: AllowEntryTable;
  users: UserTable;
  sessions: SessionTable;
  desktop_hosts: DesktopHostTable;
  native_device_authorizations: NativeDeviceAuthorizationTable;
  native_access_tokens: NativeAccessTokenTable;
  audit_events: AuditEventTable;
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
