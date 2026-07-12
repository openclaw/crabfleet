import { sql } from "kysely";

import { trustedProxyConfigured } from "../trusted-proxy-auth.ts";
import { authorize, trustedProxyAutomaticRole } from "./auth.ts";
import { database, type InteractiveSessionGrantRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { User } from "./models.ts";
import type {
  InteractiveSessionAccessGrant,
  InteractiveSessionGrantRole,
} from "./session-access.ts";
import { bootstrapTenantSubject, stableTenantSubject } from "./tenancy.ts";

export type InteractiveSessionGrant = InteractiveSessionAccessGrant & {
  sessionId: string;
  principal: string;
  createdBySubject: string;
  createdAt: number;
  updatedAt: number;
};

export type ResolvedGrantPrincipal = {
  subject: string;
  principal: string;
  actor: string;
};

export class InteractiveSessionGrantRepository {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async readActive(
    sessionId: string,
    subject: string,
    now: number,
  ): Promise<InteractiveSessionGrant | null> {
    const row = await database(this.env)
      .selectFrom("interactive_session_grants")
      .selectAll()
      .where("session_id", "=", sessionId)
      .where("subject", "=", subject)
      .where(sql<boolean>`(expires_at IS NULL OR expires_at > ${now})`)
      .executeTakeFirst();
    return row ? grant(row) : null;
  }

  async readActiveForSessions(
    sessionIds: string[],
    subject: string,
    now: number,
  ): Promise<Map<string, InteractiveSessionGrant>> {
    const ids = [...new Set(sessionIds)].filter(Boolean);
    if (!ids.length) return new Map();
    const rows = await database(this.env)
      .selectFrom("interactive_session_grants")
      .selectAll()
      .where("session_id", "in", ids)
      .where("subject", "=", subject)
      .where(sql<boolean>`(expires_at IS NULL OR expires_at > ${now})`)
      .execute();
    return new Map(rows.map((row) => [row.session_id, grant(row)]));
  }

  async list(sessionId: string): Promise<InteractiveSessionGrant[]> {
    const rows = await database(this.env)
      .selectFrom("interactive_session_grants")
      .selectAll()
      .where("session_id", "=", sessionId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map(grant);
  }

  async resolvePrincipal(value: string): Promise<ResolvedGrantPrincipal | null> {
    const normalized = value.trim().toLowerCase();
    if (!normalized || normalized === "@" || normalized.length > 320) return null;
    const rows = await database(this.env)
      .selectFrom("users")
      .select(["subject", "login", "email", "name", "role", "allowed", "teams"])
      .where(
        sql<boolean>`(
          lower(subject) = ${normalized}
          OR (lower(subject) LIKE 'bootstrap:%' AND ${normalized} = ${bootstrapTenantSubject})
          OR (
            COALESCE(login, '') <> ''
            AND lower(login) = ${normalized.replace(/^@/, "")}
          )
          OR lower(COALESCE(email, '')) = ${normalized}
        )`,
      )
      .execute();
    const subjects = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (await currentPrincipalAllowed(this.env, row)) {
        subjects.set(stableTenantSubject(row.subject), row);
      }
    }
    if (subjects.size !== 1) return null;
    const [subject, row] = subjects.entries().next().value!;
    return {
      subject,
      principal: row.login ? `@${row.login}` : (row.email ?? row.subject),
      actor: row.login ?? row.email ?? subject,
    };
  }

  async upsert(input: {
    sessionId: string;
    subject: string;
    principal: string;
    role: InteractiveSessionGrantRole;
    createdBySubject: string;
    expiresAt: number;
    expectedSessionUpdatedAt: number;
    now: number;
  }): Promise<boolean> {
    const result = await this.env.DB.prepare(
      `INSERT INTO interactive_session_grants (
         session_id, subject, principal, role, created_by_subject,
         expires_at, created_at, updated_at
       )
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       FROM interactive_sessions
       WHERE id = ?
         AND updated_at = ?
         AND status NOT IN ('stopping', 'stopped', 'expired', 'failed')
       ON CONFLICT(session_id, subject) DO UPDATE SET
         principal = excluded.principal,
         role = excluded.role,
         created_by_subject = excluded.created_by_subject,
         expires_at = excluded.expires_at,
         updated_at = excluded.updated_at`,
    )
      .bind(
        input.sessionId,
        input.subject,
        input.principal,
        input.role,
        input.createdBySubject,
        input.expiresAt,
        input.now,
        input.now,
        input.sessionId,
        input.expectedSessionUpdatedAt,
      )
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async revoke(sessionId: string, subject: string, now = Date.now()): Promise<boolean> {
    const db = database(this.env);
    const grantExists = sql<boolean>`EXISTS (
      SELECT 1
      FROM interactive_session_grants
      WHERE session_id = ${sessionId}
        AND subject = ${subject}
    )`;
    const clearPendingControl = db
      .updateTable("interactive_sessions")
      .set({
        control_requested_by: null,
        control_requested_by_subject: null,
        control_requested_at: null,
      })
      .where("id", "=", sessionId)
      .where(grantExists)
      .where("control_requested_by_subject", "=", subject);
    const clearDelegatedControl = db
      .updateTable("interactive_sessions")
      .set({
        controller: null,
        controller_subject: null,
        control_granted_at: null,
        control_expires_at: null,
      })
      .where("id", "=", sessionId)
      .where(grantExists)
      .where("controller_subject", "=", subject);
    const advanceSessionRevision = db
      .updateTable("interactive_sessions")
      .set({ updated_at: sql<number>`MAX(updated_at + 1, ${now})` })
      .where("id", "=", sessionId)
      .where(grantExists);
    const deleteGrant = db
      .deleteFrom("interactive_session_grants")
      .where("session_id", "=", sessionId)
      .where("subject", "=", subject);
    const results = await this.env.DB.batch(
      [clearPendingControl, clearDelegatedControl, advanceSessionRevision, deleteGrant].map(
        (query) => {
          const compiled = query.compile();
          return this.env.DB.prepare(compiled.sql).bind(...compiled.parameters);
        },
      ),
    );
    return (results[3]?.meta.changes ?? 0) > 0;
  }
}

async function currentPrincipalAllowed(
  env: RuntimeEnv,
  row: {
    subject: string;
    login: string | null;
    email: string | null;
    name: string | null;
    role: User["role"];
    allowed: number;
    teams: string;
  },
): Promise<boolean> {
  if (row.subject.startsWith("bootstrap:")) return Boolean(env.CRABBOX_BOOTSTRAP_TOKEN);
  if (row.subject.startsWith("dev:") || row.subject.startsWith("service:")) return false;
  if (row.subject.startsWith("proxy:") && !trustedProxyConfigured(env)) return false;
  const automaticProxyRole = trustedProxyAutomaticRole(env.CRABFLEET_TRUSTED_PROXY_AUTO_ROLE);
  if (
    row.subject.startsWith("proxy:") &&
    env.CRABFLEET_TRUSTED_PROXY_AUTO_ROLE &&
    !automaticProxyRole
  ) {
    return false;
  }
  if (row.subject.startsWith("proxy:") && automaticProxyRole) {
    return true;
  }
  const user: User = {
    subject: row.subject,
    login: row.login,
    email: row.email,
    name: row.name,
    role: row.role,
    allowed: row.allowed === 1,
    teams: parseTeams(row.teams),
  };
  return (await authorize(env, user)).allowed;
}

function parseTeams(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function grant(row: InteractiveSessionGrantRow): InteractiveSessionGrant {
  return {
    sessionId: row.session_id,
    subject: row.subject,
    principal: row.principal,
    role: row.role,
    createdBySubject: row.created_by_subject,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
