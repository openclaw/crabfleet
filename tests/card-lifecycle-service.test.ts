import assert from "node:assert/strict";
import test from "node:test";

import {
  CardLifecycleService,
  type CardLifecycleServiceDependencies,
  type CardLifecycleStore,
} from "../src/worker/card-lifecycle-service.ts";
import type { Card, RunAttempt } from "../src/worker/card-model.ts";
import type { User } from "../src/worker/models.ts";
import { containerCapabilities, crabboxCapabilities } from "../src/worker/session-model.ts";

const user: User = {
  subject: "github:1",
  login: "operator",
  email: null,
  name: "Operator",
  role: "maintainer",
  allowed: true,
  teams: [],
};

function run(values: Partial<RunAttempt> = {}): RunAttempt {
  return {
    id: "CY-101-R1",
    cardId: "CY-101",
    attempt: 1,
    runtime: "container",
    status: "running",
    controlIntent: null,
    leaseId: null,
    attachUrl: null,
    vncUrl: null,
    ptyAvailable: false,
    selectionReason: "default container runtime",
    capabilities: containerCapabilities,
    operator: null,
    lastHeartbeatAt: 90,
    startedAt: 80,
    endedAt: null,
    createdAt: 80,
    updatedAt: 90,
    error: null,
    ...values,
  };
}

function card(values: Partial<Card> = {}): Card {
  return {
    id: "CY-101",
    title: "Fix issue",
    prompt: "Fix issue",
    repo: "openclaw/crabfleet",
    source: "Prompt",
    runtime: "auto",
    policy: "open_pr",
    lane: "Todo",
    owner: "operator",
    startedAt: null,
    createdAt: 10,
    schedule: null,
    nextRunAt: null,
    lastScheduledRunAt: null,
    logs: [],
    changes: { files: [], patch: "", totals: { additions: 0, deletions: 0, files: 0 } },
    run: null,
    ...values,
  };
}

function store(calls: string[], readCard: () => Card | null): CardLifecycleStore {
  return {
    async readCards() {
      calls.push("cards:list");
      return [];
    },
    async readCard(cardId) {
      calls.push(`card:read:${cardId}`);
      return readCard();
    },
    async readRunsForCard(cardId) {
      calls.push(`runs:${cardId}`);
      return [];
    },
    async nextCardId() {
      calls.push("card:next-id");
      return "CY-101";
    },
    async insertCard(input) {
      calls.push(`card:insert:${input.id}:${input.policy}:${input.actor}`);
    },
    async nextRunAttempt(cardId) {
      calls.push(`run:next:${cardId}`);
      return 1;
    },
    async readDueRecurringCards(now, staleBefore, limit) {
      calls.push(`recurring:read:${now}:${staleBefore}:${limit}`);
      return [];
    },
    async claimRecurringOccurrence(cardId, dueAt, claimedAt, staleBefore) {
      calls.push(`recurring:claim:${cardId}:${dueAt}:${claimedAt}:${staleBefore}`);
      return true;
    },
    async completeRecurringOccurrence(cardId, dueAt, claimedAt, nextRunAt) {
      calls.push(`recurring:complete:${cardId}:${dueAt}:${claimedAt}:${nextRunAt}`);
      return true;
    },
    async disableRecurringSchedule(cardId, dueAt, claimedAt) {
      calls.push(`recurring:disable:${cardId}:${dueAt}:${claimedAt}`);
      return true;
    },
    async claimRun(input) {
      calls.push(
        `run:claim:${input.runId}:${input.cap}:${input.descriptor.runtime}:${input.descriptor.reason}`,
      );
      return "claimed";
    },
    async heartbeatRun(runId, actorName, now, message) {
      calls.push(`run:heartbeat:${runId}:${actorName}:${now}:${message}`);
    },
    async moveCard(cardId, lane, startedAt, now) {
      calls.push(`card:move:${cardId}:${lane}:${startedAt}:${now}`);
    },
    async finishRunForLane(runId, lane, actorName, now) {
      calls.push(`run:finish:${runId}:${lane}:${actorName}:${now}`);
    },
    async appendEvent(cardId, actorName, message, now) {
      calls.push(`event:${cardId}:${actorName}:${message}:${now}`);
    },
    async takeover(runId, actorName, now) {
      calls.push(`run:takeover:${runId}:${actorName}:${now}`);
    },
    async stall(current, actorName, now, reason) {
      calls.push(`run:stall:${current.id}:${actorName}:${now}:${reason}`);
    },
    async reconcileStalledRuns(now, threshold, actorName) {
      calls.push(`runs:reconcile:${now}:${threshold}:${actorName}`);
    },
  };
}

