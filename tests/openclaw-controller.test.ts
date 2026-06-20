import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenClawController,
  type OpenClawControllerStore,
} from "../src/worker/openclaw-controller.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function session(
  id: string,
  values: Parameters<typeof sessionRow>[0] = {},
  logs: string[] = [],
): InteractiveSession {
  return interactiveSession(sessionRow({ id, ...values }), logs);
}

function rootSession(id = "IS-1"): InteractiveSession {
  return session(id, {
    root_session_id: id,
    created_by: "service:openclaw",
  });
}

function controllerStore(
  overrides: Partial<OpenClawControllerStore> = {},
): OpenClawControllerStore {
  const root = rootSession();
  return {
    createCrabbox: async () => session("IS-created"),
    readRoomRoot: async () => root,
    readRoomSessions: async () => ({ sessions: [root], overflow: false }),
    stopSessionRoot: async (_request, rootSessionId) => ({
      rootSessionId,
      sessions: [root],
    }),
    requireRootScopedSession: async (sessionId) => session(sessionId),
    readTranscriptEvents: async (sessionId) => [
      {
        id: 1,
        session_id: sessionId,
        actor: "openclaw",
        message: "continued",
        created_at: 10,
      },
    ],
    countTranscriptEvents: async () => 1,
    sendMessage: async () => undefined,
    stopSession: async (_request, current) => ({ ...current, status: "stopped" }),
    registerActionSession: async () => ({
      session: session("IS-action", { runtime: "github_actions" }),
      agentToken: "agent-token",
      resumed: false,
      workKey: "work-1",
    }),
    now: () => 1_800_000_000_000,
    createEmbedTicket: async (sessionId, expiresAt) => `ticket:${sessionId}:${expiresAt}`,
    decorateSession: (value) => ({ ...value, summary: `decorated:${value.summary}` }),
    browserUrl: (sessionId) => `https://fleet.example/sessions/${sessionId}`,
    browserEmbedUrl: (sessionId, token) =>
      `https://fleet.example/app/sessions/${sessionId}?token=${encodeURIComponent(token)}`,
    runnerPtyUrl: (sessionId, token) => `wss://fleet.example/actions/${sessionId}?token=${token}`,
    ...overrides,
  };
}

test("OpenClaw controller presents creation and action registration results", async () => {
  const created = session("IS-created", {}, ["full log"]);
  const controller = new OpenClawController(
    controllerStore({
      createCrabbox: async (input) => {
        assert.equal(input.owner, "maintainer");
        return created;
      },
    }),
  );

  const createResponse = await controller.createCrabbox({ owner: "maintainer" });
  assert.equal(createResponse.session, created);
  assert.deepEqual(createResponse.session.logs, ["full log"]);
  assert.equal(createResponse.browserUrl, "https://fleet.example/sessions/IS-created");

  const registration = await controller.registerActionSession({
    workKey: "work-1",
    workKind: "review",
    repo: "openclaw/crabfleet",
  });
  assert.equal(registration.session.summary, "decorated:Working");
  assert.equal(registration.agentToken, "agent-token");
  assert.equal(
    registration.runnerPtyUrl,
    "wss://fleet.example/actions/IS-action?token=agent-token",
  );
  assert.equal(registration.browserUrl, "https://fleet.example/sessions/IS-action");
});

test("OpenClaw controller validates room roots and builds bounded transcript responses", async () => {
  const root = rootSession();
  const child = session(
    "IS-2",
    {
      parent_session_id: root.id,
      root_session_id: root.id,
      created_by: `session:${root.id}`,
    },
    ["sensitive log"],
  );
  const calls: string[] = [];
  const controller = new OpenClawController(
    controllerStore({
      readRoomRoot: async (rootSessionId) => {
        calls.push(`root:${rootSessionId}`);
        return root;
      },
      readRoomSessions: async (rootSessionId) => {
        calls.push(`room:${rootSessionId}`);
        return { sessions: [root, child], overflow: false };
      },
      requireRootScopedSession: async (sessionId, rootSessionId) => {
        calls.push(`scope:${sessionId}:${rootSessionId}`);
        return child;
      },
    }),
  );

  const room = await controller.readSessionRoot(" IS-1 ");
  assert.deepEqual(
    room.crabboxes.map((crabbox) => crabbox.session.id),
    ["IS-1", "IS-2"],
  );
  assert.ok(room.crabboxes.every((crabbox) => crabbox.session.logs.length === 0));

  const transcript = await controller.readCrabboxTranscript("IS-2", "IS-1");
  assert.equal(transcript.session.id, "IS-2");
  assert.deepEqual(transcript.session.logs, []);
  assert.match(transcript.transcript, /continued/);
  assert.equal(transcript.eventCount, 1);
  assert.equal(transcript.truncated, false);
  assert.deepEqual(calls, ["root:IS-1", "room:IS-1", "scope:IS-2:IS-1"]);
});

