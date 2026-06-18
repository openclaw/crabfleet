import type { StandaloneSandboxProvisionRow } from "../database.ts";
import { deploymentConfig } from "../deployment.ts";
import { clampedSeconds } from "../duration.ts";
import type { RuntimeEnv } from "../env.ts";
import {
  sandboxLeaseId,
  type SandboxLease,
  type StandaloneSandboxProvisionFence,
} from "../sandbox-lease.ts";
import { cleanupPendingProvision, failedProvision } from "./result.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export const standaloneSandboxDefaultTtlSeconds = 14_400;

export type StandaloneSandboxProvisionClaim = {
  lease: SandboxLease;
  fence: StandaloneSandboxProvisionFence;
  expiresAt: number;
  claimRevision: number;
};

export type StandaloneSandboxProvisioningDependencies = {
  now(): number;
  requestHash(session: InteractiveProvisionRequest): Promise<string>;
  readOwner(provisionId: string): Promise<StandaloneSandboxProvisionRow | null>;
  stageOwnerCleanup(
    owner: StandaloneSandboxProvisionRow,
    message: string,
    now: number,
  ): Promise<boolean>;
  reconcileCleanup(provisionId: string, now: number): Promise<void>;
  claim(
    session: InteractiveProvisionRequest,
    requestHash: string,
    now: number,
  ): Promise<StandaloneSandboxProvisionClaim | null>;
  provision(
    session: InteractiveProvisionRequest,
    claim: StandaloneSandboxProvisionClaim,
  ): Promise<InteractiveProvisionResult>;
  stageClaimCleanup(
    claim: StandaloneSandboxProvisionClaim,
    message: string,
    now: number,
  ): Promise<void>;
  queuePolicyCleanup(provisionId: string, sandboxId: string, now: number): Promise<void>;
  activate(
    provisionId: string,
    claim: StandaloneSandboxProvisionClaim,
    result: InteractiveProvisionResult,
    now: number,
  ): Promise<boolean>;
  providerError(error: unknown): string;
};

export class StandaloneSandboxProvisioningService {
  private readonly dependencies: StandaloneSandboxProvisioningDependencies;

  constructor(dependencies: StandaloneSandboxProvisioningDependencies) {
    this.dependencies = dependencies;
  }

  async provision(session: InteractiveProvisionRequest): Promise<InteractiveProvisionResult> {
    if (isManagedInteractiveSessionId(session.id)) {
      return failedProvision(
        "interactive provision failed: standalone provision id uses the managed session namespace",
      );
    }

    const requestHash = await this.dependencies.requestHash(session);
    const now = this.dependencies.now();
    let owner = await this.dependencies.readOwner(session.id);
    if (owner && owner.request_hash !== requestHash) {
      return failedProvision("interactive provision failed: provision id is already registered");
    }
    if (owner?.state === "active") {
      if (!owner.expires_at || owner.expires_at <= now) {
        await this.cleanupOwner(owner, "standalone Sandbox provision expired", now);
        return failedProvision(
          "interactive provision failed: standalone Sandbox provision expired",
        );
      }
      return activeProvisionResult(owner);
    }
    if (owner?.state === "cleanup_pending") {
      return failedProvision(
        "interactive provision failed: previous credential cleanup is pending",
      );
    }
    if (
      owner?.state === "provisioning" &&
      (owner.ownership_claim_expires_at ?? Number.NEGATIVE_INFINITY) <= now
    ) {
      const staged = await this.dependencies.stageOwnerCleanup(
        owner,
        "abandoned standalone Sandbox provision cleanup",
        now,
      );
      if (!staged) {
        return failedProvision("interactive provision failed: standalone ownership changed");
      }
      await this.dependencies.reconcileCleanup(session.id, now);
      owner = await this.dependencies.readOwner(session.id);
      if (owner) {
        return failedProvision(
          "interactive provision failed: previous credential cleanup is pending",
        );
      }
    }

    const claim = await this.dependencies.claim(session, requestHash, now);
    if (!claim) {
      return failedProvision("interactive provision failed: provision id is already in progress");
    }

    let result: InteractiveProvisionResult;
    try {
      result = await this.dependencies.provision(session, claim);
    } catch (error) {
      const message = `Cloudflare Sandbox provision failed: ${this.dependencies.providerError(error)}`;
      await this.cleanupClaim(session.id, claim, message, this.dependencies.now());
      return cleanupPendingProvision(sandboxLeaseId(claim.lease), message);
    }
    if (result.status !== "ready") {
      await this.cleanupClaim(session.id, claim, result.message, this.dependencies.now());
      return result;
    }
    if (result.leaseId !== sandboxLeaseId(claim.lease)) {
      const message = "interactive provision failed: standalone Sandbox lease mismatch";
      await this.cleanupClaim(session.id, claim, message, this.dependencies.now());
      return failedProvision(message);
    }

    const activated = await this.dependencies.activate(
      session.id,
      claim,
      result,
      this.dependencies.now(),
    );
    if (!activated) {
      await this.cleanupClaim(
        session.id,
        claim,
        "standalone ownership claim expired",
        this.dependencies.now(),
      );
      return failedProvision("interactive provision failed: standalone ownership claim expired");
    }
    return {
      ...result,
      expiresAt: claim.expiresAt,
      expiresAtPresent: true,
    };
  }

  private async cleanupOwner(
    owner: StandaloneSandboxProvisionRow,
    stageMessage: string,
    now: number,
  ): Promise<void> {
    await this.dependencies.stageOwnerCleanup(owner, stageMessage, now);
    await this.dependencies.reconcileCleanup(owner.id, now);
  }

  private async cleanupClaim(
    provisionId: string,
    claim: StandaloneSandboxProvisionClaim,
    message: string,
    now: number,
  ): Promise<void> {
    await this.dependencies.stageClaimCleanup(claim, message, now);
    await this.dependencies.queuePolicyCleanup(provisionId, claim.lease.sandboxId, now);
    await this.dependencies.reconcileCleanup(provisionId, now);
  }
}

export function standaloneSandboxProvisionRequestHashInput(
  session: InteractiveProvisionRequest,
): Omit<InteractiveProvisionRequest, "githubToken"> {
  const { githubToken: _githubToken, ...ownershipPayload } = session;
  return ownershipPayload;
}

export function isManagedInteractiveSessionId(id: string): boolean {
  return /^is-[0-9]+$/i.test(id);
}

export function standaloneSandboxAttachUrl(env: RuntimeEnv, provisionId: string): string {
  const url = new URL(
    `/api/provision/interactive/${encodeURIComponent(provisionId)}/pty`,
    deploymentConfig(env).canonicalUrl,
  );
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

export function standaloneSandboxProvisionTtlMs(env: RuntimeEnv): number {
  return (
    clampedSeconds(env.CRABBOX_STANDALONE_SANDBOX_TTL_SECONDS, standaloneSandboxDefaultTtlSeconds) *
    1000
  );
}

function activeProvisionResult(owner: StandaloneSandboxProvisionRow): InteractiveProvisionResult {
  return {
    status: "ready",
    leaseId: owner.lease_id,
    attachUrl: owner.attach_url,
    vncUrl: owner.vnc_url,
    expiresAt: owner.expires_at,
    expiresAtPresent: true,
    message: owner.message,
  };
}