function dependencies(
  calls: string[],
  current: () => Card | null,
): CardLifecycleServiceDependencies {
  return {
    store: store(calls, current),
    now: () => 100,
    async requireRepo(repo) {
      calls.push(`repo:${repo}`);
    },
    async readSettings() {
      calls.push("settings");
      return { cap: "2", stall_ms: "60000" };
    },
    async ensureWorkflow(repo, now) {
      calls.push(`workflow:${repo}:${now}`);
      return { status: "ok", config: { runtime: "container", policy: "merge_when_green" } };
    },
    isConstraintError: () => false,
  };
}

test("card creation retries a constraint collision and preserves workflow defaults", async () => {
  const calls: string[] = [];
  const ids = ["CY-101", "CY-102"];
  const created = card({ id: "CY-102", policy: "merge_when_green" });
  const serviceDependencies = dependencies(calls, () => created);
  serviceDependencies.store.nextCardId = async () => {
    const id = ids.shift()!;
    calls.push(`card:next-id:${id}`);
    return id;
  };
  let inserts = 0;
  serviceDependencies.store.insertCard = async (input) => {
    calls.push(`card:insert:${input.id}:${input.policy}:${input.title}`);
    if (inserts++ === 0) throw new Error("UNIQUE constraint failed");
  };
  serviceDependencies.isConstraintError = (error) =>
    error instanceof Error && error.message.includes("UNIQUE");

  const result = await new CardLifecycleService(serviceDependencies).create(
    {
      prompt: "# Fix issue\nDetails",
      repo: "OpenClaw/Crabfleet",
      policy: "repo_default",
    },
    user,
  );

  assert.equal(result.card.id, "CY-102");
  assert.deepEqual(calls, [
    "repo:openclaw/crabfleet",
    "workflow:openclaw/crabfleet:100",
    "card:next-id:CY-101",
    "card:insert:CY-101:merge_when_green:Fix issue",
    "card:next-id:CY-102",
    "card:insert:CY-102:merge_when_green:Fix issue",
    "card:read:CY-102",
  ]);
});

test("capacity-blocked start records the exact reason without queue evidence", async () => {
  const calls: string[] = [];
  const current = card();
  let reads = 0;
  const serviceDependencies = dependencies(calls, () => {
    reads += 1;
    return current;
  });
  serviceDependencies.store.claimRun = async (input) => {
    calls.push(`run:claim:${input.runId}:${input.cap}`);
    return "capacity";
  };

  await new CardLifecycleService(serviceDependencies).mutate(user, current.id, "start");

  assert.deepEqual(calls, [
    "card:read:CY-101",
    "settings",
    "runs:reconcile:100:-59900:system",
    "card:read:CY-101",
    "repo:openclaw/crabfleet",
    "settings",
    "workflow:openclaw/crabfleet:100",
    "run:next:CY-101",
    "run:claim:CY-101-R1:2",
    "event:CY-101:operator:capacity blocked at cap 2:100",
    "card:read:CY-101",
  ]);
  assert.equal(reads, 3);
  assert.equal(
    calls.some((call) => call.includes("scheduler queued")),
    false,
  );
});

