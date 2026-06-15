import { sql } from "kysely";

import { githubActionsRuntime } from "../github-actions-runtime.ts";
import { mapWithConcurrency } from "./concurrency.ts";
import { database, type InteractiveSessionRow } from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import type { InteractiveSessionStatus } from "./models.ts";

const activeReconciliationStatuses: readonly InteractiveSessionStatus[] = [
  "provisioning",
  "pending_adapter",
  "ready",
  "attached",
  "detached",
  "stopping",
];
const terminalReconciliationStatuses: readonly InteractiveSessionStatus[] = [
  "stopped",
  "expired",
  "failed",
];

export type InteractiveSessionReconciliationSchedulerConfig = {
  adapterName: string;
  sandboxLeasePrefix: string;
  intervalMs: number;
  limit: number;
  concurrency: number;
};

export type InteractiveSessionReconciliationSchedulerStore = {
  cleanupAbandonedPreparations(now: number): Promise<void>;
  cleanupCredentialPolicies(now: number, sessionId?: string): Promise<void>;
  providerConfigured(): boolean;
  readLegacyStoppingCandidates(sessionId?: string): Promise<InteractiveSessionRow[]>;
  completeLegacyStop(row: InteractiveSessionRow, now: number): Promise<void>;
  requeueTerminalArchiveBackfill(sessionId?: string): Promise<void>;
  readBatchCandidates(providerConfigured: boolean): Promise<InteractiveSessionRow[]>;
  readSession(sessionId: string): Promise<InteractiveSessionRow | undefined>;
  reconcile(row: InteractiveSessionRow, now: number): Promise<void>;
  report(message: string, error: unknown): void;
};

export class InteractiveSessionReconciliationScheduler {
  private readonly store: InteractiveSessionReconciliationSchedulerStore;
  private readonly config: InteractiveSessionReconciliationSchedulerConfig;

  constructor(
    store: InteractiveSessionReconciliationSchedulerStore,
    config: InteractiveSessionReconciliationSchedulerConfig,
  ) {
    this.store = store;
    this.config = config;
  }

  async runBatch(now: number): Promise<void> {
    await this.store.cleanupAbandonedPreparations(now);
    await this.store.cleanupCredentialPolicies(now);
    await this.recoverLegacyStops(now);
    await this.reconcileExternalBatch(now);
  }

  async reconcileById(sessionId: string, now: number): Promise<void> {
    await this.store.cleanupCredentialPolicies(now, sessionId);
    await this.recoverLegacyStops(now, sessionId);
    await this.store.requeueTerminalArchiveBackfill(sessionId);
    const row = await this.store.readSession(sessionId);
    if (
      row &&
      interactiveSessionReconciliationDue(row, now, {
        adapterName: this.config.adapterName,
        providerConfigured: this.store.providerConfigured(),
        intervalMs: this.config.intervalMs,
      })
    ) {
      await this.store.reconcile(row, now);
    }
  }

  private async recoverLegacyStops(now: number, sessionId?: string): Promise<void> {
    const candidates = await this.store.readLegacyStoppingCandidates(sessionId);
    await mapWithConcurrency(candidates, this.config.concurrency, async (row) => {
      await this.store.completeLegacyStop(row, now).catch((error) => {
        this.store.report(`legacy interactive session stop recovery failed for ${row.id}`, error);
      });
    });
  }

  private async reconcileExternalBatch(now: number): Promise<void> {
    await this.store.requeueTerminalArchiveBackfill();
    const providerConfigured = this.store.providerConfigured();
    const candidates = await this.store.readBatchCandidates(providerConfigured);
    const due = candidates
      .filter((row) =>
        interactiveSessionReconciliationDue(row, now, {
          adapterName: this.config.adapterName,
          providerConfigured,
          intervalMs: this.config.intervalMs,
        }),
      )
      .slice(0, this.config.limit);
    await mapWithConcurrency(due, this.config.concurrency, (row) => this.store.reconcile(row, now));
  }
}

export function interactiveSessionReconciliationDue(
  row: InteractiveSessionRow,
  now: number,
  options: {
    adapterName: string;
    providerConfigured: boolean;
    intervalMs: number;
  },
): boolean {
  const terminalFinalizationPending =
    row.terminal_finalize_pending === 1 && terminalReconciliationStatuses.includes(row.status);
  const activeAdapter =
    options.providerConfigured &&
    row.adapter === options.adapterName &&
    activeReconciliationStatuses.includes(row.status);
  if (!terminalFinalizationPending && !activeAdapter) return false;
  return !row.last_reconciled_at || now - row.last_reconciled_at >= options.intervalMs;
}

export async function readLegacyStoppingInteractiveSessionCandidates(
  env: RuntimeEnv,
  options: {
    adapterName: string;
    sandboxLeasePrefix: string;
    limit: number;
    sessionId?: string;
  },
): Promise<InteractiveSessionRow[]> {
  let query = database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("status", "=", "stopping")
    .where((expression) =>
      expression.or([
        expression("adapter", "is", null),
        expression("adapter", "!=", options.adapterName),
      ]),
    )
    .where("runtime", "!=", githubActionsRuntime)
    .where("credential_cleanup_terminal_status", "is", null)
    .where(sql<boolean>`lease_id IS NULL OR lease_id NOT LIKE ${`${options.sandboxLeasePrefix}%`}`)
    .orderBy("updated_at", "asc")
    .limit(options.limit);
  if (options.sessionId) query = query.where("id", "=", options.sessionId);
  return query.execute();
}

export async function requeueTerminalArchiveObjectBackfill(
  env: RuntimeEnv,
  sessionId: string | undefined,
  limit: number,
): Promise<void> {
  if (!env.SESSION_LOGS) return;
  const sessionFilter = sessionId ? sql`AND session.id = ${sessionId}` : sql``;
  await sql`
    UPDATE interactive_sessions
    SET terminal_finalize_pending = 1,
        last_reconciled_at = NULL
    WHERE id IN (
      SELECT session.id
      FROM interactive_sessions AS session
      JOIN interactive_session_log_archives AS archive
        ON archive.session_id = session.id
      WHERE session.status IN ('stopped', 'expired', 'failed')
        AND session.terminal_finalize_pending = 0
        AND (
          archive.events_key IS NULL
          OR archive.transcript_key IS NULL
          OR archive.summary_key IS NULL
        )
        ${sessionFilter}
      ORDER BY session.updated_at ASC, session.id ASC
      LIMIT ${sessionId ? 1 : limit * 2}
    )
  `.execute(database(env));
}

export async function readInteractiveSessionReconciliationCandidates(
  env: RuntimeEnv,
  adapterName: string,
  providerConfigured: boolean,
  limit: number,
): Promise<InteractiveSessionRow[]> {
  return database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where((expression) =>
      providerConfigured
        ? expression.or([
            expression.and([
              expression("status", "in", terminalReconciliationStatuses),
              expression("terminal_finalize_pending", "=", 1),
            ]),
            expression.and([
              expression("adapter", "=", adapterName),
              expression("status", "in", activeReconciliationStatuses),
            ]),
          ])
        : expression.and([
            expression("status", "in", terminalReconciliationStatuses),
            expression("terminal_finalize_pending", "=", 1),
          ]),
    )
    .orderBy("last_reconciled_at", "asc")
    .limit(limit * 2)
    .execute();
}

export async function readInteractiveSessionReconciliationRow(
  env: RuntimeEnv,
  sessionId: string,
): Promise<InteractiveSessionRow | undefined> {
  return database(env)
    .selectFrom("interactive_sessions")
    .selectAll()
    .where("id", "=", sessionId)
    .executeTakeFirst();
}
