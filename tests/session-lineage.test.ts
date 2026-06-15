import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  InteractiveSessionLineageService,
  type InteractiveSessionLineageStore,
} from "../src/worker/session-lineage.ts";
import type { InteractiveSession } from "../src/worker/session-model.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const user: User = {
  subject: "github:42",
  login: "maintainer",
  email: null,
  name: null,
  role: "maintainer",
  allowed: true,
  teams: [],
};

function session(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(sessionRow(values), []);
}

function lineageStore(
  overrides: Partial<InteractiveSessionLineageStore> = {},
): InteractiveSessionLineageStore {
  return {
    readSession: async () => null,
    canManage: () => true,
    ...overrides,
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("interactive lineage rejects caller-claimed roots without a parent", async () => {
  let reads = 0;
  const service = new InteractiveSessionLineageService(
    lineageStore({
      readSession: async () => {
        reads += 1;
        return null;
      },
    }),
  );

  assert.deepEqual(await service.resolve(user, null, null), {
    parentSessionId: null,
    rootSessionId: null,
  });
  await assert.rejects(service.resolve(user, null, "IS-1"), (error) => {
    assert.equal(status(error), 400);
    assert.equal((error as Error).message, "root session id requires a parent session id");
    return true;
  });
  assert.equal(reads, 0);
});

test("interactive lineage derives the canonical root from the visible parent", async () => {
  const parent = session({
    id: "IS-2",
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
  });
  const reads: string[] = [];
  const service = new InteractiveSessionLineageService(
    lineageStore({
      readSession: async (id) => {
        reads.push(id);
        return parent;
      },
    }),
  );

  assert.deepEqual(await service.resolve(user, " IS-2 ", "IS-attacker"), {
    parentSessionId: "IS-2",
    rootSessionId: "IS-1",
  });
  assert.deepEqual(reads, ["IS-2"]);
});

test("interactive lineage rejects missing or invisible parents", async () => {
  const service = new InteractiveSessionLineageService(lineageStore());
  await assert.rejects(service.resolve(user, "IS-missing", null), (error) => {
    assert.equal(status(error), 400);
    assert.equal((error as Error).message, "parent session not found");
    return true;
  });

  const hidden = new InteractiveSessionLineageService(
    lineageStore({
      readSession: async () => session({ id: "IS-2" }),
      canManage: () => false,
    }),
  );
  await assert.rejects(hidden.resolve(user, "IS-2", null), (error) => {
    assert.equal(status(error), 403);
    assert.equal((error as Error).message, "parent session is not visible");
    return true;
  });
});
