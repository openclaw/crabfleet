import { actor } from "./auth.ts";
import {
  activeRunStatuses,
  cardLanes,
  cardRuntimeOptions,
  mergePolicyOptions,
  type Card,
  type DueRecurringCard,
  type RecurringSchedulerTickResult,
  type RunAttempt,
  type WorkflowConfig,
} from "./card-model.ts";
import {
  cardScheduleSummary,
  initialRecurringRunAt,
  nextRecurringRunAt,
  normalizeCardSchedule,
  parseStoredCardSchedule,
} from "./card-schedule.ts";
import { badRequest, notFound } from "./http.ts";
import type { User } from "./models.ts";
import { normalizeRepo } from "./repositories.ts";
import { containerCapabilities, crabboxCapabilities } from "./session-model.ts";

export type CardCreateInput = {
  title?: unknown;
  prompt?: unknown;
  repo?: unknown;
  source?: unknown;
  runtime?: unknown;
  policy?: unknown;
  schedule?: unknown;
};

export type CardRuntimeDescriptor = {
  runtime: "container" | "crabbox";
  reason: string;
  capabilities: typeof containerCapabilities;
};

export type CardWorkflow = {
  status: string;
  config: WorkflowConfig;
};

export type CardRunClaimInput = {
  card: Card;
  runId: string;
  attempt: number;
  cap: number;
  descriptor: CardRuntimeDescriptor;
  now: number;
};

export type CardLifecycleStore = {
  readCards(): Promise<Card[]>;
  readCard(cardId: string): Promise<Card | null>;
  readRunsForCard(cardId: string): Promise<RunAttempt[]>;
  nextCardId(): Promise<string>;
  insertCard(
    input: Omit<Card, "logs" | "changes" | "run"> & { actor: string; updatedAt: number },
  ): Promise<void>;
  nextRunAttempt(cardId: string): Promise<number>;
  readDueRecurringCards(
    now: number,
    staleBefore: number,
    limit: number,
  ): Promise<DueRecurringCard[]>;
  claimRecurringOccurrence(
    cardId: string,
    dueAt: number,
    claimedAt: number,
    staleBefore: number,
  ): Promise<boolean>;
  completeRecurringOccurrence(
    cardId: string,
    dueAt: number,
    claimedAt: number,
    nextRunAt: number,
  ): Promise<boolean>;
  disableRecurringSchedule(cardId: string, dueAt: number, claimedAt: number): Promise<boolean>;
  claimRun(input: CardRunClaimInput): Promise<"claimed" | "capacity" | "active">;
  heartbeatRun(runId: string, actorName: string, now: number, message: string): Promise<void>;
  moveCard(cardId: string, lane: string, startedAt: number | null, now: number): Promise<void>;
  finishRunForLane(runId: string, lane: string, actorName: string, now: number): Promise<void>;
  appendEvent(cardId: string, actorName: string, message: string, now: number): Promise<void>;
  takeover(runId: string, actorName: string, now: number): Promise<void>;
  stall(card: Card, actorName: string, now: number, reason: string): Promise<void>;
  reconcileStalledRuns(now: number, threshold: number, actorName: string): Promise<void>;
};

export type CardLifecycleServiceDependencies = {
  store: CardLifecycleStore;
  now(): number;
  requireRepo(repo: string): Promise<void>;
  readSettings(): Promise<Record<string, string>>;
  ensureWorkflow(repo: string, now: number): Promise<CardWorkflow | null>;
  isConstraintError(error: unknown): boolean;
};

const recurringSchedulerBatchSize = 25;
const recurringSchedulerClaimLeaseMs = 5 * 60_000;

export class CardLifecycleService {
  private readonly dependencies: CardLifecycleServiceDependencies;

  constructor(dependencies: CardLifecycleServiceDependencies) {
    this.dependencies = dependencies;
  }

  list(): Promise<Card[]> {
    return this.dependencies.store.readCards();
  }

  async runs(cardId: string): Promise<RunAttempt[] | null> {
    return (await this.dependencies.store.readCard(cardId))
      ? this.dependencies.store.readRunsForCard(cardId)
      : null;
  }

