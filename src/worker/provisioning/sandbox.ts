import { githubActionsRuntime } from "../../github-actions-runtime.ts";
import type { InteractiveSessionRow } from "../database.ts";
import { badRequest, forbidden, serviceUnavailable } from "../http.ts";
import type { User } from "../models.ts";
import {
  isCurrentSandboxLease,
  isSandboxInteractiveSession,
  sandboxLeaseInfo,
  sandboxLeaseId,
  sandboxLeaseRefreshStartedAt,
  type SandboxLease,
  type SandboxLeaseRefreshFence,
} from "../sandbox-lease.ts";
import type { InteractiveSession } from "../session-model.ts";
import { ownsInteractiveSession } from "../session-access.ts";
import type { TenancyMode } from "../tenancy.ts";
import { cleanupPendingProvision, failedProvision } from "./result.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export type ManagedSandboxProvisionClaim = {
  agentToken: string;
  agentTokenHash: string;
  lease: SandboxLease;
  fence: SandboxLeaseRefreshFence;
  previousSandboxId: string | null;
  claimRevision: number;
};

export const sandboxLeaseOwnerReconnectMessage =
  "session owner must reconnect to refresh Cloudflare Sandbox lease";

export function isSandboxLeaseOwnerReconnectError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message === sandboxLeaseOwnerReconnectMessage &&
    "status" in error &&
    error.status === 503
  );
}

export type ManagedSandboxProvisionCommit = {
  committed: boolean;
  cleanupPending: boolean;
  commitRevision: number;
};

export type ManagedSandboxProvisioningDependencies = {
  now(): number;
  preflight(session: InteractiveProvisionRequest): string | null;
  claim(
    session: InteractiveProvisionRequest,
    owner: InteractiveSessionRow,
    now: number,
  ): Promise<ManagedSandboxProvisionClaim | null>;
  provision(
    session: InteractiveProvisionRequest,
    claim: ManagedSandboxProvisionClaim,
  ): Promise<InteractiveProvisionResult>;
  stageFailure(
    sessionId: string,
    fence: SandboxLeaseRefreshFence,
    message: string,
    now: number,
  ): Promise<boolean>;
  commit(
    sessionId: string,
    claim: ManagedSandboxProvisionClaim,
    result: InteractiveProvisionResult,
    now: number,
  ): Promise<ManagedSandboxProvisionCommit>;
  reconcileCleanup(sessionId: string, now: number): Promise<void>;
  providerError(error: unknown): string;
};

export class ManagedSandboxProvisioningService {
  private readonly dependencies: ManagedSandboxProvisioningDependencies;

  constructor(dependencies: ManagedSandboxProvisioningDependencies) {
    this.dependencies = dependencies;
  }

  async provision(
    session: InteractiveProvisionRequest,
    owner: InteractiveSessionRow,
  ): Promise<InteractiveProvisionResult> {
    if (
      !managedSandboxProvisionPayloadMatches(session, owner) ||
      !managedSandboxOwnerReady(owner)
    ) {
      return failedProvision(
        "interactive provision failed: managed session request does not match durable ownership",
      );
    }
    const preflightError = this.dependencies.preflight(session);
    if (preflightError) return failedProvision(preflightError);

    const claim = await this.dependencies.claim(session, owner, this.dependencies.now());
    if (!claim) {
      return failedProvision(
        "interactive provision failed: managed session claim was not acquired",
      );
    }

    let provisioned: InteractiveProvisionResult;
    try {
      provisioned = await this.dependencies.provision(session, claim);
    } catch (error) {
      const message = `Cloudflare Sandbox provision failed: ${this.dependencies.providerError(error)}`;
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        message,
        this.dependencies.now(),
      );
      return cleanupPendingProvision(sandboxLeaseId(claim.lease), message);
    }
    if (provisioned.status !== "ready") {
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        provisioned.message,
        this.dependencies.now(),
      );
      return provisioned;
    }

    const expectedLeaseId = sandboxLeaseId(claim.lease);
    if (provisioned.leaseId !== expectedLeaseId) {
      const message = "interactive provision failed: managed Sandbox lease mismatch";
      const staged = await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        message,
        this.dependencies.now(),
      );
      return failedProvision(
        staged ? message : "interactive provision failed: managed session ownership changed",
      );
    }

    const committed = await this.dependencies.commit(
      session.id,
      claim,
      provisioned,
      this.dependencies.now(),
    );
    if (!committed.committed) {
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        "interactive provision failed: managed session ownership changed",
        this.dependencies.now(),
      );
      return failedProvision("interactive provision failed: managed session ownership changed");
    }
    if (committed.cleanupPending) {
      await this.dependencies.reconcileCleanup(session.id, committed.commitRevision);
    }
    return provisioned;
  }
}

