import assert from "node:assert/strict";
import test from "node:test";

import {
  OpenClawController,
  type OpenClawControllerStore,
} from "../src/worker/openclaw-controller.ts";
import { handleOpenClawRoute } from "../src/worker/routes/openclaw.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

function routeController(calls: string[]): OpenClawController {
  const root = interactiveSession(
    sessionRow({
      id: "IS-1",
      root_session_id: "IS-1",
      created_by: "service:openclaw",
    }),
    [],
  );
  const child = interactiveSession(
    sessionRow({
      id: "IS/2",
      parent_session_id: "IS-1",
      root_session_id: "IS-1",
      created_by: "session:IS-1",
    }),
    [],
  );
  const store: OpenClawControllerStore = {
    createCrabbox: async (input) => {
      calls.push(`create:${String(input.owner)}`);
      return child;
    },
    readRoomRoot: async (rootSessionId) => {
      calls.push(`read-root:${rootSessionId}`);
      return root;
    },
    readRoomSessions: async (rootSessionId) => {
      calls.push(`read-room:${rootSessionId}`);
      return { sessions: [root], overflow: false };
    },
    stopSessionRoot: async (_request, rootSessionId) => {
      calls.push(`stop-root:${rootSessionId}`);
      return { rootSessionId, sessions: [root] };
    },
    requireRootScopedSession: async (sessionId, rootSessionId) => {
      calls.push(`scope:${sessionId}:${rootSessionId}`);
      return { ...child, id: sessionId, rootSessionId };
    },
    readTranscriptEvents: async (sessionId) => {
      calls.push(`events:${sessionId}`);
      return [];
    },
    countTranscriptEvents: async (sessionId) => {
      calls.push(`event-count:${sessionId}`);
      return 0;
    },
    sendMessage: async (_request, session, input) => {
      calls.push(`message:${session.id}:${String(input.message)}`);
    },
    stopSession: async (_request, session) => {
      calls.push(`stop:${session.id}`);
      return { ...session, status: "stopped" };
    },
    registerActionSession: async (input) => {
      calls.push(`register:${String(input.workKey)}`);
      return {
        session: child,
        agentToken: "agent-token",
        resumed: false,
        workKey: String(input.workKey),
      };
    },
    now: () => 1_800_000_000_000,
    createEmbedTicket: async (sessionId, expiresAt) => {
      calls.push(`ticket:${sessionId}:${expiresAt}`);
      return "embed-token";
    },
    decorateSession: (session) => session,
    browserUrl: (sessionId) => `https://fleet.example/sessions/${sessionId}`,
    browserEmbedUrl: (sessionId, token) =>
      `https://fleet.example/app/sessions/${sessionId}?token=${token}`,
    runnerPtyUrl: (sessionId) => `wss://fleet.example/actions/${sessionId}`,
  };
  return new OpenClawController(store);
}