  async create(input: CardCreateInput, user: User): Promise<{ card: Card }> {
    const prompt = clean(input.prompt, 4000);
    const title = clean(input.title, 140) || titleFromPrompt(prompt);
    const repo = normalizeRepo(input.repo);
    if (!prompt || !repo) throw badRequest("prompt and repo are required");
    await this.dependencies.requireRepo(repo);

    const now = this.dependencies.now();
    const workflow = await this.dependencies.ensureWorkflow(repo, now);
    const workflowConfig = workflow?.status === "ok" ? workflow.config : undefined;
    const source = oneOf(input.source, ["Prompt", "Issue", "PR"], "Prompt");
    const runtime = oneOf(input.runtime, cardRuntimeOptions, "auto");
    const policy = resolveCardPolicy(input.policy, workflowConfig);
    const schedule = createCardSchedule(input.schedule);
    const owner = user.login ?? user.email ?? user.subject;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const id = await this.dependencies.store.nextCardId();
      try {
        await this.dependencies.store.insertCard({
          id,
          title,
          prompt,
          repo,
          source,
          runtime,
          policy,
          lane: "Todo",
          owner,
          startedAt: null,
          createdAt: now,
          schedule,
          nextRunAt: schedule ? initialRecurringRunAt(schedule, now) : null,
          lastScheduledRunAt: null,
          updatedAt: now,
          actor: actor(user),
        });
        return { card: (await this.dependencies.store.readCard(id)) as Card };
      } catch (error) {
        if (!this.dependencies.isConstraintError(error) || attempt === 2) throw error;
      }
    }
    throw new Error("failed to allocate card id");
  }

  async mutate(user: User, cardId: string, action: string): Promise<{ card: Card }> {
    const card = await this.dependencies.store.readCard(cardId);
    if (!card) throw notFound("card not found");
    const now = this.dependencies.now();
    const actorName = actor(user);

    if (action === "start" || action === "pulse") {
      const wasRunning = card.lane === "Running";
      if (!wasRunning) {
        if ((await this.claimRunning(user, card, now)) !== "claimed") return this.result(cardId);
      } else if (card.run && activeRunStatuses.includes(card.run.status)) {
        await this.dependencies.store.heartbeatRun(card.run.id, actorName, now + 2, "heartbeat ok");
        return this.result(cardId);
      } else if ((await this.claimRunning(user, card, now)) !== "claimed") {
        return this.result(cardId);
      }
      await this.dependencies.store.appendEvent(card.id, actorName, "heartbeat ok", now + 3);
      return this.result(cardId);
    }

    if (action === "advance") {
      const nextLane =
        cardLanes[
          (cardLanes.indexOf(card.lane as (typeof cardLanes)[number]) + 1) % cardLanes.length
        ] ?? "Todo";
      if (nextLane === "Running") {
        await this.claimRunning(user, card, now);
        return this.result(cardId);
      }
      await this.dependencies.store.moveCard(card.id, nextLane, card.startedAt, now);
      if (
        card.run &&
        (activeRunStatuses.includes(card.run.status) ||
          (card.run.status === "review" && nextLane === "Done"))
      ) {
        await this.dependencies.store.finishRunForLane(card.run.id, nextLane, actorName, now + 1);
      }
      await this.dependencies.store.appendEvent(card.id, actorName, `moved to ${nextLane}`, now);
      return this.result(cardId);
    }

    if (action === "attach") return this.result(cardId);
    if (action === "watch") {
      await this.dependencies.store.appendEvent(card.id, actorName, "watch attached", now);
      return this.result(cardId);
    }
    if (action === "takeover") {
      if (!card.run || !activeRunStatuses.includes(card.run.status)) {
        throw badRequest("no active run to take over");
      }
      if (!card.run.capabilities.takeover) throw badRequest("runtime does not support takeover");
      await this.dependencies.store.takeover(card.run.id, actorName, now);
      await this.dependencies.store.appendEvent(
        card.id,
        actorName,
        "operator takeover granted",
        now,
      );
      return this.result(cardId);
    }
    if (action === "stall") {
      if (!card.run || !activeRunStatuses.includes(card.run.status)) {
        throw badRequest("no active run to mark stalled");
      }
      await this.dependencies.store.stall(card, actorName, now, "operator marked stalled");
      return this.result(cardId);
    }
    throw badRequest("unknown action");
  }

  async reconcileStalledRuns(now = this.dependencies.now()): Promise<void> {
    const threshold = now - stallThresholdMs(await this.dependencies.readSettings());
    await this.dependencies.store.reconcileStalledRuns(now, threshold, actor(systemUser()));
  }

  async runRecurringScheduler(
    now = this.dependencies.now(),
  ): Promise<RecurringSchedulerTickResult> {
    await this.reconcileStalledRuns(now);
    const staleBefore = now - recurringSchedulerClaimLeaseMs;
    const dueCards = await this.dependencies.store.readDueRecurringCards(
      now,
      staleBefore,
      recurringSchedulerBatchSize,
    );
    const result: RecurringSchedulerTickResult = {
      status: "ok",
      now,
      scanned: dueCards.length,
      claimed: 0,
      queued: 0,
      skipped: 0,
      invalid: 0,
    };
    const system = systemUser();
    const actorName = actor(system);

    for (const due of dueCards) {
      let schedule;
      let nextRunAt: number | null = null;
      try {
        schedule = parseStoredCardSchedule(due.scheduleJson);
        nextRunAt = schedule ? nextRecurringRunAt(schedule, due.dueAt, now) : null;
      } catch {
        schedule = null;
      }
      const claimed = await this.dependencies.store.claimRecurringOccurrence(
        due.id,
        due.dueAt,
        now,
        staleBefore,
      );
      if (!claimed) continue;
      result.claimed += 1;

      if (!schedule || nextRunAt === null) {
        if (await this.dependencies.store.disableRecurringSchedule(due.id, due.dueAt, now)) {
          result.invalid += 1;
          await this.dependencies.store.appendEvent(
            due.id,
            actorName,
            "recurring schedule invalid; disabled pending maintainer review",
            now,
          );
        }
        continue;
      }

      const card = await this.dependencies.store.readCard(due.id);
      let runResult: "claimed" | "capacity" | "active" | "failed" = "active";
      try {
        if (card) {
          runResult = await this.claimRunning(system, card, now, {
            pulseExisting: false,
            reconcileStalled: false,
          });
        }
      } catch {
        // A repo can be disabled after card creation. Advance this occurrence so it
        // cannot poison every scheduler batch until a maintainer fixes the card.
        runResult = "failed";
      }
      const completed = await this.dependencies.store.completeRecurringOccurrence(
        due.id,
        due.dueAt,
        now,
        nextRunAt,
      );
      if (!completed) continue;

      if (runResult === "claimed") {
        result.queued += 1;
        await this.dependencies.store.appendEvent(
          due.id,
          actorName,
          `recurring schedule queued (${cardScheduleSummary(schedule)}); next ${new Date(nextRunAt).toISOString()}`,
          now + 4,
        );
      } else {
        result.skipped += 1;
        await this.dependencies.store.appendEvent(
          due.id,
          actorName,
          `recurring occurrence skipped (${runResult === "failed" ? "dispatch failed" : runResult}); next ${new Date(nextRunAt).toISOString()}`,
          now + 4,
        );
      }
    }

    return result;
  }

  private async claimRunning(
    user: User,
    card: Card,
    now: number,
    options: { pulseExisting?: boolean; reconcileStalled?: boolean } = {},
  ): Promise<"claimed" | "capacity" | "active"> {
    if (options.reconcileStalled !== false) await this.reconcileStalledRuns(now);
    const currentCard = (await this.dependencies.store.readCard(card.id)) ?? card;
    await this.dependencies.requireRepo(currentCard.repo);
    const settings = await this.dependencies.readSettings();
    const cap = numberSetting(settings.cap, 20);
    const existingRun =
      currentCard.run && activeRunStatuses.includes(currentCard.run.status)
        ? currentCard.run
        : null;
    if (existingRun) {
      if (options.pulseExisting !== false) {
        await this.dependencies.store.heartbeatRun(
          existingRun.id,
          actor(user),
          now,
          "heartbeat ok",
        );
      }
      return "active";
    }

    const workflow = await this.dependencies.ensureWorkflow(currentCard.repo, now);
    const workflowConfig = workflow?.status === "ok" ? workflow.config : undefined;
    const attempt = await this.dependencies.store.nextRunAttempt(currentCard.id);
    const runId = `${currentCard.id}-R${attempt}`;
    const descriptor = selectRuntimeDescriptor(currentCard, workflowConfig);
    const claimed = await this.dependencies.store.claimRun({
      card: currentCard,
      runId,
      attempt,
      cap,
      descriptor,
      now,
    });
    if (claimed !== "claimed") {
      const message =
        claimed === "capacity" ? `capacity blocked at cap ${cap}` : "run already active";
      await this.dependencies.store.appendEvent(currentCard.id, actor(user), message, now);
      return claimed;
    }
    await this.dependencies.store.appendEvent(
      currentCard.id,
      actor(user),
      `scheduler queued ${currentCard.repo}`,
      now + 1,
    );
    await this.dependencies.store.appendEvent(
      currentCard.id,
      actor(user),
      `runtime=${descriptor.runtime} policy=${currentCard.policy} workflow=${workflow?.status ?? "unseen"} reason=${descriptor.reason}`,
      now + 2,
    );
    return "claimed";
  }

  private async result(cardId: string): Promise<{ card: Card }> {
    return { card: (await this.dependencies.store.readCard(cardId)) as Card };
  }
}