test("OpenClaw controller fences mutations by root before delivery or stop", async () => {
  const calls: string[] = [];
  const child = session("IS-2", {
    parent_session_id: "IS-1",
    root_session_id: "IS-1",
    created_by: "session:IS-1",
  });
  const controller = new OpenClawController(
    controllerStore({
      requireRootScopedSession: async (sessionId, rootSessionId) => {
        calls.push(`scope:${sessionId}:${rootSessionId}`);
        return child;
      },
      sendMessage: async (_request, value, input) => {
        calls.push(`message:${value.id}:${String(input.message)}`);
      },
      stopSession: async (_request, current) => {
        calls.push(`stop:${current.id}`);
        return { ...child, status: "stopped" };
      },
      stopSessionRoot: async (_request, rootSessionId) => {
        calls.push(`stop-root:${rootSessionId}`);
        return { rootSessionId, sessions: [child] };
      },
    }),
  );
  const request = new Request("https://fleet.example/api/openclaw/crabboxes/IS-2/message");

  const message = await controller.messageCrabbox(request, "IS-2", "IS-1", {
    message: "continue",
  });
  assert.equal(message.delivered, true);

  const stopped = await controller.stopCrabbox(request, "IS-2", "IS-1");
  assert.equal(stopped.session.status, "stopped");

  const stoppedRoot = await controller.stopSessionRoot(request, "IS-1");
  assert.equal(stoppedRoot.admissionClosed, true);
  assert.deepEqual(calls, [
    "scope:IS-2:IS-1",
    "message:IS-2:continue",
    "scope:IS-2:IS-1",
    "stop:IS-2",
    "stop-root:IS-1",
  ]);
});

test("OpenClaw controller issues bounded terminal tickets only for active root-scoped sessions", async () => {
  const calls: string[] = [];
  const controller = new OpenClawController(
    controllerStore({
      requireRootScopedSession: async (sessionId, rootSessionId) => {
        calls.push(`scope:${sessionId}:${rootSessionId}`);
        return session(sessionId, { status: "ready" });
      },
      createEmbedTicket: async (sessionId, expiresAt) => {
        calls.push(`ticket:${sessionId}:${expiresAt}`);
        return "signed ticket";
      },
    }),
  );

  assert.deepEqual(await controller.createCrabboxEmbedTicket("IS-2", "IS-1", { ttlSeconds: 30 }), {
    browserUrl: "https://fleet.example/app/sessions/IS-2?token=signed%20ticket",
    expiresAt: 1_800_000_060_000,
  });
  assert.deepEqual(calls, ["scope:IS-2:IS-1", "ticket:IS-2:1800000060000"]);

  await assert.rejects(
    controller.createCrabboxEmbedTicket("IS-2", "IS-1", { ttlSeconds: Number.NaN }),
    /ttlSeconds must be a finite number/,
  );
  const stopped = new OpenClawController(
    controllerStore({
      requireRootScopedSession: async () => session("IS-2", { status: "stopped" }),
    }),
  );
  await assert.rejects(stopped.createCrabboxEmbedTicket("IS-2", "IS-1", {}), /session is stopped/);
  const withoutTerminal = new OpenClawController(
    controllerStore({
      requireRootScopedSession: async () =>
        session("IS-2", {
          capabilities_json: JSON.stringify({ terminal: false }),
        }),
    }),
  );
  await assert.rejects(
    withoutTerminal.createCrabboxEmbedTicket("IS-2", "IS-1", {}),
    /session does not advertise terminal access/,
  );
});