function request(
  method: string,
  path: string,
  token: string,
  body?: Record<string, unknown>,
  headers: HeadersInit = {},
): Request {
  return new Request(`https://fleet.example${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function dispatch(
  value: Request,
  calls: string[],
  tokens: {
    automationTokens?: Array<string | null | undefined>;
    roomTokens?: Array<string | null | undefined>;
  } = {},
): Promise<Response | null> {
  return handleOpenClawRoute(value, new URL(value.url), {
    controller: routeController(calls),
    automationTokens: tokens.automationTokens ?? ["automation"],
    roomTokens: tokens.roomTokens ?? ["room", "multicodex"],
  });
}

test("OpenClaw routes dispatch every exact service endpoint", async () => {
  const cases: Array<{
    request: Request;
    expectedStatus: number;
    expectedCalls: string[];
  }> = [
    {
      request: request("POST", "/api/openclaw/action-sessions", "automation", {
        workKey: "work-1",
      }),
      expectedStatus: 201,
      expectedCalls: ["register:work-1"],
    },
    {
      request: request("POST", "/api/openclaw/crabboxes", "multicodex", {
        owner: "maintainer",
      }),
      expectedStatus: 201,
      expectedCalls: ["create:maintainer"],
    },
    {
      request: request("GET", "/api/openclaw/session-roots/IS-1", "room"),
      expectedStatus: 200,
      expectedCalls: ["read-root:IS-1", "read-room:IS-1"],
    },
    {
      request: request("POST", "/api/openclaw/session-roots/IS-1/actions", "room", {
        action: "stop",
      }),
      expectedStatus: 200,
      expectedCalls: ["stop-root:IS-1"],
    },
    {
      request: request("GET", "/api/openclaw/crabboxes/IS%2F2/transcript", "room", undefined, {
        "x-crabfleet-root-session-id": "IS-1",
      }),
      expectedStatus: 200,
      expectedCalls: ["scope:IS/2:IS-1", "events:IS/2", "event-count:IS/2"],
    },
    {
      request: request("POST", "/api/openclaw/crabboxes/IS%2F2/message", "room", {
        rootSessionId: "IS-1",
        message: "continue",
      }),
      expectedStatus: 200,
      expectedCalls: ["scope:IS/2:IS-1", "message:IS/2:continue"],
    },
    {
      request: request("POST", "/api/openclaw/crabboxes/IS%2F2/actions", "room", {
        rootSessionId: "IS-1",
        action: "stop",
      }),
      expectedStatus: 200,
      expectedCalls: ["scope:IS/2:IS-1", "stop:IS/2"],
    },
    {
      request: request("POST", "/api/openclaw/crabboxes/IS%2F2/embed-ticket", "room", {
        rootSessionId: "IS-1",
        ttlSeconds: 90,
      }),
      expectedStatus: 201,
      expectedCalls: ["scope:IS/2:IS-1", "ticket:IS/2:1800000090000"],
    },
    {
      request: request("GET", "/api/openclaw/crabboxes/IS%2F2", "room", undefined, {
        "x-crabfleet-root-session-id": "IS-1",
      }),
      expectedStatus: 200,
      expectedCalls: ["scope:IS/2:IS-1"],
    },
  ];

  for (const example of cases) {
    const calls: string[] = [];
    const response = await dispatch(example.request, calls);
    assert.equal(response?.status, example.expectedStatus);
    assert.deepEqual(calls, example.expectedCalls);
  }
});

test("OpenClaw routes preserve token scopes and reject invalid commands before mutation", async () => {
  await assert.rejects(
    dispatch(request("POST", "/api/openclaw/action-sessions", "room", { workKey: "work-1" }), []),
    (error) => {
      assert.equal(status(error), 401);
      return true;
    },
  );
  await assert.rejects(
    dispatch(request("GET", "/api/openclaw/crabboxes/IS-2", "room"), []),
    (error) => {
      assert.equal(status(error), 400);
      assert.equal((error as Error).message, "root session id is required");
      return true;
    },
  );

  const invalidActionCalls: string[] = [];
  await assert.rejects(
    dispatch(
      request("POST", "/api/openclaw/crabboxes/IS-2/actions", "room", {
        rootSessionId: "IS-1",
        action: "restart",
      }),
      invalidActionCalls,
    ),
    (error) => {
      assert.equal(status(error), 400);
      assert.equal((error as Error).message, "only stop is supported");
      return true;
    },
  );
  assert.deepEqual(invalidActionCalls, []);

  await assert.rejects(
    dispatch(request("POST", "/api/openclaw/crabboxes", "room", { owner: "x" }), [], {
      roomTokens: [],
    }),
    (error) => {
      assert.equal(status(error), 503);
      return true;
    },
  );
});

test("OpenClaw routes fall through on inexact paths and methods", async () => {
  const calls: string[] = [];
  const requests = [
    request("GET", "/api/openclaw/action-sessions", "automation"),
    request("GET", "/api/openclaw/crabboxes", "room"),
    request("DELETE", "/api/openclaw/crabboxes/IS-2", "room"),
    request("GET", "/api/openclaw/crabboxes/IS-2/unknown", "room"),
    request("GET", "/api/openclaw/session-roots/IS-1/actions", "room"),
  ];

  for (const value of requests) {
    assert.equal(await dispatch(value, calls), null);
  }
  assert.deepEqual(calls, []);
});
