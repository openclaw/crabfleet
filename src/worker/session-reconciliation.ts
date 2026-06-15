import { sql } from "kysely";

import { clearedAdapterCapabilities } from "../runtime-adapter.ts";
import { database, type CompilableQuery, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { InteractiveSessionStatus } from "./models.ts";
import type { InteractiveProvisionResult } from "./session-provisioning.ts";
import type { InteractiveSession } from "./session-model.ts";

export type RuntimeAdapterReconciliationTransition = {
  status: InteractiveSessionStatus;
  providerResourceId: string | null;
  attachUrl: string | null;
  capabilitiesJson: string;
  expiresAt: number | null;
  reconcileError: string | null;
  terminalStatus: "failed" | null;
  createPending: number;
  inactive: boolean;
  stoppedAt: number | null;
  evidenceChanged: boolean;
  completedAt: number;
  completionVersion: number;
};

export type InteractiveSessionReconciliationStore = {
  now(): number;
  claim(row: InteractiveSessionRow, claimAt: number): Promise<boolean>;
  inspect(row: InteractiveSessionRow, claimAt: number): Promise<InteractiveProvisionResult>;
  persist(
    row: InteractiveSessionRow,
    inspection: InteractiveProvisionResult,
    transition: RuntimeAdapterReconciliationTransition,
    claimAt: number,
  ): Promise<boolean>;
  readSession(sessionId: string): Promise<InteractiveSession | null>;
  stopSuperseded(
    sessionId: string,
    adapterWorkspaceId: string,
    createPending: boolean,
    now: number,
  ): Promise<void>;
  archive(sessionId: string, now: number): Promise<void>;
  finalize(sessionId: string, status: "stopped" | "expired" | "failed", now: number): Promise<void>;
  recordFailure(
    row: InteractiveSessionRow,
    claimAt: number,
    failedAt: number,
    error: unknown,
  ): Promise<void>;
};

export class InteractiveSessionReconciliationService {
  private readonly store: InteractiveSessionReconciliationStore;
  private readonly adapterName: string;

  constructor(store: InteractiveSessionReconciliationStore, adapterName: string) {
    this.store = store;
    this.adapterName = adapterName;
  }

  async reconcile(row: InteractiveSessionRow, now: number): Promise<void> {
    const terminalStatus = terminalFinalizationStatus(row);
    if (!terminalStatus && (row.adapter !== this.adapterName || !row.adapter_workspace_id)) return;

    const claimAt = Math.max(now, this.store.now(), (row.last_reconciled_at ?? 0) + 1);
    if (!(await this.store.claim(row, claimAt))) return;

    try {
      if (terminalStatus) {
        await this.store.finalize(row.id, terminalStatus, row.stopped_at ?? now);
        return;
      }
      if (row.adapter !== this.adapterName || !row.adapter_workspace_id) return;

      const inspection = await this.store.inspect(row, claimAt);
      const transition = runtimeAdapterReconciliationTransition(
        row,
        inspection,
        Math.max(this.store.now(), claimAt),
      );
      if (!(await this.store.persist(row, inspection, transition, claimAt))) {
        await this.recoverLostOwnership(row, inspection, now);
        return;
      }
      if (transition.evidenceChanged) {
        await this.store.archive(row.id, transition.completedAt).catch(() => undefined);
      }
      if (row.status !== transition.status && isTerminalStatus(transition.status)) {
        await this.store
          .finalize(row.id, transition.status, row.stopped_at ?? transition.completedAt)
          .catch(() => undefined);
      }
    } catch (error) {
      await this.store.recordFailure(row, claimAt, Math.max(this.store.now(), claimAt), error);
    }
  }

  private async recoverLostOwnership(
    row: InteractiveSessionRow,
    inspection: InteractiveProvisionResult,
    now: number,
  ): Promise<void> {
    const current = await this.store.readSession(row.id);
    if (current && isTerminalStatus(current.status)) {
      await this.store
        .finalize(current.id, current.status, current.stoppedAt ?? now)
        .catch(() => undefined);
      return;
    }
    if (
      current &&
      current.adapter === this.adapterName &&
      current.adapterWorkspaceId === inspection.adapterWorkspaceId &&
      ["provisioning", "pending_adapter", "ready", "attached", "detached"].includes(current.status)
    ) {
      return;
    }
    if (inspection.adapterWorkspaceId) {
      await this.store.stopSuperseded(
        row.id,
        inspection.adapterWorkspaceId,
        inspection.createPending === true,
        this.store.now(),
      );
    }
  }
}

export async function claimInteractiveSessionReconciliation(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  claimAt: number,
): Promise<boolean> {
  let claim = database(env)
    .updateTable("interactive_sessions")
    .set({ last_reconciled_at: claimAt })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("updated_at", "=", row.updated_at);
  claim = row.last_reconciled_at
    ? claim.where("last_reconciled_at", "=", row.last_reconciled_at)
    : claim.where("last_reconciled_at", "is", null);
  const claimed = await claim.executeTakeFirst();
  return (claimed.numUpdatedRows ?? 0n) > 0n;
}

export async function persistInteractiveSessionReconciliation(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  inspection: InteractiveProvisionResult,
  transition: RuntimeAdapterReconciliationTransition,
  claimAt: number,
  adapterName: string,
): Promise<boolean> {
  const expectedOwner = sql<boolean>`
    id = ${row.id}
    AND adapter = ${adapterName}
    AND status = ${row.status}
    AND updated_at = ${row.updated_at}
    AND last_reconciled_at = ${claimAt}
  `;
  const db = database(env);
  const update = db
    .updateTable("interactive_sessions")
    .set({
      status: transition.status,
      lease_id: null,
      provider_resource_id: transition.providerResourceId,
      attach_url: transition.attachUrl,
      // Connection-bearing desktop URLs are never persisted.
      vnc_url: null,
      capabilities_json: transition.capabilitiesJson,
      expires_at: transition.expiresAt,
      last_reconciled_at: transition.completedAt,
      reconcile_error: transition.reconcileError,
      terminal_status: transition.terminalStatus,
      adapter_create_pending: transition.createPending,
      terminal_finalize_pending: isTerminalStatus(transition.status)
        ? 1
        : row.terminal_finalize_pending,
      ...(transition.inactive
        ? {
            agent_token_hash: null,
            controller: null,
            control_requested_by: null,
            control_requested_at: null,
            control_granted_at: null,
            control_expires_at: null,
          }
        : {}),
      stopped_at: transition.stoppedAt,
      ...(transition.evidenceChanged
        ? { updated_at: transition.completionVersion, last_event: inspection.message }
        : {}),
    })
    .where(expectedOwner)
    .returning("updated_at");
  const queries: CompilableQuery[] = [];
  if (transition.evidenceChanged) {
    queries.push(sql`
      INSERT INTO interactive_session_events (session_id, actor, message, created_at)
      SELECT ${row.id}, 'system', ${clean(inspection.message, 1000)}, ${transition.completedAt}
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
  return Boolean(results.at(-1)?.results.length);
}

export async function recordInteractiveSessionReconciliationFailure(
  env: RuntimeEnv,
  row: InteractiveSessionRow,
  claimAt: number,
  failedAt: number,
  reconcileError: string,
): Promise<void> {
  await database(env)
    .updateTable("interactive_sessions")
    .set({
      last_reconciled_at: failedAt,
      reconcile_error: reconcileError,
      updated_at: Math.max(failedAt, row.updated_at + 1),
    })
    .where("id", "=", row.id)
    .where("status", "=", row.status)
    .where("updated_at", "=", row.updated_at)
    .where("last_reconciled_at", "=", claimAt)
    .execute();
}

export function runtimeAdapterReconciliationTransition(
  row: InteractiveSessionRow,
  inspection: InteractiveProvisionResult,
  completedAt: number,
): RuntimeAdapterReconciliationTransition {
  const requestedTerminalStatus =
    inspection.terminalStatus === undefined ? row.terminal_status : inspection.terminalStatus;
  const status = reconciledInteractiveStatus(
    row.status,
    inspection.status,
    requestedTerminalStatus,
  );
  const inactive = ["stopping", "stopped", "expired", "failed"].includes(status);
  const terminalStatus = isTerminalStatus(status) ? null : requestedTerminalStatus;
  const attachUrl = inactive
    ? null
    : inspection.attachUrlPresent
      ? inspection.attachUrl
      : row.attach_url;
  const capabilitiesJson = inspection.capabilities
    ? JSON.stringify(inspection.capabilities)
    : inspection.capabilitiesPresent
      ? JSON.stringify(clearedAdapterCapabilities)
      : row.capabilities_json;
  const expiresAt = inspection.expiresAtPresent ? (inspection.expiresAt ?? null) : row.expires_at;
  const createPending =
    inspection.createPending === undefined
      ? row.adapter_create_pending
      : inspection.createPending
        ? 1
        : 0;
  const providerResourceId = inspection.providerResourceId ?? row.provider_resource_id;
  const reconcileError = inspection.reconcileError ?? null;
  const evidenceChanged =
    status !== row.status ||
    attachUrl !== row.attach_url ||
    capabilitiesJson !== row.capabilities_json ||
    providerResourceId !== row.provider_resource_id ||
    expiresAt !== row.expires_at ||
    terminalStatus !== row.terminal_status ||
    createPending !== row.adapter_create_pending ||
    reconcileError !== row.reconcile_error ||
    inspection.message !== row.last_event;
  return {
    status,
    providerResourceId,
    attachUrl,
    capabilitiesJson,
    expiresAt,
    reconcileError,
    terminalStatus,
    createPending,
    inactive,
    stoppedAt: isTerminalStatus(status) ? (row.stopped_at ?? completedAt) : row.stopped_at,
    evidenceChanged,
    completedAt,
    completionVersion: Math.max(completedAt, row.updated_at + 1),
  };
}

export function reconciledInteractiveStatus(
  current: InteractiveSessionStatus,
  next: InteractiveSessionStatus,
  terminalStatus: "failed" | null,
): InteractiveSessionStatus {
  if (current === "stopping") {
    if (isTerminalStatus(next)) return terminalStatus ?? next;
    return "stopping";
  }
  if ((current === "attached" || current === "detached") && next === "ready") return current;
  return next;
}

function terminalFinalizationStatus(
  row: Pick<InteractiveSessionRow, "status" | "terminal_finalize_pending">,
): "stopped" | "expired" | "failed" | null {
  return row.terminal_finalize_pending === 1 && isTerminalStatus(row.status) ? row.status : null;
}

function isTerminalStatus(
  status: InteractiveSessionStatus,
): status is "stopped" | "expired" | "failed" {
  return status === "stopped" || status === "expired" || status === "failed";
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
