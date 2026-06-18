import { sql, type Kysely } from "kysely";

import {
  activeRunStatuses,
  type Card,
  type CardChanges,
  type ChangedFile,
  type DueRecurringCard,
  type RunAttempt,
} from "./card-model.ts";
import { parseStoredCardSchedule } from "./card-schedule.ts";
import type { CardLifecycleStore, CardRunClaimInput } from "./card-lifecycle-service.ts";
import {
  database,
  executeBatch,
  type CompilableQuery,
  type Database,
  type RunAttemptTable,
} from "./database.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest } from "./http.ts";
import type { RunStatus } from "./models.ts";
import { runtimeCapabilities } from "./session-model.ts";

export class CardRepository implements CardLifecycleStore {
  private readonly env: RuntimeEnv;

  constructor(env: RuntimeEnv) {
    this.env = env;
  }

  async readCards(): Promise<Card[]> {
    const db = database(this.env);
    const cards = await db
      .selectFrom("cards")
      .select([
        "id",
        "title",
        "prompt",
        "repo",
        "source",
        "runtime",
        "policy",
        "lane",
        "owner",
        "started_at",
        "created_at",
        "changed_files",
        "active_run_id",
        "schedule_json",
        "next_run_at",
        "last_scheduled_run_at",
      ])
      .orderBy("updated_at", "desc")
      .orderBy("created_at", "desc")
      .execute();
    if (!cards.length) return [];
    const runs = await this.readActiveRuns();
    const eventRows = (
      await sql<{ card_id: string; message: string; created_at: number }>`
        SELECT card_id, message, created_at
        FROM (
          SELECT card_id, message, created_at, id,
            row_number() OVER (PARTITION BY card_id ORDER BY created_at DESC, id DESC) AS rank
          FROM events
          WHERE card_id IN (SELECT id FROM cards)
        )
        WHERE rank <= 80
        ORDER BY card_id ASC, created_at ASC, id ASC
      `.execute(db)
    ).rows;
    const logs = new Map<string, string[]>();
    for (const row of eventRows) {
      const line = `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`;
      logs.set(row.card_id, [...(logs.get(row.card_id) ?? []), line]);
    }
    return cards.map((card) => ({
      id: card.id,
      title: card.title,
      prompt: card.prompt,
      repo: card.repo,
      source: card.source,
      runtime: card.runtime,
      policy: card.policy,
      lane: card.lane,
      owner: card.owner,
      startedAt: card.started_at,
      createdAt: card.created_at,
      schedule: storedCardSchedule(card.schedule_json),
      nextRunAt: card.next_run_at,
      lastScheduledRunAt: card.last_scheduled_run_at,
      logs: logs.get(card.id) ?? [],
      changes: cardChanges(card.changed_files, ""),
      run: card.active_run_id ? (runs.get(card.active_run_id) ?? null) : null,
    }));
  }

  async readCard(cardId: string): Promise<Card | null> {
    const db = database(this.env);
    const card = await db
      .selectFrom("cards")
      .select([
        "id",
        "title",
        "prompt",
        "repo",
        "source",
        "runtime",
        "policy",
        "lane",
        "owner",
        "started_at",
        "created_at",
        "changed_files",
        "diff_patch",
        "active_run_id",
        "schedule_json",
        "next_run_at",
        "last_scheduled_run_at",
      ])
      .where("id", "=", cardId)
      .executeTakeFirst();
    if (!card) return null;
    const runs = await this.readRunsByIds(card.active_run_id ? [card.active_run_id] : []);
    const eventRows = (
      await sql<{ message: string; created_at: number }>`
        SELECT message, created_at
        FROM (
          SELECT message, created_at, id
          FROM events
          WHERE card_id = ${card.id}
          ORDER BY created_at DESC, id DESC
          LIMIT 80
        )
        ORDER BY created_at ASC, id ASC
      `.execute(db)
    ).rows;
    return {
      id: card.id,
      title: card.title,
      prompt: card.prompt,
      repo: card.repo,
      source: card.source,
      runtime: card.runtime,
      policy: card.policy,
      lane: card.lane,
      owner: card.owner,
      startedAt: card.started_at,
      createdAt: card.created_at,
      schedule: storedCardSchedule(card.schedule_json),
      nextRunAt: card.next_run_at,
      lastScheduledRunAt: card.last_scheduled_run_at,
      logs: eventRows.map(
        (row) => `${new Date(row.created_at).toLocaleTimeString("en-GB")} ${row.message}`,
      ),
      changes: cardChanges(card.changed_files, card.diff_patch),
      run: card.active_run_id ? (runs.get(card.active_run_id) ?? null) : null,
    };
  }

