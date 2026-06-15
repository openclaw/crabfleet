import { getSandbox, type BackupOptions } from "@cloudflare/sandbox";

import { actor } from "./auth.ts";
import type { RuntimeEnv } from "./env.ts";
import { serviceUnavailable } from "./http.ts";
import type { User } from "./models.ts";
import {
  SandboxSessionResourceService,
  type SandboxSessionResourceServiceDependencies,
} from "./sandbox-session-resource-service.ts";
import { sandboxLeaseInfo } from "./sandbox-lease.ts";
import { createSandboxSession, sandboxSetupSessionId } from "./sandbox-runtime.ts";
import { sandboxControlStub, type SandboxCheckpoint } from "./session-control-do.ts";
import { appendInteractiveSessionEventRecord } from "./session-events.ts";
import type { InteractiveSession } from "./session-model.ts";
import { readInteractiveSessionRecord } from "./session-repository.ts";

export type SandboxSessionResourceFactoryDependencies = {
  presentSession(session: InteractiveSession, user: User): InteractiveSession;
  delegatedControlAvailable(session: InteractiveSession): boolean;
};

export function createSandboxSessionResourceService(
  env: RuntimeEnv,
  dependencies: SandboxSessionResourceFactoryDependencies,
): SandboxSessionResourceService {
  const resourceDependencies: SandboxSessionResourceServiceDependencies = {
    now: Date.now,
    sandboxAvailable: Boolean(env.SANDBOX),
    readSession: (sessionId) => readInteractiveSessionRecord(env, sessionId),
    presentSession: dependencies.presentSession,
    delegatedControlAvailable: dependencies.delegatedControlAvailable,
    runDiagnostics: async (session, workdir, script) => {
      const sandbox = managedSandbox(env, session);
      const setup = await createSandboxSession(
        sandbox,
        sandboxSetupSessionId(session.id),
        "/workspace",
        {
          CRABBOX_SESSION_ID: session.id,
          CRABBOX_WORKDIR: workdir,
        },
      );
      return setup.exec(script, {
        timeout: 20_000,
        env: { CRABBOX_WORKDIR: workdir, CRABBOX_REPO: session.repo },
      });
    },
    listStoredCheckpoints: async (sessionId) => {
      const response = await checkpointRegistry(env).fetch(
        `https://crabfleet.internal/api/session-control/checkpoints/${encodeURIComponent(sessionId)}`,
      );
      if (!response.ok) throw serviceUnavailable("checkpoint registry is unavailable");
      const body = (await response.json()) as { checkpoints?: SandboxCheckpoint[] };
      return body.checkpoints ?? [];
    },
    storeCheckpoint: async (checkpoint) => {
      const response = await checkpointRegistry(env).fetch(
        "https://crabfleet.internal/api/session-control/checkpoints",
        {
          method: "POST",
          body: JSON.stringify(checkpoint),
          headers: { "content-type": "application/json" },
        },
      );
      if (!response.ok) throw serviceUnavailable("checkpoint registry is unavailable");
    },
    readStoredCheckpoint: async (sessionId, checkpointId) => {
      const response = await checkpointRegistry(env).fetch(
        `https://crabfleet.internal/api/session-control/checkpoints/${encodeURIComponent(
          sessionId,
        )}/${encodeURIComponent(checkpointId)}`,
      );
      if (!response.ok) return null;
      const body = (await response.json()) as { checkpoint?: SandboxCheckpoint };
      return body.checkpoint ?? null;
    },
    createBackup: (session, workdir, name) =>
      managedSandbox(env, session).createBackup(sandboxBackupOptions(env, workdir, name)),
    restoreBackup: async (session, backup) => {
      await managedSandbox(env, session).restoreBackup(backup);
    },
    appendEvent: (sessionId, user, message, now) =>
      appendInteractiveSessionEventRecord(env, {
        sessionId,
        actor: actor(user),
        message,
        now,
      }),
  };
  return new SandboxSessionResourceService(resourceDependencies);
}

function checkpointRegistry(env: RuntimeEnv) {
  const stub = sandboxControlStub(env);
  if (!stub) throw serviceUnavailable("SESSION_CONTROL Durable Object is not configured");
  return stub;
}

function managedSandbox(env: RuntimeEnv, session: InteractiveSession) {
  if (!env.SANDBOX) throw serviceUnavailable("Sandbox binding is not configured");
  return getSandbox(env.SANDBOX, sandboxLeaseInfo(session).sandboxId);
}

function sandboxBackupOptions(env: RuntimeEnv, workdir: string, name: string): BackupOptions {
  const localBucket = env.CRABFLEET_LOCAL_SANDBOX_BACKUPS !== "0";
  if (localBucket && !env.BACKUP_BUCKET) {
    throw serviceUnavailable("checkpoint backups require the BACKUP_BUCKET R2 binding");
  }
  if (!localBucket && !sandboxHasPresignedBackupConfig(env)) {
    throw serviceUnavailable(
      "checkpoint backups require BACKUP_BUCKET plus CLOUDFLARE_ACCOUNT_ID, BACKUP_BUCKET_NAME, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY",
    );
  }
  return {
    dir: workdir,
    excludes: ["node_modules", ".pnpm-store", ".cache", "dist", "build"],
    gitignore: true,
    ...(localBucket ? { localBucket: true } : {}),
    name,
  };
}

function sandboxHasPresignedBackupConfig(env: RuntimeEnv): boolean {
  return Boolean(
    env.BACKUP_BUCKET &&
    env.CLOUDFLARE_ACCOUNT_ID &&
    env.BACKUP_BUCKET_NAME &&
    env.R2_ACCESS_KEY_ID &&
    env.R2_SECRET_ACCESS_KEY,
  );
}
