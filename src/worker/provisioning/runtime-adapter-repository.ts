import { sql } from "kysely";

import {
  retainedRuntimeAdapterFailureMessage,
  resolveCreateAfterStopRace,
  runtimeAdapterName,
} from "../../runtime-adapter.ts";
import { database, executeBatch, type CompilableQuery } from "../database.ts";
import type { RuntimeEnv } from "../env.ts";
import { archiveInteractiveSessionLogs } from "../session-log-archive.ts";
import { finalizeTerminalInteractiveSession } from "../session-terminal-finalization.ts";
import type {
  RuntimeAdapterProvisionStageInput,
  RuntimeAdapterWorkspaceConflictInput,
} from "./runtime-adapter.ts";
import type { InteractiveProvisionResult } from "./types.ts";

export type RuntimeAdapterReleaseEffects = {
  archive(sessionId: string, now: number): Promise<void>;
  finalize(sessionId: string, status: "stopped" | "expired" | "failed", now: number): Promise<void>;
};

export async function stageRuntimeAdapterProvision(
  env: RuntimeEnv,
  input: RuntimeAdapterProvisionStageInput,
) {
  let stage = database(env)
    .updateTable("interactive_sessions")
    .set({
      adapter: runtimeAdapterName,
      profile: input.session.profile,
      adapter_workspace_id: input.adapterWorkspaceId,
      capabilities_json: JSON.stringify(input.capabilities),
      adapter_ttl_seconds: input.ttlSeconds,
      adapter_idle_timeout_seconds: input.idleTimeoutSeconds,
      adapter_requested_capabilities_json: JSON.stringify(input.capabilities),
      adapter_create_payload_json: input.createPayloadJson,
      adapter_create_pending: 1,
      reconcile_error: "runtime adapter create pending",
      ...(input.reconciliationOwner
        ? {}
        : { updated_at: sql<number>`MAX(updated_at + 1, ${input.now})` }),
    })
    .where("id", "=", input.session.id)
    .where("adapter_control_plane", "=", input.adapterControlPlane)
    .where("adapter_workspace_id", "=", input.adapterWorkspaceId);
  if (input.reconciliationOwner) {
    stage = stage
      .where("status", "=", input.reconciliationOwner.status)
      .where("updated_at", "=", input.reconciliationOwner.updatedAt);
    stage =
      input.reconciliationOwner.lastReconciledAt === null
        ? stage.where("last_reconciled_at", "is", null)
        : stage.where("last_reconciled_at", "=", input.reconciliationOwner.lastReconciledAt);
    stage =
      input.reconciliationOwner.terminalStatus === null
        ? stage.where("terminal_status", "is", null)
        : stage.where("terminal_status", "=", input.reconciliationOwner.terminalStatus);
  } else {
    stage = stage.where("status", "in", ["provisioning", "pending_adapter"]);
  }
  const staged = await stage
    .returning(["status", "updated_at", "last_reconciled_at", "terminal_status"])
    .executeTakeFirst();
  return staged
    ? {
        status: staged.status,
        updatedAt: staged.updated_at,
        lastReconciledAt: staged.last_reconciled_at,
        terminalStatus: staged.terminal_status,
      }
    : null;
}