  async readRunsForCard(cardId: string): Promise<RunAttempt[]> {
    const rows = await database(this.env)
      .selectFrom("run_attempts")
      .selectAll()
      .where("card_id", "=", cardId)
      .orderBy("attempt", "desc")
      .execute();
    return rows.map(runAttempt);
  }

  async nextCardId(): Promise<string> {
    const row = await database(this.env)
      .selectFrom("cards")
      .select(sql<number | null>`max(CAST(substr(id, 4) AS INTEGER))`.as("max_id"))
      .where("id", "like", "CY-%")
      .executeTakeFirst();
    return `CY-${String((row?.max_id ?? 100) + 1)}`;
  }

  async insertCard(
    input: Omit<Card, "logs" | "changes" | "run"> & { actor: string; updatedAt: number },
  ): Promise<void> {
    const db = database(this.env);
    await db
      .insertInto("cards")
      .values({
        id: input.id,
        title: input.title,
        prompt: input.prompt,
        repo: input.repo,
        source: input.source,
        runtime: input.runtime,
        policy: input.policy,
        lane: input.lane,
        owner: input.owner,
        started_at: input.startedAt,
        created_at: input.createdAt,
        updated_at: input.updatedAt,
        last_event: "card created",
        changed_files: "[]",
        diff_patch: "",
        active_run_id: null,
        schedule_json: input.schedule ? JSON.stringify(input.schedule) : "",
        next_run_at: input.nextRunAt,
        last_scheduled_run_at: input.lastScheduledRunAt,
        schedule_claimed_at: null,
      })
      .execute();
    await db
      .insertInto("events")
      .values([
        {
          card_id: input.id,
          actor: input.actor,
          message: "card created",
          created_at: input.createdAt,
        },
        {
          card_id: input.id,
          actor: input.actor,
          message: "repo allowlist ok",
          created_at: input.createdAt + 1,
        },
      ])
      .execute();
  }

  async nextRunAttempt(cardId: string): Promise<number> {
    const row = await database(this.env)
      .selectFrom("run_attempts")
      .select(sql<number | null>`max(attempt)`.as("max_attempt"))
      .where("card_id", "=", cardId)
      .executeTakeFirst();
    return (row?.max_attempt ?? 0) + 1;
  }

