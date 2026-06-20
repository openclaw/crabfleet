import { getSandbox } from "@cloudflare/sandbox";

import { actor, sessionGitHubToken } from "../auth.ts";
import type { InteractiveSessionRow } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import type { User } from "../models.ts";
import {
  queueSandboxCredentialPolicyCleanup,
  type SandboxCredentialPolicyOwnershipFence,
} from "../sandbox-credential-policy-repository.ts";
import { stageTerminalCredentialPolicyCleanupById } from "../sandbox-credential-policy-cleanup.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "../sandbox-credential-policy-cleanup-service.ts";
import {
  ensureSandboxCredentialPolicy,
  registerSandboxCredentialPolicy,
} from "../sandbox-credential-policy-registration-service.ts";
import { credentialPolicyProvisioningStaleMs } from "../sandbox-credential-policy-scanner.ts";
import {
  sandboxLeaseId,
  type SandboxLease,
  type SandboxLeaseRefreshFence,
} from "../sandbox-lease.ts";
import {
  setupSandboxTerminalSession,
  sandboxWorkdir,
  type SandboxRuntimeSession,
} from "../sandbox-runtime.ts";
import { appendInteractiveSessionEventRecord } from "../session-events.ts";
import type { InteractiveSession } from "../session-model.ts";
import { readInteractiveSessionRecord } from "../session-repository.ts";
import { tenancyMode } from "../tenancy.ts";
import { cleanupPendingProvision, safeProviderError } from "./result.ts";
import { ManagedSandboxLeaseRefreshService, ManagedSandboxProvisioningService } from "./sandbox.ts";
import {
  claimManagedSandboxLeaseRefresh,
  claimManagedSandboxProvision,
  commitManagedSandboxLeaseRefresh,
  commitManagedSandboxProvision,
} from "./sandbox-repository.ts";
import { standaloneSandboxAttachUrl } from "./standalone-sandbox.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export class SandboxLifecycleService {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  managedProvisioning(): ManagedSandboxProvisioningService {
    return new ManagedSandboxProvisioningService({
      now: Date.now,
      preflight: (session) => this.preflightError(session),
      claim: (session, owner, now) =>
        claimManagedSandboxProvision(
          this.env,
          session,
          owner,
          now,
          credentialPolicyProvisioningStaleMs,
        ),
      provision: (session, claim) =>
        this.provisionClaim(session, claim.agentToken, claim.lease, claim.fence),
      stageFailure: (sessionId, fence, message, now) =>
        this.stageManagedFailure(sessionId, fence, message, now),
      commit: (sessionId, claim, result, now) =>
        commitManagedSandboxProvision(this.env, sessionId, claim, result, now),
      reconcileCleanup: (sessionId, now) =>
        reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, sessionId),
      providerError: safeProviderError,
    });
  }

  async provisionManaged(
    session: InteractiveProvisionRequest,
    owner: InteractiveSessionRow,
  ): Promise<InteractiveProvisionResult> {
    return this.managedProvisioning().provision(session, owner);
  }

  async provisionReservation(
    session: InteractiveProvisionRequest,
    agentToken: string | undefined,
    lease: SandboxLease,
    ownershipFence: SandboxCredentialPolicyOwnershipFence,
  ): Promise<InteractiveProvisionResult> {
    try {
      return await this.provisionClaim(session, agentToken, lease, ownershipFence);
    } catch (error) {
      const message = safeProviderError(error);
      const cleanupMessage = `Cloudflare Sandbox provision failed: ${message}`;
      const failureAt = Date.now();
      if ("provisionId" in ownershipFence) {
        await queueSandboxCredentialPolicyCleanup(this.env, session.id, lease.sandboxId, failureAt);
      } else {
        await stageTerminalCredentialPolicyCleanupById(
          this.env,
          session.id,
          "failed",
          cleanupMessage,
          failureAt,
          cleanupMessage,
          ownershipFence,
        );
      }
      await reconcileSandboxCredentialPolicyCleanupBatch(this.env, Date.now(), session.id);
      return cleanupPendingProvision(sandboxLeaseId(lease), cleanupMessage);
    }
  }

  async provisionClaim(
    session: InteractiveProvisionRequest,
    agentToken: string | undefined,
    lease: SandboxLease,
    ownershipFence: SandboxCredentialPolicyOwnershipFence,
  ): Promise<InteractiveProvisionResult> {
    const preflightError = this.preflightError(session);
    if (preflightError) throw new Error(preflightError);
    if (!("provisionId" in ownershipFence) && !agentToken) {
      throw new Error("managed Sandbox agent token is unavailable");
    }

    const sandbox = getSandbox(this.env.SANDBOX!, lease.sandboxId);
    await registerSandboxCredentialPolicy(this.env, session, lease.sandboxId, ownershipFence);
    await setupSandboxTerminalSession(
      sandbox,
      this.env,
      session,
      sandboxWorkdir(session.id),
      lease.terminalSessionId,
      agentToken,
    );
    return {
      status: "ready",
      leaseId: sandboxLeaseId(lease),
      attachUrl:
        "provisionId" in ownershipFence
          ? standaloneSandboxAttachUrl(this.env, session.id)
          : "/api/terminal/ws",
      vncUrl: null,
      message: `Cloudflare Sandbox ready for ${session.repo}`,
    };
  }

  async ensureCurrentLease(
    request: Request,
    user: User | null,
    session: InteractiveSession & { githubToken?: string },
  ): Promise<InteractiveSession & { githubToken?: string }> {
    return this.leaseRefresh().ensureCurrent(request, user, session);
  }

  private leaseRefresh(): ManagedSandboxLeaseRefreshService {
    return new ManagedSandboxLeaseRefreshService({
      sandboxAvailable: Boolean(this.env.SANDBOX),
      tenancyMode: tenancyMode(this.env),
      now: Date.now,
      ensurePolicy: (session, sandboxId) =>
        ensureSandboxCredentialPolicy(this.env, session, sandboxId),
      readGitHubToken: (request, user) => sessionGitHubToken(request, this.env, user.subject),
      preflight: (session) => this.preflightError(session),
      claim: (session, now) =>
        claimManagedSandboxLeaseRefresh(
          this.env,
          session,
          now,
          credentialPolicyProvisioningStaleMs,
        ),
      readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
      provision: (session, claim) =>
        this.provisionClaim(session, claim.agentToken, claim.lease, claim.fence),
      stageFailure: (sessionId, fence, message, now) =>
        this.stageManagedFailure(sessionId, fence, message, now),
      commit: (sessionId, claim, result, now) =>
        commitManagedSandboxLeaseRefresh(this.env, sessionId, claim, result, now),
      reconcileCleanup: (sessionId, now) =>
        reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, sessionId),
      appendLog: (sessionId, user, message, now) =>
        appendInteractiveSessionEventRecord(this.env, {
          sessionId,
          actor: actor(user),
          message,
          now,
        }),
      providerError: safeProviderError,
    });
  }

  private preflightError(session: SandboxRuntimeSession): string | null {
    if (!this.env.SANDBOX) return "Cloudflare Sandbox binding is not configured";
    if (!this.env.SESSION_CONTROL) return "SESSION_CONTROL Durable Object is not configured";
    if (!this.env.OPENAI_API_KEY) {
      return "OPENAI_API_KEY is not configured for Cloudflare Sandbox Codex";
    }
    if (
      session.githubToken &&
      !this.env.CRABBOX_TOKEN_ENCRYPTION_KEY &&
      !this.env.GITHUB_CLIENT_SECRET
    ) {
      return "CRABBOX_TOKEN_ENCRYPTION_KEY or GITHUB_CLIENT_SECRET is required for user GitHub tokens";
    }
    return null;
  }

  private async stageManagedFailure(
    sessionId: string,
    ownershipFence: SandboxLeaseRefreshFence,
    message: string,
    now: number,
  ): Promise<boolean> {
    const staged = await stageTerminalCredentialPolicyCleanupById(
      this.env,
      sessionId,
      "failed",
      message,
      now,
      message,
      ownershipFence,
    );
    await reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, sessionId);
    return staged;
  }
}