test("pulse on an active run only refreshes the heartbeat", async () => {
  const calls: string[] = [];
  const current = card({ lane: "Running", run: run() });

  await new CardLifecycleService(dependencies(calls, () => current)).mutate(
    user,
    current.id,
    "pulse",
  );

  assert.deepEqual(calls, [
    "card:read:CY-101",
    "run:heartbeat:CY-101-R1:operator:102:heartbeat ok",
    "card:read:CY-101",
  ]);
});

test("advance to Done finishes a review run and records the lane event", async () => {
  const calls: string[] = [];
  const current = card({ lane: "Human Review", run: run({ status: "review" }) });

  await new CardLifecycleService(dependencies(calls, () => current)).mutate(
    user,
    current.id,
    "advance",
  );

  assert.deepEqual(calls, [
    "card:read:CY-101",
    "card:move:CY-101:Done:null:100",
    "run:finish:CY-101-R1:Done:operator:101",
    "event:CY-101:operator:moved to Done:100",
    "card:read:CY-101",
  ]);
});

test("takeover and stall retain distinct run mutations", async () => {
  const takeoverCalls: string[] = [];
  const takeoverCard = card({
    lane: "Running",
    run: run({ runtime: "crabbox", capabilities: crabboxCapabilities }),
  });
  await new CardLifecycleService(dependencies(takeoverCalls, () => takeoverCard)).mutate(
    user,
    takeoverCard.id,
    "takeover",
  );
  assert.deepEqual(takeoverCalls, [
    "card:read:CY-101",
    "run:takeover:CY-101-R1:operator:100",
    "event:CY-101:operator:operator takeover granted:100",
    "card:read:CY-101",
  ]);

  const stallCalls: string[] = [];
  await new CardLifecycleService(dependencies(stallCalls, () => takeoverCard)).mutate(
    user,
    takeoverCard.id,
    "stall",
  );
  assert.deepEqual(stallCalls, [
    "card:read:CY-101",
    "run:stall:CY-101:operator:100:operator marked stalled",
    "card:read:CY-101",
  ]);
});

test("card creation persists a validated recurring schedule", async () => {
  const calls: string[] = [];
  const created = card({
    schedule: { kind: "interval", everyMs: 60_000 },
    nextRunAt: 60_100,
  });
  const serviceDependencies = dependencies(calls, () => created);
  let inserted: Parameters<CardLifecycleStore["insertCard"]>[0] | undefined;
  serviceDependencies.store.insertCard = async (input) => {
    inserted = input;
  };

  await new CardLifecycleService(serviceDependencies).create(
    {
      prompt: "Recurring maintenance",
      repo: "openclaw/crabfleet",
      schedule: { kind: "interval", everyMs: 60_000 },
    },
    user,
  );

  assert.deepEqual(inserted?.schedule, { kind: "interval", everyMs: 60_000 });
  assert.equal(inserted?.nextRunAt, 60_100);
  assert.equal(inserted?.lastScheduledRunAt, null);
});

test("recurring scheduler claims and advances one due occurrence", async () => {
  const calls: string[] = [];
  const current = card({
    schedule: { kind: "interval", everyMs: 60_000 },
    nextRunAt: 100,
  });
  const serviceDependencies = dependencies(calls, () => current);
  serviceDependencies.store.readDueRecurringCards = async () => [
    {
      id: current.id,
      scheduleJson: '{"kind":"interval","everyMs":60000}',
      dueAt: 100,
    },
  ];

  const result = await new CardLifecycleService(serviceDependencies).runRecurringScheduler(100);

  assert.deepEqual(result, {
    status: "ok",
    now: 100,
    scanned: 1,
    claimed: 1,
    queued: 1,
    skipped: 0,
    invalid: 0,
  });
  assert.ok(calls.includes("recurring:claim:CY-101:100:100:-299900"));
  assert.ok(calls.includes("recurring:complete:CY-101:100:100:60100"));
  assert.ok(calls.includes("run:claim:CY-101-R1:2:container:repo CRABBOX.md runtime default"));
  assert.ok(calls.some((call) => call.includes("recurring schedule queued")));
});