  async readDueRecurringCards(
    now: number,
    staleBefore: number,
    limit: number,
  ): Promise<DueRecurringCard[]> {
    const rows = await database(this.env)
      .selectFrom("cards")
      .select(["id", "schedule_json", "next_run_at"])
      .where("schedule_json", "!=", "")
      .where("next_run_at", "is not", null)
      .where("next_run_at", "<=", now)
      .where((expressions) =>
        expressions.or([
          expressions("schedule_claimed_at", "is", null),
          expressions("schedule_claimed_at", "<=", staleBefore),
        ]),
      )
      .orderBy("next_run_at", "asc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({
      id: row.id,
      scheduleJson: row.schedule_json,
      dueAt: row.next_run_at as number,
    }));
  }

  async claimRecurringOccurrence(
    cardId: string,
    dueAt: number,
    claimedAt: number,
    staleBefore: number,
  ): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("cards")
      .set({ schedule_claimed_at: claimedAt })
      .where("id", "=", cardId)
      .where("next_run_at", "=", dueAt)
      .where((expressions) =>
        expressions.or([
          expressions("schedule_claimed_at", "is", null),
          expressions("schedule_claimed_at", "<=", staleBefore),
        ]),
      )
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) === 1n;
  }

  async completeRecurringOccurrence(
    cardId: string,
    dueAt: number,
    claimedAt: number,
    nextRunAt: number,
  ): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("cards")
      .set({
        last_scheduled_run_at: dueAt,
        next_run_at: nextRunAt,
        schedule_claimed_at: null,
      })
      .where("id", "=", cardId)
      .where("next_run_at", "=", dueAt)
      .where("schedule_claimed_at", "=", claimedAt)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) === 1n;
  }

  async disableRecurringSchedule(
    cardId: string,
    dueAt: number,
    claimedAt: number,
  ): Promise<boolean> {
    const result = await database(this.env)
      .updateTable("cards")
      .set({ schedule_json: "", next_run_at: null, schedule_claimed_at: null })
      .where("id", "=", cardId)
      .where("next_run_at", "=", dueAt)
      .where("schedule_claimed_at", "=", claimedAt)
      .executeTakeFirst();
    return (result.numUpdatedRows ?? 0n) === 1n;
  }

  async claimRun(input: CardRunClaimInput): Promise<"claimed" | "capacity" | "active"> {
    const db = database(this.env);
    const transition = await sql`
      UPDATE cards
        SET lane = 'Running',
          active_run_id = ${input.runId},
          started_at = COALESCE(started_at, ${input.now}),
          updated_at = ${input.now},
          last_event = ${"run queued"}
        WHERE id = ${input.card.id}
          AND (active_run_id IS NULL OR active_run_id = '' OR active_run_id NOT IN (
            SELECT id FROM run_attempts WHERE status IN ('queued', 'leasing', 'running')
          ))
          AND (lane = 'Running' OR (
            SELECT count(*) FROM cards WHERE lane = 'Running' AND id <> ${input.card.id}
          ) < ${input.cap})
    `.execute(db);
    if ((transition.numAffectedRows ?? 0n) === 0n) {
      const activeCount = await db
        .selectFrom("cards")
        .select(sql<number>`count(*)`.as("count"))
        .where("lane", "=", "Running")
        .executeTakeFirst();
      return Number(activeCount?.count ?? 0) >= input.cap ? "capacity" : "active";
    }
    await db
      .insertInto("run_attempts")
      .values({
        id: input.runId,
        card_id: input.card.id,
        attempt: input.attempt,
        runtime: input.descriptor.runtime,
        status: "queued",
        control_intent: null,
        lease_id: null,
        attach_url: null,
        vnc_url: null,
        selection_reason: input.descriptor.reason,
        capabilities_json: JSON.stringify(input.descriptor.capabilities),
        operator: null,
        last_heartbeat_at: input.now,
        started_at: input.now,
        ended_at: null,
        created_at: input.now,
        updated_at: input.now,
        error: null,
      })
      .onConflict((conflict) => conflict.doNothing())
      .execute();
    return "claimed";
  }

  async heartbeatRun(
    runId: string,
    actorName: string,
    now: number,
    message: string,
  ): Promise<void> {
    const run = await database(this.env)
      .selectFrom("run_attempts")
      .select(["id", "card_id"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run) return;
    const db = database(this.env);
    await executeBatch(this.env, [
      db
        .updateTable("run_attempts")
        .set({ status: "running", last_heartbeat_at: now, updated_at: now })
        .where("id", "=", runId)
        .where("status", "in", activeRunStatuses),
      eventInsert(db, run.card_id, actorName, message, now),
      db
        .updateTable("cards")
        .set({ updated_at: now, last_event: message })
        .where("id", "=", run.card_id),
    ]);
  }

  async moveCard(
    cardId: string,
    lane: string,
    startedAt: number | null,
    now: number,
  ): Promise<void> {
    await database(this.env)
      .updateTable("cards")
      .set({
        lane,
        started_at: startedAt,
        updated_at: now,
        last_event: `moved to ${lane}`,
      })
      .where("id", "=", cardId)
      .execute();
  }

  async finishRunForLane(
    runId: string,
    lane: string,
    actorName: string,
    now: number,
  ): Promise<void> {
    const status: RunStatus =
      lane === "Done" ? "completed" : lane === "Human Review" ? "review" : "canceled";
    const run = await database(this.env)
      .selectFrom("run_attempts")
      .select(["id", "card_id"])
      .where("id", "=", runId)
      .executeTakeFirst();
    if (!run) return;
    const db = database(this.env);
    await executeBatch(this.env, [
      db
        .updateTable("run_attempts")
        .set({
          status,
          ended_at: now,
          updated_at: now,
          control_intent: status === "canceled" ? "cancel" : null,
        })
        .where("id", "=", runId),
      eventInsert(db, run.card_id, actorName, `run ${status}`, now),
    ]);
  }

  async appendEvent(
    cardId: string,
    actorName: string,
    message: string,
    now: number,
  ): Promise<void> {
    const db = database(this.env);
    await executeBatch(this.env, [
      eventInsert(db, cardId, actorName, message, now),
      db
        .updateTable("cards")
        .set({ updated_at: now, last_event: message })
        .where("id", "=", cardId),
    ]);
  }

  async takeover(runId: string, actorName: string, now: number): Promise<void> {
    await database(this.env)
      .updateTable("run_attempts")
      .set({ operator: actorName, control_intent: "takeover", updated_at: now })
      .where("id", "=", runId)
      .execute();
  }

  async stall(card: Card, actorName: string, now: number, reason: string): Promise<void> {
    if (!card.run) throw badRequest("no active run to mark stalled");
    const db = database(this.env);
    const runUpdate = await db
      .updateTable("run_attempts")
      .set({
        status: "stalled",
        ended_at: now,
        updated_at: now,
        error: reason,
      })
      .where("id", "=", card.run.id)
      .where("card_id", "=", card.id)
      .where("status", "in", activeRunStatuses)
      .executeTakeFirst();
    if ((runUpdate.numUpdatedRows ?? 0n) === 0n) throw badRequest("run is no longer active");
    await executeBatch(this.env, [
      db
        .updateTable("cards")
        .set({
          lane: "Human Review",
          updated_at: now,
          last_event: "stalled; workspace preserved",
        })
        .where("id", "=", card.id)
        .where("active_run_id", "=", card.run.id),
      eventInsert(db, card.id, actorName, reason, now),
    ]);
  }

  async reconcileStalledRuns(now: number, threshold: number, actorName: string): Promise<void> {
    const staleRuns = await database(this.env)
      .selectFrom("run_attempts")
      .select(["id", "card_id"])
      .where("status", "in", activeRunStatuses)
      .where("last_heartbeat_at", "<", threshold)
      .limit(25)
      .execute();
    if (!staleRuns.length) return;

    const db = database(this.env);
    for (const run of staleRuns) {
      const runUpdate = await db
        .updateTable("run_attempts")
        .set({
          status: "stalled",
          ended_at: now,
          updated_at: now,
          error: "heartbeat timeout",
        })
        .where("id", "=", run.id)
        .where("status", "in", activeRunStatuses)
        .where("last_heartbeat_at", "<", threshold)
        .executeTakeFirst();
      if ((runUpdate.numUpdatedRows ?? 0n) === 0n) continue;
      await executeBatch(this.env, [
        db
          .updateTable("cards")
          .set({
            lane: "Human Review",
            updated_at: now,
            last_event: "stalled; heartbeat timeout",
          })
          .where("id", "=", run.card_id)
          .where("active_run_id", "=", run.id),
        eventInsert(db, run.card_id, actorName, "stalled; heartbeat timeout", now),
      ]);
    }
  }

  private async readRunsByIds(ids: string[]): Promise<Map<string, RunAttempt>> {
    const uniqueIds = [...new Set(ids)].filter(Boolean);
    if (!uniqueIds.length) return new Map();
    const rows = await database(this.env)
      .selectFrom("run_attempts")
      .selectAll()
      .where("id", "in", uniqueIds)
      .execute();
    return new Map(rows.map((row) => [row.id, runAttempt(row)]));
  }

  private async readActiveRuns(): Promise<Map<string, RunAttempt>> {
    const rows = (
      await sql<RunAttemptTable>`
        SELECT run_attempts.*
        FROM run_attempts
        INNER JOIN cards ON cards.active_run_id = run_attempts.id
      `.execute(database(this.env))
    ).rows;
    return new Map(rows.map((row) => [row.id, runAttempt(row)]));
  }
}