export type ManagedSandboxLeaseRefreshDependencies = {
  sandboxAvailable: boolean;
  tenancyMode: TenancyMode;
  now(): number;
  ensurePolicy(session: InteractiveSession, sandboxId: string): Promise<void>;
  readGitHubToken(
    request: Request,
    user: User,
    session: InteractiveSession & { githubToken?: string },
  ): Promise<string | undefined>;
  preflight(session: InteractiveProvisionRequest): string | null;
  claim(session: InteractiveSession, now: number): Promise<ManagedSandboxProvisionClaim | null>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  provision(
    session: InteractiveProvisionRequest,
    claim: ManagedSandboxProvisionClaim,
  ): Promise<InteractiveProvisionResult>;
  stageFailure(
    sessionId: string,
    fence: SandboxLeaseRefreshFence,
    message: string,
    now: number,
  ): Promise<boolean>;
  commit(
    sessionId: string,
    claim: ManagedSandboxProvisionClaim,
    result: InteractiveProvisionResult,
    now: number,
  ): Promise<ManagedSandboxProvisionCommit>;
  reconcileCleanup(sessionId: string, now: number): Promise<void>;
  appendLog(sessionId: string, user: User, message: string, now: number): Promise<void>;
  providerError(error: unknown): string;
};

export class ManagedSandboxLeaseRefreshService {
  private readonly dependencies: ManagedSandboxLeaseRefreshDependencies;

  constructor(dependencies: ManagedSandboxLeaseRefreshDependencies) {
    this.dependencies = dependencies;
  }