export async function failRuntimeAdapterWorkspaceIdConflict(
  env: RuntimeEnv,
  input: RuntimeAdapterWorkspaceConflictInput,
): Promise<InteractiveProvisionResult | null> {
  const failureMessage = clean(input.message, 500);
  const lastReconciledOwner =
    input.createAttempt.lastReconciledAt === null
      ? sql<boolean>`last_reconciled_at IS NULL`
      : sql<boolean>`last_reconciled_at = ${input.createAttempt.lastReconciledAt}`;
  const terminalStatusOwner =
    input.createAttempt.terminalStatus === null
      ? sql<boolean>`terminal_status IS NULL`
      : sql<boolean>`terminal_status = ${input.createAttempt.terminalStatus}`;
  const expectedOwner = sql<boolean>`
    id = ${input.session.id}
    AND adapter = ${runtimeAdapterName}
    AND adapter_workspace_id = ${input.adapterWorkspaceId}
    AND adapter_control_plane = ${input.adapterControlPlane}
    AND adapter_create_payload_json = ${input.createPayloadJson}
    AND adapter_requested_capabilities_json = ${JSON.stringify(input.capabilities)}
    AND adapter_create_pending = 1
    AND status = ${input.createAttempt.status}
    AND updated_at = ${input.createAttempt.updatedAt}
    AND ${lastReconciledOwner}
    AND ${terminalStatusOwner}
  `;
  const db = database(env);
  const event = sql`
    INSERT INTO interactive_session_events (session_id, actor, message, created_at)
    SELECT ${input.session.id}, 'system', ${failureMessage}, ${input.now}
    FROM interactive_sessions
    WHERE ${expectedOwner}
  `;
  const detach = db
    .updateTable("interactive_sessions")
    .set({
      status: "failed",
      adapter: null,
      adapter_workspace_id: null,
      adapter_control_plane: null,
      provider_resource_id: null,
      adapter_ttl_seconds: null,
      adapter_idle_timeout_seconds: null,
      adapter_requested_capabilities_json: null,
      adapter_create_payload_json: null,
      adapter_create_pending: 0,
      lease_id: null,
      attach_url: null,
      vnc_url: null,
      expires_at: null,
      last_reconciled_at: input.now,
      reconcile_error: failureMessage,
      terminal_status: null,
      terminal_failure_reason: failureMessage,
      terminal_finalize_pending: 1,
      stopped_at: input.now,
      agent_token_hash: null,
      controller: null,
      controller_subject: null,
      control_requested_by: null,
      control_requested_by_subject: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      last_event: failureMessage,
      updated_at: sql<number>`MAX(updated_at + 1, ${input.now})`,
    })
    .where(expectedOwner)
    .returning("updated_at");
  const results = await env.DB.batch<{ updated_at: number }>(
    [event, detach].map((query) => {
      const compiled = query.compile(db);
      return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
    }),
  );
  if (!results.at(-1)?.results.length) return null;
  await archiveInteractiveSessionLogs(env, input.session.id, input.now).catch(() => undefined);
  await finalizeTerminalInteractiveSession(env, input.session.id, "failed", input.now).catch(
    () => undefined,
  );
  return {
    status: "failed",
    leaseId: null,
    attachUrl: null,
    attachUrlPresent: true,
    vncUrl: null,
    message: failureMessage,
    adapter: null,
    profile: input.session.profile,
    adapterWorkspaceId: null,
    providerResourceId: null,
    capabilities: input.capabilities,
    capabilitiesPresent: true,
    expiresAt: null,
    expiresAtPresent: true,
    reconciledAt: input.now,
    reconcileError: failureMessage,
    terminalStatus: null,
    createPending: false,
  };
}

export async function persistRuntimeAdapterStopEvidence(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  message: string,
  now: number,
  reconcileError: string | null = message,
  eventActor = "system",
): Promise<void> {
  const evidence = clean(message, 500);
  const errorEvidence = reconcileError ? clean(reconcileError, 500) : null;
  const actorName = clean(eventActor, 120) || "system";
  const reconcileErrorOwner = errorEvidence
    ? sql<boolean>`reconcile_error = ${errorEvidence}`
    : sql<boolean>`reconcile_error IS NULL`;
  const db = database(env);
  await executeBatch(env, [
    db
      .updateTable("interactive_sessions")
      .set({
        last_reconciled_at: now,
        reconcile_error: errorEvidence,
        last_event: evidence,
        updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      })
      .where("id", "=", sessionId)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .where("status", "=", "stopping").where(sql<boolean>`
        COALESCE(last_event, '') != ${evidence}
        OR COALESCE(reconcile_error, '') != ${errorEvidence ?? ""}
      `),
    sql`
      INSERT INTO interactive_session_events (session_id, actor, message, created_at)
      SELECT ${sessionId}, ${actorName}, ${evidence}, ${now}
      WHERE EXISTS (
        SELECT 1
        FROM interactive_sessions
        WHERE id = ${sessionId}
          AND adapter = ${runtimeAdapterName}
          AND adapter_workspace_id = ${adapterWorkspaceId}
          AND status = 'stopping'
          AND last_event = ${evidence}
          AND ${reconcileErrorOwner}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM interactive_session_events
        WHERE session_id = ${sessionId}
          AND actor = ${actorName}
          AND message = ${evidence}
      )
    `,
  ]);
  await archiveInteractiveSessionLogs(env, sessionId, now).catch(() => undefined);
}

