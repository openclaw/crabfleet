import assert from "node:assert/strict";
import test from "node:test";

import type { HttpError } from "../src/worker/http.ts";
import {
  InteractiveSessionAttachService,
  interactiveSessionAttachTransition,
  type InteractiveSessionAttachStore,
  type InteractiveSessionAttachTransition,
} from "../src/worker/session-attach.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function fixture(
  options: {
    session?: InteractiveSession;
    persisted?: boolean;
    archiveFailure?: boolean;
    reread?: InteractiveSession | null;
  } = {},
) {
  const session = options.session ?? interactiveSession(sessionRow({ id: "IS-8" }), []);
  const transitions: InteractiveSessionAttachTransition[] = [];
  const archives: string[] = [];
  const store: InteractiveSessionAttachStore = {
    persist: async (_session, actor, transition) => {
      assert.equal(actor, "operator");
      transitions.push(transition);
      return options.persisted ?? true;
    },
    archive: async (sessionId) => {
      archives.push(sessionId);
      if (options.archiveFailure) throw new Error("archive unavailable");
    },
    readSession: async () => (options.reread === undefined ? session : options.reread),
  };
  return {
    archives,
    service: new InteractiveSessionAttachService(store),
    session,
    transitions,
  };
}

function hasStatus(status: number): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as HttpError).status === status;
}

test("attach transitions ready and detached sessions to attached", () => {
  assert.deepEqual(
    interactiveSessionAttachTransition(
      interactiveSession(sessionRow({ status: "ready" }), []),
      100,
    ),
    {
      status: "attached",
      lastSeenAt: 100,
      message: "interactive terminal attached",
    },
  );
  assert.equal(
    interactiveSessionAttachTransition(
      interactiveSession(sessionRow({ status: "detached" }), []),
      100,
    ).status,
    "attached",
  );
});

test("attach preserves pending lifecycle states with descriptive evidence", () => {
  assert.equal(
    interactiveSessionAttachTransition(
      interactiveSession(sessionRow({ status: "pending_adapter" }), []),
      100,
    ).message,
    "attach requested; runtime adapter pending",
  );
  assert.equal(
    interactiveSessionAttachTransition(
      interactiveSession(sessionRow({ status: "provisioning" }), []),
      100,
    ).message,
    "attach requested; workspace provisioning",
  );
});

test("attach requires terminal capability and current control", async () => {
  const noTerminal = interactiveSession(
    sessionRow({
      capabilities_json: JSON.stringify({
        terminal: false,
        takeover: false,
        vnc: false,
        desktop: false,
        logs: true,
        artifacts: true,
      }),
    }),
    [],
  );
  await assert.rejects(
    () =>
      fixture({ session: noTerminal }).service.attach({
        session: noTerminal,
        actor: "operator",
        canControl: true,
        now: 100,
      }),
    hasStatus(400),
  );
  const context = fixture();
  await assert.rejects(
    () =>
      context.service.attach({
        session: context.session,
        actor: "operator",
        canControl: false,
        now: 100,
      }),
    hasStatus(403),
  );
});

test("attach rejects stopping and terminal sessions", async () => {
  for (const status of ["stopping", "stopped", "expired", "failed"] as const) {
    const session = interactiveSession(sessionRow({ status }), []);
    await assert.rejects(
      () =>
        fixture({ session }).service.attach({
          session,
          actor: "operator",
          canControl: true,
          now: 100,
        }),
      hasStatus(400),
    );
  }
});

test("attach persists one fenced transition and tolerates archive failure", async () => {
  const context = fixture({ archiveFailure: true });
  const result = await context.service.attach({
    session: context.session,
    actor: "operator",
    canControl: true,
    now: 100,
  });

  assert.equal(result, context.session);
  assert.deepEqual(context.transitions, [
    {
      status: "attached",
      lastSeenAt: 100,
      message: "interactive terminal attached",
    },
  ]);
  assert.deepEqual(context.archives, ["IS-8"]);
});

test("attach reports lost lifecycle ownership and missing rereads", async () => {
  const conflict = fixture({ persisted: false });
  await assert.rejects(
    () =>
      conflict.service.attach({
        session: conflict.session,
        actor: "operator",
        canControl: true,
        now: 100,
      }),
    hasStatus(409),
  );
  assert.deepEqual(conflict.archives, []);

  const missing = fixture({ reread: null });
  await assert.rejects(
    () =>
      missing.service.attach({
        session: missing.session,
        actor: "operator",
        canControl: true,
        now: 100,
      }),
    hasStatus(404),
  );
});