  async ensureCurrent(
    request: Request,
    user: User | null,
    session: InteractiveSession & { githubToken?: string },
  ): Promise<InteractiveSession & { githubToken?: string }> {
    if (!this.dependencies.sandboxAvailable) return session;
    if (!isSandboxInteractiveSession(session)) {
      throw serviceUnavailable("session is not backed by a Cloudflare Sandbox lease");
    }
    if (session.runtime === githubActionsRuntime) {
      throw badRequest("GitHub Actions sessions do not use Cloudflare Sandbox leases");
    }
    if (isCurrentSandboxLease(session.leaseId)) {
      await this.dependencies.ensurePolicy(session, sandboxLeaseInfo(session).sandboxId);
      return session;
    }

    const originalLeaseId = session.leaseId;
    if (!originalLeaseId) {
      throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
    }
    const refreshStartedAt = sandboxLeaseRefreshStartedAt(originalLeaseId);
    const now = this.dependencies.now();
    if (refreshStartedAt && now - refreshStartedAt < 2 * 60_000) {
      throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
    }
    if (!user || !ownsInteractiveSession(user, session, this.dependencies.tenancyMode)) {
      throw serviceUnavailable(sandboxLeaseOwnerReconnectMessage);
    }

    const githubToken = user.subject.startsWith("github:")
      ? (session.githubToken ?? (await this.dependencies.readGitHubToken(request, user, session)))
      : undefined;
    if (user.subject.startsWith("github:") && !githubToken) {
      throw forbidden("GitHub PR credentials are not connected; sign in with GitHub again");
    }
    const refreshPayload = sandboxLeaseRefreshPayload(session, githubToken);
    const preflightError = this.dependencies.preflight(refreshPayload);
    if (preflightError) throw serviceUnavailable(preflightError);

    const claim = await this.dependencies.claim(session, now);
    if (!claim) {
      const current = await this.dependencies.readSession(session.id);
      if (
        current &&
        isSandboxInteractiveSession(current) &&
        isCurrentSandboxLease(current.leaseId)
      ) {
        return current;
      }
      throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
    }

    let provisioned: InteractiveProvisionResult;
    try {
      provisioned = await this.dependencies.provision(refreshPayload, claim);
    } catch (error) {
      const message = `Cloudflare Sandbox lease refresh failed: ${this.dependencies.providerError(error)}`;
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        message,
        this.dependencies.now(),
      );
      throw serviceUnavailable(message);
    }
    if (provisioned.status !== "ready") {
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        provisioned.message,
        this.dependencies.now(),
      );
      throw serviceUnavailable(provisioned.message);
    }

    const refreshedAt = this.dependencies.now();
    const expectedLeaseId = sandboxLeaseId(claim.lease);
    if (provisioned.leaseId !== expectedLeaseId) {
      const message = "Cloudflare Sandbox lease refresh returned an unexpected lease";
      await this.dependencies.stageFailure(session.id, claim.fence, message, refreshedAt);
      throw serviceUnavailable(message);
    }

    const committed = await this.dependencies.commit(session.id, claim, provisioned, refreshedAt);
    if (!committed.committed) {
      await this.dependencies.stageFailure(
        session.id,
        claim.fence,
        "Cloudflare Sandbox lease refresh ownership changed",
        refreshedAt,
      );
      throw serviceUnavailable("Cloudflare Sandbox lease refresh is already in progress");
    }
    if (committed.cleanupPending) {
      await this.dependencies.reconcileCleanup(session.id, committed.commitRevision);
    }

    const current = await this.dependencies.readSession(session.id);
    if (!current || !managedSandboxLeaseRefreshResultMatches(current, provisioned)) {
      throw serviceUnavailable(
        "previous Cloudflare Sandbox credential cleanup stopped the session",
      );
    }
    await this.dependencies.appendLog(
      session.id,
      user,
      "Cloudflare Sandbox lease refreshed",
      refreshedAt,
    );
    const latest = await this.dependencies.readSession(session.id);
    if (!latest || !managedSandboxLeaseRefreshResultMatches(latest, provisioned)) {
      throw serviceUnavailable(
        "previous Cloudflare Sandbox credential cleanup stopped the session",
      );
    }
    return { ...latest, ...(githubToken ? { githubToken } : {}) };
  }
}

export function managedSandboxProvisionPayloadMatches(
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

export function sandboxLeaseRefreshPayload(
  session: InteractiveSession,
  githubToken?: string,
): InteractiveProvisionRequest {
  const runtime = session.runtime;
  if (runtime === githubActionsRuntime) {
    throw badRequest("GitHub Actions sessions do not use Cloudflare Sandbox leases");
  }
  return {
    id: session.id,
    parentSessionId: session.parentSessionId,
    rootSessionId: session.rootSessionId ?? session.id,
    repo: session.repo,
    branch: session.branch,
    runtime,
    profile: session.profile,
    command: session.command,
    prompt: session.prompt,
    purpose: session.purpose,
    summary: session.summary,
    owner: session.owner,
    createdBy: session.createdBy,
    ...(githubToken ? { githubToken } : {}),
  };
}

function managedSandboxOwnerReady(session: InteractiveSessionRow): boolean {
  return (
    ["provisioning", "pending_adapter"].includes(session.status) &&
    session.preparation_pending === 0 &&
    // Built-in Sandbox ownership is adapterless; non-null adapters belong to an external protocol.
    session.adapter === null &&
    session.credential_cleanup_terminal_status === null
  );
}

function managedSandboxLeaseRefreshResultMatches(
  session: InteractiveSession,
  result: InteractiveProvisionResult,
): boolean {
  return (
    session.leaseId === result.leaseId && ["ready", "attached", "detached"].includes(session.status)
  );
}
