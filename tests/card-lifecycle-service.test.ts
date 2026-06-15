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