export async function confirmRuntimeAdapterRelease(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  now: number,
  releaseMessage?: string,
  effects?: RuntimeAdapterReleaseEffects,
): Promise<"stopping" | "stopped" | "failed" | null> {
  const releaseEffects = effects ?? {
    archive: (id: string, at: number) => archiveInteractiveSessionLogs(env, id, at),
    finalize: (id: string, status: "stopped" | "expired" | "failed", at: number) =>
      finalizeTerminalInteractiveSession(env, id, status, at),
  };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lifecycle = await database(env)
      .selectFrom("interactive_sessions")
      .select([
        "adapter_create_pending",
        "terminal_status",
        "terminal_failure_reason",
        "reconcile_error",
        "last_event",
        "updated_at",
      ])
      .where("id", "=", sessionId)
      .where("adapter", "=", runtimeAdapterName)
      .where("adapter_workspace_id", "=", adapterWorkspaceId)
      .where("status", "=", "stopping")
      .executeTakeFirst();
    if (!lifecycle) return null;

    const resolved = resolveCreateAfterStopRace(
      lifecycle.adapter_create_pending === 1,
      lifecycle.terminal_status,
    );
    const failureMessage = retainedRuntimeAdapterFailureMessage(
      lifecycle.terminal_failure_reason,
      lifecycle.reconcile_error,
      lifecycle.last_event,
    );
    const retainedReleaseMessage = clean(releaseMessage, 500) || null;
    const values =
      resolved.status === "stopping"
        ? ({
            adapter_create_pending: 1,
            last_reconciled_at: now,
            updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
            last_event:
              retainedReleaseMessage ?? "runtime adapter stop waiting for create resolution",
          } as const)
        : ({
            status: resolved.status,
            lease_id: null,
            attach_url: null,
            vnc_url: null,
            terminal_status: resolved.terminalStatus,
            terminal_failure_reason: resolved.status === "failed" ? failureMessage : null,
            adapter_create_pending: 0,
            terminal_finalize_pending: 1,
            last_reconciled_at: now,
            reconcile_error: resolved.status === "failed" ? failureMessage : null,
            stopped_at: now,
            agent_token_hash: null,
            controller: null,
            controller_subject: null,
            control_requested_by: null,
            control_requested_by_subject: null,
            control_requested_at: null,
            control_granted_at: null,
            control_expires_at: null,
            updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
            last_event:
              resolved.status === "failed"
                ? failureMessage
                : (retainedReleaseMessage ?? "interactive workspace stopped"),
          } as const);
    const terminalStatusOwner = lifecycle.terminal_status
      ? sql<boolean>`terminal_status = ${lifecycle.terminal_status}`
      : sql<boolean>`terminal_status IS NULL`;
    const expectedOwner = sql<boolean>`
      id = ${sessionId}
      AND adapter = ${runtimeAdapterName}
      AND adapter_workspace_id = ${adapterWorkspaceId}
      AND status = 'stopping'
      AND adapter_create_pending = ${lifecycle.adapter_create_pending}
      AND updated_at = ${lifecycle.updated_at}
      AND ${terminalStatusOwner}
    `;
    const db = database(env);
    const update = db
      .updateTable("interactive_sessions")
      .set(values)
      .where(expectedOwner)
      .returning("updated_at");
    const recordReleaseEvent =
      retainedReleaseMessage &&
      (resolved.status !== "stopping" || lifecycle.last_event !== retainedReleaseMessage);
    const queries: CompilableQuery[] = [];
    if (recordReleaseEvent) {
      queries.push(sql`
        INSERT INTO interactive_session_events (session_id, actor, message, created_at)
        SELECT ${sessionId}, 'system', ${retainedReleaseMessage}, ${now}
        FROM interactive_sessions
        WHERE ${expectedOwner}
      `);
    }
    queries.push(update);
    const results = await env.DB.batch<{ updated_at: number }>(
      queries.map((query) => {
        const compiled = query.compile(db);
        return env.DB.prepare(compiled.sql).bind(...compiled.parameters);
      }),
    );
    if (results.at(-1)?.results.length) {
      if (recordReleaseEvent) {
        await releaseEffects.archive(sessionId, now).catch(() => undefined);
      }
      if (resolved.status === "stopped" || resolved.status === "failed") {
        await releaseEffects.finalize(sessionId, resolved.status, now).catch(() => undefined);
      }
      return resolved.status;
    }
  }
  return null;
}

export async function clearRuntimeAdapterCreatePending(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
): Promise<void> {
  const now = Date.now();
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      adapter_create_pending: 0,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
    })
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("status", "=", "stopping")
    .where("adapter_create_pending", "=", 1)
    .execute();
}

export async function stageFailedRuntimeAdapterRelease(
  env: RuntimeEnv,
  sessionId: string,
  adapterWorkspaceId: string,
  message: string,
  now: number,
): Promise<void> {
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      status: "stopping",
      lease_id: null,
      attach_url: null,
      vnc_url: null,
      terminal_status: "failed",
      terminal_failure_reason: message,
      adapter_create_pending: 0,
      last_reconciled_at: now,
      reconcile_error: message,
      agent_token_hash: null,
      controller: null,
      controller_subject: null,
      control_requested_by: null,
      control_requested_by_subject: null,
      control_requested_at: null,
      control_granted_at: null,
      control_expires_at: null,
      updated_at: sql<number>`MAX(updated_at + 1, ${now})`,
      last_event: `${message}; runtime workspace release pending`,
    })
    .where("id", "=", sessionId)
    .where("adapter", "=", runtimeAdapterName)
    .where("adapter_workspace_id", "=", adapterWorkspaceId)
    .where("status", "in", [
      "provisioning",
      "pending_adapter",
      "ready",
      "attached",
      "detached",
      "stopping",
    ])
    .execute();
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
