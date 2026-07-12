import { runtimeAdapterName, runtimeAdapterReplayRequest } from "../runtime-adapter.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import type { InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { readAbandonedInteractiveSessionReservations } from "./openclaw-repository.ts";
import {
  claimRuntimeAdapterWorkspaceCleanup,
  claimRuntimeAdapterWorkspaceCleanupBatch,
  completeRuntimeAdapterWorkspaceCleanup,
  markRuntimeAdapterWorkspaceCleanupDeletionObserved,
  persistRuntimeAdapterWorkspaceCleanupEvidence,
  stageRuntimeAdapterWorkspaceCleanup,
} from "./provisioning/runtime-adapter-release-repository.ts";
import { safeProviderError } from "./provisioning/result.ts";
import { RuntimeAdapterReleaseService } from "./provisioning/runtime-adapter-release-service.ts";
import {
  clearRuntimeAdapterCreatePending,
  confirmRuntimeAdapterRelease,
  failRuntimeAdapterWorkspaceIdConflict,
  persistRuntimeAdapterStopEvidence,
  stageFailedRuntimeAdapterRelease,
  stageRuntimeAdapterProvision,
} from "./provisioning/runtime-adapter-repository.ts";
import { RuntimeAdapterProvisioningService } from "./provisioning/runtime-adapter.ts";
import { SandboxLifecycleService } from "./provisioning/sandbox-lifecycle.ts";
import { InteractiveProvisioningService } from "./provisioning/service.ts";
import {
  standaloneSandboxProvisionRequestHashInput,
  standaloneSandboxProvisionTtlMs,
  StandaloneSandboxProvisioningService,
} from "./provisioning/standalone-sandbox.ts";
import {
  activateStandaloneSandboxProvision,
  claimStandaloneSandboxProvision,
  readStandaloneSandboxProvision,
  stageStandaloneSandboxClaimCleanup,
  stageStandaloneSandboxProvisionCleanup,
} from "./provisioning/standalone-sandbox-repository.ts";
import { InteractiveProvisioningEndpoints } from "./provisioning/endpoints.ts";
import { sha256 } from "./crypto.ts";
import {
  requireRegisteredRuntimeAdapterControlPlane,
  runtimeAdapterConfigurationPresent,
} from "./runtime-adapter-preflight.ts";
import {
  readRuntimeAdapterResponseBody,
  runtimeAdapterFetch,
} from "./runtime-adapter-transport.ts";
import {
  RuntimeAdapterWorkspaceLifecycle,
  runtimeAdapterProviderConfigured,
} from "./runtime-adapter-workspaces.ts";
import { queueSandboxCredentialPolicyCleanup } from "./sandbox-credential-policy-repository.ts";
import { reconcileSandboxCredentialPolicyCleanupBatch } from "./sandbox-credential-policy-cleanup-service.ts";
import { credentialPolicyProvisioningStaleMs } from "./sandbox-credential-policy-scanner.ts";
import { scheduleInteractiveSessionReconciliation } from "./scheduled.ts";
import { ServiceRegistry } from "./service-registry.ts";
import { archiveInteractiveSessionLogs } from "./session-log-archive.ts";
import {
  claimInteractiveSessionReconciliation,
  InteractiveSessionReconciliationService,
  persistInteractiveSessionReconciliation,
  recordInteractiveSessionReconciliationFailure,
} from "./session-reconciliation.ts";
import {
  InteractiveSessionReconciliationScheduler,
  readInteractiveSessionReconciliationCandidates,
  readInteractiveSessionReconciliationRow,
  requeueTerminalArchiveObjectBackfill,
} from "./session-reconciliation-scheduler.ts";
import { readInteractiveSessionRecord } from "./session-repository.ts";
import { finalizeTerminalInteractiveSession } from "./session-terminal-finalization.ts";

export const runtimeAdapterReconcileIntervalMs = 15_000;

const runtimeAdapterReconcileLimit = 3;
const runtimeAdapterReconcileConcurrency = 3;
const runtimeAdapterReconcileForegroundBudgetMs = 750;
const interactiveSessionPreparationStaleMs = 5 * 60_000;
const services = {
  adapterProvisioning: Symbol("adapter-provisioning"),
  endpoints: Symbol("endpoints"),
  provisioning: Symbol("provisioning"),
  reconciliation: Symbol("reconciliation"),
  release: Symbol("release"),
  sandbox: Symbol("sandbox"),
  scheduler: Symbol("scheduler"),
  standaloneProvisioning: Symbol("standalone-provisioning"),
  workspaceLifecycle: Symbol("workspace-lifecycle"),
};