test("recurring scheduler coalesces an occurrence while a run is active", async () => {
  const calls: string[] = [];
  const current = card({
    lane: "Running",
    run: run(),
    schedule: { kind: "interval", everyMs: 60_000 },
    nextRunAt: 100,
  });
  const serviceDependencies = dependencies(calls, () => current);
  serviceDependencies.store.readDueRecurringCards = async () => [
    {
      id: current.id,
      scheduleJson: '{"kind":"interval","everyMs":60000}',
      dueAt: 100,
    },
  ];

  const result = await new CardLifecycleService(serviceDependencies).runRecurringScheduler(100);

  assert.equal(result.skipped, 1);
  assert.equal(result.queued, 0);
  assert.ok(calls.includes("recurring:complete:CY-101:100:100:60100"));
  assert.equal(
    calls.some((call) => call.startsWith("run:heartbeat:")),
    false,
  );
  assert.ok(calls.some((call) => call.includes("recurring occurrence skipped (active)")));
});

test("recurring scheduler disables invalid stored schedules once", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls, () => card());
  serviceDependencies.store.readDueRecurringCards = async () => [
    { id: "CY-101", scheduleJson: "{broken", dueAt: 100 },
  ];

  const result = await new CardLifecycleService(serviceDependencies).runRecurringScheduler(100);

  assert.equal(result.invalid, 1);
  assert.ok(calls.includes("recurring:disable:CY-101:100:100"));
  assert.ok(calls.some((call) => call.includes("recurring schedule invalid; disabled")));
});

test("recurring scheduler ignores an occurrence claimed by another tick", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls, () => card());
  serviceDependencies.store.readDueRecurringCards = async () => [
    {
      id: "CY-101",
      scheduleJson: '{"kind":"interval","everyMs":60000}',
      dueAt: 100,
    },
  ];
  serviceDependencies.store.claimRecurringOccurrence = async () => false;

  const result = await new CardLifecycleService(serviceDependencies).runRecurringScheduler(100);

  assert.equal(result.scanned, 1);
  assert.equal(result.claimed, 0);
  assert.equal(
    calls.some((call) => call.startsWith("card:read:")),
    false,
  );
});

test("recurring scheduler isolates dispatch failures from later cards", async () => {
  const calls: string[] = [];
  const blocked = card({ id: "CY-101", repo: "openclaw/disabled" });
  const ready = card({ id: "CY-102", repo: "openclaw/crabfleet" });
  const serviceDependencies = dependencies(calls, () => null);
  serviceDependencies.store.readDueRecurringCards = async () => [
    {
      id: blocked.id,
      scheduleJson: '{"kind":"interval","everyMs":60000}',
      dueAt: 100,
    },
    {
      id: ready.id,
      scheduleJson: '{"kind":"interval","everyMs":60000}',
      dueAt: 100,
    },
  ];
  serviceDependencies.store.readCard = async (cardId) => {
    calls.push(`card:read:${cardId}`);
    return cardId === blocked.id ? blocked : ready;
  };
  serviceDependencies.requireRepo = async (repo) => {
    calls.push(`repo:${repo}`);
    if (repo === blocked.repo) throw new Error("repo disabled");
  };

  const result = await new CardLifecycleService(serviceDependencies).runRecurringScheduler(100);

  assert.deepEqual(result, {
    status: "ok",
    now: 100,
    scanned: 2,
    claimed: 2,
    queued: 1,
    skipped: 1,
    invalid: 0,
  });
  assert.ok(calls.includes("recurring:complete:CY-101:100:100:60100"));
  assert.ok(calls.includes("recurring:complete:CY-102:100:100:60100"));
  assert.ok(calls.some((call) => call.includes("recurring occurrence skipped (dispatch failed)")));
  assert.ok(calls.some((call) => call.startsWith("run:claim:CY-102-R1:")));
});
