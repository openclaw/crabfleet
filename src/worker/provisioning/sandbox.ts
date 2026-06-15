import type { InteractiveSessionRow } from "../database.ts";
import {
  sandboxLeaseId,
  type SandboxLease,
  type SandboxLeaseRefreshFence,
} from "../sandbox-lease.ts";
import { failedProvision } from "./result.ts";
import type { InteractiveProvisionRequest, InteractiveProvisionResult } from "./types.ts";

export type ManagedSandboxProvisionClaim = {
  agentToken: string;
  agentTokenHash: string;
  lease: SandboxLease;
  fence: SandboxLeaseRefreshFence;
  previousSandboxId: string | null;
  claimRevision: number;
};

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
      return failedProvision(message);
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

function managedSandboxOwnerReady(session: InteractiveSessionRow): boolean {
  return (
    ["provisioning", "pending_adapter"].includes(session.status) &&
    session.preparation_pending === 0 &&
    // Built-in Sandbox ownership is adapterless; non-null adapters belong to an external protocol.
    session.adapter === null &&
    session.credential_cleanup_terminal_status === null
  );
}