export type RuntimeApplicationDependencies = {
  rollbackReservation(sessionId: string, createdAt: number): Promise<void>;
};

export class RuntimeApplication {
  private readonly env: RuntimeEnv;
  private readonly dependencies: RuntimeApplicationDependencies;
  private readonly services = new ServiceRegistry();

  constructor(env: RuntimeEnv, dependencies: RuntimeApplicationDependencies) {
    this.env = env;
    this.dependencies = dependencies;
  }

  schedule(context: ExecutionContext): void {
    scheduleInteractiveSessionReconciliation(context, {
      now: Date.now,
      reconcile: (now) => this.scheduler().runBatch(now),
      reportError: (error) => {
        console.error("scheduled interactive session reconciliation failed", error);
      },
    });
  }

  async reconcileSessions(now: number, context?: ExecutionContext): Promise<void> {
    const reconciliation = this.scheduler()
      .runBatch(now)
      .catch((error) => {
        console.error("interactive session reconciliation failed", error);
      });
    if (!context) {
      await reconciliation;
      return;
    }
    context.waitUntil(reconciliation);
    await Promise.race([
      reconciliation,
      new Promise<void>((resolve) =>
        setTimeout(resolve, runtimeAdapterReconcileForegroundBudgetMs),
      ),
    ]);
  }

  async reconcileById(id: string, now = Date.now()): Promise<void> {
    await this.scheduler().reconcileById(id, now);
  }

  provisioning(): InteractiveProvisioningService {
    return this.services.get(services.provisioning, () => {
      const runtimeAdapter = this.adapterProvisioning();
      const sandbox = this.sandbox();
      return new InteractiveProvisioningService({
        sandboxAvailable: Boolean(this.env.SANDBOX),
        runtimeAdapterAvailable: runtimeAdapterConfigurationPresent(this.env),
        provisionSandbox: (session, agentToken, ownership) =>
          sandbox.provisionReservation(session, agentToken, ownership.lease, ownership.ownership),
        provisionRuntimeAdapter: (session) => runtimeAdapter.provision(session),
      });
    });
  }

  endpoints(): InteractiveProvisioningEndpoints {
    return this.services.get(services.endpoints, () => {
      const sandbox = this.sandbox();
      return new InteractiveProvisioningEndpoints(this.env, {
        provisionManaged: (session, owner) => sandbox.provisionManaged(session, owner),
        provisionStandalone: (session) => this.standaloneProvisioning().provision(session),
        supportsStandalone: (runtime) => this.provisioning().supportsStandalone(runtime),
      });
    });
  }

  workspaceLifecycle(): RuntimeAdapterWorkspaceLifecycle {
    return this.services.get(
      services.workspaceLifecycle,
      () =>
        new RuntimeAdapterWorkspaceLifecycle(this.env, {
          now: Date.now,
          fetch: (input, init) => runtimeAdapterFetch(this.env, input, init),
          readResponseBody: readRuntimeAdapterResponseBody,
          provisionReplay: (session, owner) =>
            this.adapterProvisioning().provision(runtimeAdapterReplayRequest(session), owner),
          releaseFailed: (sessionId, result) =>
            this.adapterProvisioning().releaseFailed(sessionId, result),
          failWorkspaceIdConflict: (input) =>
            failRuntimeAdapterWorkspaceIdConflict(this.env, input),
          recordConfirmedRelease: async (sessionId, adapterWorkspaceId, now, message) => {
            await confirmRuntimeAdapterRelease(
              this.env,
              sessionId,
              adapterWorkspaceId,
              now,
              message,
            );
          },
          archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
        }),
    );
  }