export function resolveCardPolicy(value: unknown, workflow?: WorkflowConfig): string {
  const workflowPolicy = optionalOneOf(workflow?.policy, mergePolicyOptions);
  const fallback = workflowPolicy ?? "open_pr";
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "default" ||
    value === "repo_default"
  ) {
    return fallback;
  }
  const policy = optionalOneOf(value, mergePolicyOptions);
  if (!policy) throw badRequest("invalid merge policy");
  return policy;
}

export function selectRuntimeDescriptor(
  card: Pick<Card, "runtime" | "prompt">,
  workflow?: WorkflowConfig,
): CardRuntimeDescriptor {
  if (card.runtime === "crabbox") return runtimeDescriptor("crabbox", "card runtime override");
  if (card.runtime === "container") return runtimeDescriptor("container", "card runtime override");
  if (/\b(vnc|manual|takeover|gpu|perf|performance)\b/i.test(card.prompt)) {
    return runtimeDescriptor("crabbox", "prompt requires desktop/manual/perf capability");
  }
  if (workflow?.runtime === "crabbox") {
    return runtimeDescriptor("crabbox", "repo CRABBOX.md runtime default");
  }
  if (workflow?.runtime === "container") {
    return runtimeDescriptor("container", "repo CRABBOX.md runtime default");
  }
  return runtimeDescriptor("container", "default container runtime");
}

function runtimeDescriptor(
  runtime: CardRuntimeDescriptor["runtime"],
  reason: string,
): CardRuntimeDescriptor {
  return {
    runtime,
    reason,
    capabilities: runtime === "crabbox" ? crabboxCapabilities : containerCapabilities,
  };
}

function stallThresholdMs(settings: Record<string, string>): number {
  const parsed = Number(settings.stall_ms);
  return Number.isFinite(parsed) && parsed >= 60_000 ? parsed : 5 * 60 * 1000;
}

function createCardSchedule(input: unknown) {
  try {
    return normalizeCardSchedule(input);
  } catch (error) {
    throw badRequest(error instanceof Error ? error.message : "invalid schedule");
  }
}

function systemUser(): User {
  return {
    subject: "system:crabfleet",
    login: "system",
    email: null,
    name: "Crabfleet",
    role: "owner",
    allowed: true,
    teams: [],
  };
}

function titleFromPrompt(prompt: string): string {
  const line = prompt
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);
  return clean(line?.replace(/^#+\s*/, ""), 140) || "Untitled card";
}

function optionalOneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}

function numberSetting(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