function eventInsert(
  db: Kysely<Database>,
  cardId: string,
  actorName: string,
  message: string,
  now: number,
): CompilableQuery {
  return db
    .insertInto("events")
    .values({ card_id: cardId, actor: actorName, message, created_at: now });
}

function runAttempt(row: RunAttemptTable): RunAttempt {
  const capabilities = runtimeCapabilities(row.runtime, row.capabilities_json);
  return {
    id: row.id,
    cardId: row.card_id,
    attempt: row.attempt,
    runtime: row.runtime,
    status: row.status,
    controlIntent: row.control_intent,
    leaseId: row.lease_id,
    attachUrl: capabilities.terminal ? row.attach_url : null,
    vncUrl: row.vnc_url,
    ptyAvailable: false,
    selectionReason: row.selection_reason,
    capabilities,
    operator: row.operator,
    lastHeartbeatAt: row.last_heartbeat_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    error: row.error,
  };
}

function cardChanges(filesJson: string, patch: string): CardChanges {
  const files = parseJson<ChangedFile[]>(filesJson, []).filter(isChangedFile);
  return {
    files,
    patch,
    totals: {
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      files: files.length,
    },
  };
}

function isChangedFile(value: unknown): value is ChangedFile {
  if (!value || typeof value !== "object") return false;
  const file = value as Partial<ChangedFile>;
  return (
    typeof file.path === "string" &&
    ["added", "deleted", "modified", "renamed"].includes(String(file.status)) &&
    typeof file.additions === "number" &&
    typeof file.deletions === "number"
  );
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function storedCardSchedule(value: string) {
  try {
    return parseStoredCardSchedule(value);
  } catch {
    return null;
  }
}