  release(): RuntimeAdapterReleaseService {
    return this.services.get(
      services.release,
      () =>
        new RuntimeAdapterReleaseService({
          stageCleanup: (input) => stageRuntimeAdapterWorkspaceCleanup(this.env, input),
          claimCleanup: (sessionId, adapterWorkspaceId, now) =>
            claimRuntimeAdapterWorkspaceCleanup(this.env, sessionId, adapterWorkspaceId, now),
          claimPendingCleanups: (now) =>
            claimRuntimeAdapterWorkspaceCleanupBatch(this.env, now, runtimeAdapterReconcileLimit),
          persistCleanupEvidence: (cleanup, message, now, reconcileError) =>
            persistRuntimeAdapterWorkspaceCleanupEvidence(
              this.env,
              cleanup,
              message,
              now,
              reconcileError,
            ),
          markCleanupDeletionObserved: (cleanup, now) =>
            markRuntimeAdapterWorkspaceCleanupDeletionObserved(this.env, cleanup, now),
          completeCleanup: (cleanup) => completeRuntimeAdapterWorkspaceCleanup(this.env, cleanup),
          clearCreatePending: (sessionId, adapterWorkspaceId) =>
            clearRuntimeAdapterCreatePending(this.env, sessionId, adapterWorkspaceId),
          stopWorkspace: (
            sessionId,
            adapterWorkspaceId,
            registration,
            retryMissing,
            deleteIdempotencyKey,
          ) =>
            this.workspaceLifecycle().stopForSession(
              sessionId,
              adapterWorkspaceId,
              registration,
              retryMissing,
              deleteIdempotencyKey,
            ),
          confirmRelease: (sessionId, adapterWorkspaceId, now, message) =>
            confirmRuntimeAdapterRelease(this.env, sessionId, adapterWorkspaceId, now, message),
          persistStopEvidence: (sessionId, adapterWorkspaceId, message, now, reconcileError) =>
            persistRuntimeAdapterStopEvidence(
              this.env,
              sessionId,
              adapterWorkspaceId,
              message,
              now,
              reconcileError,
            ),
          providerError: (error, adapterWorkspaceId) =>
            safeProviderError(error, [adapterWorkspaceId]),
        }),
    );
  }

