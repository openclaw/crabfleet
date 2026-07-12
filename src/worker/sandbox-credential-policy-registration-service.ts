import { fetchGithubRepoNodeId } from "./github.ts";
import { sealSecret } from "./crypto.ts";
import type { RuntimeEnv } from "./env.ts";
import {
  activeSandboxCredentialPolicyGeneration,
  abandonSandboxCredentialPolicyRegistration,
  beginSandboxCredentialPolicyRegistration,
  deferSandboxCredentialPolicyRollback,
  existingSandboxCredentialPolicyGeneration,
  finishSandboxCredentialPolicyRegistration,
  recordSandboxCredentialPolicyRefs,
  recordSandboxCredentialPolicyRollback,
  renewSandboxCredentialPolicyRegistration,
  standaloneSandboxPolicyExpiresAt,
  type SandboxCredentialPolicyOwnershipFence,
} from "./sandbox-credential-policy-repository.ts";
import {
  captureSandboxCredentialPolicyRollback,
  restoreSandboxCredentialPolicyRollback,
} from "./sandbox-credential-policy-rollback.ts";
import { sandboxCredentialPolicyExists } from "./sandbox-credential-policy-cleanup-service.ts";
import {
  sandboxLeaseInfo,
  sandboxLeasePrefix,
  type SandboxCurrentLeaseFence,
} from "./sandbox-lease.ts";
import type { SandboxRuntimeSession } from "./sandbox-runtime.ts";
import { sandboxControlStub } from "./session-control-do.ts";
import type {
  SandboxCredentialPolicy,
  SandboxCredentialPolicyRegistration,
  StoredSandboxCredentialPolicy,
} from "./session-control-policy.ts";
import type { InteractiveSession } from "./session-model.ts";

type RestoreSandboxCredentialPolicyRollback = typeof restoreSandboxCredentialPolicyRollback;

export async function restoreSandboxCredentialPolicyRollbackIfOwned(
  env: RuntimeEnv,
  stub: Pick<DurableObjectStub, "fetch">,
  sessionId: string,
  sandboxId: string,
  registration: SandboxCredentialPolicyRegistration,
  rollbackJson: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
  restoreRollback: RestoreSandboxCredentialPolicyRollback = restoreSandboxCredentialPolicyRollback,
): Promise<boolean> {
  const registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
    env,
    sessionId,
    sandboxId,
    registration,
    ownershipFence,
  );
  if (!registrationExpiresAt) return false;
  await restoreRollback(stub, registration, registrationExpiresAt, rollbackJson, sessionId);
  return true;
}

