import { actor } from "./auth.ts";
import { badRequest, forbidden, notFound } from "./http.ts";
import type { User } from "./models.ts";
import type { InteractiveSessionGrantRole } from "./session-access.ts";
import type {
  InteractiveSessionGrant,
  ResolvedGrantPrincipal,
} from "./session-grant-repository.ts";
import type { InteractiveSession } from "./session-model.ts";
import { tenantSubject } from "./tenancy.ts";

const defaultGrantSeconds = 24 * 60 * 60;
const minimumGrantSeconds = 5 * 60;
const maximumGrantSeconds = 30 * 24 * 60 * 60;

export type InteractiveSessionGrantInput = {
  principal?: unknown;
  role?: unknown;
  expiresInSeconds?: unknown;
};

export type InteractiveSessionGrantServiceStore = {
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  canManage(user: User, session: InteractiveSession): Promise<boolean>;
  resolvePrincipal(value: string): Promise<ResolvedGrantPrincipal | null>;
  list(sessionId: string): Promise<InteractiveSessionGrant[]>;
  upsert(input: {
    sessionId: string;
    subject: string;
    principal: string;
    role: InteractiveSessionGrantRole;
    createdBySubject: string;
    expiresAt: number;
    expectedSessionUpdatedAt: number;
    now: number;
  }): Promise<boolean>;
  revoke(sessionId: string, subject: string, now: number): Promise<boolean>;
  appendEvent(sessionId: string, actorName: string, message: string, now: number): Promise<void>;
  audit(user: User, message: string, now: number): Promise<void>;
  warn(event: Record<string, unknown>): void;
  now(): number;
};

export class InteractiveSessionGrantService {
  private readonly store: InteractiveSessionGrantServiceStore;

  constructor(store: InteractiveSessionGrantServiceStore) {
    this.store = store;
  }

  async list(user: User, sessionId: string): Promise<{ grants: InteractiveSessionGrant[] }> {
    await this.requireOwner(user, sessionId);
    return { grants: await this.store.list(sessionId) };
  }

  async grant(
    user: User,
    sessionId: string,
    input: InteractiveSessionGrantInput,
  ): Promise<{ grants: InteractiveSessionGrant[] }> {
    const session = await this.requireOwner(user, sessionId);
    if (session.status === "stopping") throw forbidden("session is stopping");
    const principalInput = clean(input.principal, 320);
    if (!principalInput) throw badRequest("principal is required");
    const target = await this.store.resolvePrincipal(principalInput);
    if (!target) throw badRequest("principal must identify one active Crabfleet user");
    if (target.subject === tenantSubject(user))
      throw badRequest("session owners already have access");
    const role = grantRole(input.role);
    const now = this.store.now();
    const expiresAt = now + grantDurationSeconds(input.expiresInSeconds) * 1000;
    if (
      !(await this.store.upsert({
        sessionId,
        subject: target.subject,
        principal: target.principal,
        role,
        createdBySubject: tenantSubject(user),
        expiresAt,
        expectedSessionUpdatedAt: session.updatedAt,
        now,
      }))
    ) {
      throw forbidden("session changed or no longer accepts grants");
    }
    await this.recordCommittedEvidence("grant", [
      () => this.store.appendEvent(sessionId, actor(user), `named ${role} access granted`, now),
      () =>
        this.store.audit(
          user,
          `interactive session access granted ${sessionId} to ${target.subject} role=${role}`,
          now,
        ),
    ]);
    return {
      grants: await this.listAfterCommit(
        sessionId,
        [
          {
            sessionId,
            subject: target.subject,
            principal: target.principal,
            role,
            createdBySubject: tenantSubject(user),
            expiresAt,
            createdAt: now,
            updatedAt: now,
          },
        ],
        "grant",
      ),
    };
  }

  async revoke(
    user: User,
    sessionId: string,
    subject: string,
  ): Promise<{ grants: InteractiveSessionGrant[] }> {
    await this.requireOwner(user, sessionId);
    const normalized = exactGrantSubject(subject);
    if (!normalized) throw badRequest("grant subject is required");
    const now = this.store.now();
    if (!(await this.store.revoke(sessionId, normalized, now)))
      throw notFound("session grant not found");
    await this.recordCommittedEvidence("revoke", [
      () => this.store.appendEvent(sessionId, actor(user), "named access revoked", now),
      () =>
        this.store.audit(
          user,
          `interactive session access revoked ${sessionId} from ${normalized}`,
          now,
        ),
    ]);
    return { grants: await this.listAfterCommit(sessionId, [], "revoke") };
  }

  private async recordCommittedEvidence(
    operation: "grant" | "revoke",
    actions: Array<() => Promise<void>>,
  ): Promise<void> {
    const results = await Promise.allSettled(
      actions.map((action) => Promise.resolve().then(action)),
    );
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        this.warn({
          event: "interactive_session_grant_bookkeeping_failed",
          operation,
          stage: index === 0 ? "event" : "audit",
        });
      }
    }
  }

  private async listAfterCommit(
    sessionId: string,
    fallback: InteractiveSessionGrant[],
    operation: "grant" | "revoke",
  ): Promise<InteractiveSessionGrant[]> {
    try {
      return await this.store.list(sessionId);
    } catch {
      this.warn({
        event: "interactive_session_grant_bookkeeping_failed",
        operation,
        stage: "list",
      });
      return fallback;
    }
  }

  private warn(event: Record<string, unknown>): void {
    try {
      this.store.warn(event);
    } catch {
      // A diagnostic sink must not turn a committed access change into a reported failure.
    }
  }

  private async requireOwner(user: User, sessionId: string): Promise<InteractiveSession> {
    const session = await this.store.readSession(sessionId);
    if (!session || !(await this.store.canManage(user, session))) {
      throw notFound("interactive session not found");
    }
    return session;
  }
}

function grantRole(value: unknown): InteractiveSessionGrantRole {
  if (value === "viewer" || value === "controller") return value;
  throw badRequest("grant role must be viewer or controller");
}

function grantDurationSeconds(value: unknown): number {
  const seconds = value === undefined ? defaultGrantSeconds : Number(value);
  if (
    !Number.isInteger(seconds) ||
    seconds < minimumGrantSeconds ||
    seconds > maximumGrantSeconds
  ) {
    throw badRequest("grant duration must be between 5 minutes and 30 days");
  }
  return seconds;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function exactGrantSubject(value: unknown): string {
  const subject = String(value ?? "").trim();
  if (!subject || subject.length > 512) throw badRequest("grant subject is required");
  return subject;
}