  private scheduler(): InteractiveSessionReconciliationScheduler {
    return this.services.get(
      services.scheduler,
      () =>
        new InteractiveSessionReconciliationScheduler(
          {
            cleanupAbandonedPreparations: (now) => this.cleanupAbandonedPreparations(now),
            cleanupCredentialPolicies: (now, sessionId) =>
              reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, sessionId),
            providerConfigured: () => runtimeAdapterProviderConfigured(this.env),
            requeueTerminalArchiveBackfill: (sessionId) =>
              requeueTerminalArchiveObjectBackfill(
                this.env,
                sessionId,
                runtimeAdapterReconcileLimit,
              ),
            readBatchCandidates: (providerConfigured) =>
              readInteractiveSessionReconciliationCandidates(
                this.env,
                runtimeAdapterName,
                providerConfigured,
                runtimeAdapterReconcileLimit,
              ),
            readSession: (sessionId) =>
              readInteractiveSessionReconciliationRow(this.env, sessionId),
            reconcile: (row, now) => this.reconciliation().reconcile(row, now),
          },
          {
            adapterName: runtimeAdapterName,
            intervalMs: runtimeAdapterReconcileIntervalMs,
            limit: runtimeAdapterReconcileLimit,
            concurrency: runtimeAdapterReconcileConcurrency,
          },
        ),
    );
  }

  private reconciliation(): InteractiveSessionReconciliationService {
    return this.services.get(
      services.reconciliation,
      () =>
        new InteractiveSessionReconciliationService(
          {
            now: Date.now,
            claim: (row, claimAt) => claimInteractiveSessionReconciliation(this.env, row, claimAt),
            inspect: (row, claimAt) => this.workspaceLifecycle().inspect(row, claimAt),
            persist: (row, inspection, transition, claimAt) =>
              persistInteractiveSessionReconciliation(
                this.env,
                row,
                inspection,
                transition,
                claimAt,
                runtimeAdapterName,
              ),
            readSession: (sessionId) => readInteractiveSessionRecord(this.env, sessionId),
            stopSuperseded: (sessionId, adapterWorkspaceId, registration, createPending, now) =>
              this.release().stopSuperseded({
                sessionId,
                adapterWorkspaceId,
                registration,
                createPending,
                now,
              }),
            archive: (sessionId, now) => archiveInteractiveSessionLogs(this.env, sessionId, now),
            finalize: (sessionId, status, now) =>
              finalizeTerminalInteractiveSession(this.env, sessionId, status, now),
            recordFailure: (row, claimAt, failedAt, error) =>
              this.recordReconciliationFailure(row, claimAt, failedAt, error),
          },
          runtimeAdapterName,
        ),
    );
  }

  private adapterProvisioning(): RuntimeAdapterProvisioningService {
    return this.services.get(
      services.adapterProvisioning,
      () =>
        new RuntimeAdapterProvisioningService({
          namespace: this.env.CRABBOX_RUNTIME_ADAPTER_NAMESPACE ?? "",
          now: Date.now,
          resolveControlPlane: (profile, registeredControlPlane) =>
            requireRegisteredRuntimeAdapterControlPlane(this.env, profile, registeredControlPlane),
          stageProvision: (input) => stageRuntimeAdapterProvision(this.env, input),
          createWorkspace: async ({ url, adapterWorkspaceId, createPayloadJson }) => {
            const response = await runtimeAdapterFetch(this.env, url, {
              method: "POST",
              headers: { "idempotency-key": adapterWorkspaceId },
              body: createPayloadJson,
            });
            return {
              ok: response.ok,
              status: response.status,
              body: await readRuntimeAdapterResponseBody(response),
            };
          },
          failWorkspaceIdConflict: (input) =>
            failRuntimeAdapterWorkspaceIdConflict(this.env, input),
          stageFailedRelease: (sessionId, adapterWorkspaceId, message, now) =>
            stageFailedRuntimeAdapterRelease(this.env, sessionId, adapterWorkspaceId, message, now),
          stopWorkspaceForSession: (sessionId, adapterWorkspaceId) =>
            this.workspaceLifecycle().stopForSession(sessionId, adapterWorkspaceId),
          recordConfirmedRelease: async (sessionId, adapterWorkspaceId, now, message) => {
            await confirmRuntimeAdapterRelease(
              this.env,
              sessionId,
              adapterWorkspaceId,
              now,
              message,
            );
          },
          persistStopEvidence: (sessionId, adapterWorkspaceId, message, now) =>
            persistRuntimeAdapterStopEvidence(
              this.env,
              sessionId,
              adapterWorkspaceId,
              message,
              now,
            ),
        }),
    );
  }

  private sandbox(): SandboxLifecycleService {
    return this.services.get(services.sandbox, () => new SandboxLifecycleService(this.env));
  }

  private standaloneProvisioning(): StandaloneSandboxProvisioningService {
    return this.services.get(services.standaloneProvisioning, () => {
      const provisionTtlMs = standaloneSandboxProvisionTtlMs(this.env);
      return new StandaloneSandboxProvisioningService({
        now: Date.now,
        requestHash: (session) =>
          sha256(JSON.stringify(standaloneSandboxProvisionRequestHashInput(session))),
        readOwner: (provisionId) => readStandaloneSandboxProvision(this.env, provisionId),
        stageOwnerCleanup: (owner, message, now) =>
          stageStandaloneSandboxProvisionCleanup(this.env, owner, message, now),
        reconcileCleanup: (provisionId, now) =>
          reconcileSandboxCredentialPolicyCleanupBatch(this.env, now, provisionId),
        claim: (session, requestHash, now) =>
          claimStandaloneSandboxProvision(
            this.env,
            session,
            requestHash,
            now,
            credentialPolicyProvisioningStaleMs,
            provisionTtlMs,
          ),
        provision: (session, claim) =>
          this.sandbox().provisionClaim(session, undefined, claim.lease, claim.fence),
        stageClaimCleanup: (claim, message, now) =>
          stageStandaloneSandboxClaimCleanup(this.env, claim, message, now),
        queuePolicyCleanup: (provisionId, sandboxId, now) =>
          queueSandboxCredentialPolicyCleanup(this.env, provisionId, sandboxId, now),
        activate: (provisionId, claim, result, now) =>
          activateStandaloneSandboxProvision(this.env, provisionId, claim, result, now),
        providerError: safeProviderError,
      });
    });
  }

  private async cleanupAbandonedPreparations(now: number): Promise<void> {
    await this.release().retryPending(now);
    const rows = await readAbandonedInteractiveSessionReservations(
      this.env,
      now - interactiveSessionPreparationStaleMs,
      runtimeAdapterReconcileLimit,
    );
    await mapWithConcurrency(rows, runtimeAdapterReconcileConcurrency, async (row) => {
      await this.dependencies.rollbackReservation(row.sessionId, row.createdAt).catch((error) => {
        console.error(`interactive session preparation cleanup failed for ${row.sessionId}`, error);
      });
    });
  }

  private recordReconciliationFailure(
    row: InteractiveSessionRow,
    claimAt: number,
    failedAt: number,
    error: unknown,
  ): Promise<void> {
    return recordInteractiveSessionReconciliationFailure(
      this.env,
      row,
      claimAt,
      failedAt,
      safeProviderError(
        error,
        [row.adapter_workspace_id, row.provider_resource_id],
        [row.attach_url],
      ),
    );
  }
}