export async function registerSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: SandboxRuntimeSession,
  sandboxId: string,
  ownershipFence: SandboxCredentialPolicyOwnershipFence,
): Promise<void> {
  const stub = sandboxControlStub(env);
  if (!stub) throw new Error("SESSION_CONTROL Durable Object is not configured");
  const policyExpiresAt =
    "provisionId" in ownershipFence
      ? await standaloneSandboxPolicyExpiresAt(env, session.id, sandboxId, ownershipFence)
      : null;
  if ("provisionId" in ownershipFence && !policyExpiresAt) {
    throw new Error("standalone Sandbox credential expiry is unavailable");
  }
  const registration = await beginSandboxCredentialPolicyRegistration(
    env,
    session.id,
    sandboxId,
    ownershipFence,
  );
  let rollbackJson: string | null = null;
  let registrationWriteStarted = false;
  try {
    const activeGeneration = await activeSandboxCredentialPolicyGeneration(
      env,
      session.id,
      sandboxId,
    );
    const rollback = await captureSandboxCredentialPolicyRollback(
      stub,
      registration.lookupIds,
      activeGeneration,
      session.id,
    );
    if (
      !(await recordSandboxCredentialPolicyRollback(
        env,
        session.id,
        sandboxId,
        registration,
        rollback,
        ownershipFence,
      ))
    ) {
      throw new Error("sandbox credential policy rollback snapshot was not recorded");
    }
    rollbackJson = JSON.stringify(rollback);
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
      ...(policyExpiresAt ? { expiresAt: policyExpiresAt } : {}),
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
    for (const lookupId of registration.lookupIds) {
      const registrationExpiresAt = await renewSandboxCredentialPolicyRegistration(
        env,
        session.id,
        sandboxId,
        registration,
        ownershipFence,
      );
      if (!registrationExpiresAt) {
        throw new Error("sandbox credential policy registration claim was revoked");
      }
      registrationWriteStarted = true;
      const response = await stub.fetch("https://crabfleet.internal/api/session-control/register", {
        method: "POST",
        body: JSON.stringify({
          generation: registration.generation,
          registrationClaim: registration.claim,
          registrationExpiresAt,
          policy: { ...policy, sandboxId: lookupId },
        } satisfies StoredSandboxCredentialPolicy),
        headers: { "content-type": "application/json" },
      });
      if (!response.ok) {
        throw new Error("sandbox credential policy registration failed");
      }
    }
    if (
      !(await finishSandboxCredentialPolicyRegistration(
        env,
        session.id,
        sandboxId,
        registration,
        ownershipFence,
      ))
    ) {
      throw new Error("sandbox credential policy cleanup became pending during registration");
    }
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : String(error), 500);
    if (registrationWriteStarted && rollbackJson) {
      try {
        const restored = await restoreSandboxCredentialPolicyRollbackIfOwned(
          env,
          stub,
          session.id,
          sandboxId,
          registration,
          rollbackJson,
          ownershipFence,
        );
        if (!restored) {
          throw new Error("sandbox credential policy registration claim was revoked");
        }
      } catch (rollbackError) {
        const rollbackMessage = clean(
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
          500,
        );
        await deferSandboxCredentialPolicyRollback(
          env,
          session.id,
          sandboxId,
          registration,
          `${message}; ${rollbackMessage}`,
        ).catch(() => undefined);
        throw new Error("sandbox credential policy rollback restore is pending", { cause: error });
      }
    }
    await abandonSandboxCredentialPolicyRegistration(
      env,
      session.id,
      sandboxId,
      registration,
      message,
    ).catch(() => undefined);
    throw error;
  }
}

export async function ensureSandboxCredentialPolicy(
  env: RuntimeEnv,
  session: InteractiveSession & { githubToken?: string },
  sandboxId: string,
): Promise<void> {
  const leaseId = session.leaseId;
  if (!leaseId || !leaseId.startsWith(sandboxLeasePrefix)) {
    throw new Error("sandbox credential policy requires a current durable lease");
  }
  const lease = sandboxLeaseInfo(session);
  if (lease.sandboxId !== sandboxId) {
    throw new Error("sandbox credential policy lease ownership does not match");
  }
  const ownership: SandboxCurrentLeaseFence = { leaseId, sandboxId };
  const hasFreshUserToken = Boolean("githubToken" in session && session.githubToken);
  const generation = await existingSandboxCredentialPolicyGeneration(env, session.id, sandboxId);
  if (
    !hasFreshUserToken &&
    generation &&
    (await sandboxCredentialPolicyExists(env, sandboxId, generation))
  ) {
    if (
      !(await recordSandboxCredentialPolicyRefs(
        env,
        session.id,
        sandboxId,
        "active",
        generation,
        ownership,
      ))
    ) {
      throw new Error("sandbox credential policy lifecycle is unavailable");
    }
    return;
  }
  await registerSandboxCredentialPolicy(env, session, sandboxId, ownership);
}

function sandboxBackupAllowedHosts(env: RuntimeEnv): string[] {
  return env.CLOUDFLARE_ACCOUNT_ID && env.BACKUP_BUCKET_NAME
    ? [`${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`]
    : [];
}

function clean(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}
