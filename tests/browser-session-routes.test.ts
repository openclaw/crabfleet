import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  handleBrowserSessionRoute,
  type BrowserSessionRouteDependencies,
} from "../src/worker/routes/browser-sessions.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const viewer: User = {
  subject: "github:1",
  login: "viewer",
  email: null,
  name: "Viewer",
  role: "viewer",
  allowed: true,
  teams: [],
};

const maintainer: User = {
  ...viewer,
  subject: "github:2",
  login: "maintainer",
  name: "Maintainer",
  role: "maintainer",
};

function response(name: string): Response {
  return new Response(name, { headers: { "x-handler": name } });
}

function dependencies(calls: string[]): BrowserSessionRouteDependencies {
  return {
    async createSession(_request, user) {
      calls.push(`create:${user.login}`);
      return { handler: "create" };
    },
    async cleanupSessions(_request, user) {
      calls.push(`cleanup:${user.login}`);
      return { handler: "cleanup" };
    },
    async readFreshSession(user, sessionId) {
      calls.push(`read:${user.login}:${sessionId}`);
      return interactiveSession(sessionRow({ id: sessionId }), []);
    },
    presentSession(session, user) {
      calls.push(`present:${session.id}:${user.login}`);
      return { ...session, owner: user.login };
    },
    async readLogs(user, sessionId) {
      calls.push(`logs:${user.login}:${sessionId}`);
      return { handler: "logs" };
    },
    async readTranscript(user, sessionId) {
      calls.push(`transcript:${user.login}:${sessionId}`);
      return response("transcript");
    },
    async updateSummary(user, sessionId) {
      calls.push(`summary:${user.login}:${sessionId}`);
      return { handler: "summary" };
    },
    async mutateSession(_request, user, sessionId, action) {
      calls.push(`mutate:${user.login}:${sessionId}:${action}`);
      return { handler: "mutate" };
    },
    async listCheckpoints(user, sessionId) {
      calls.push(`checkpoints:list:${user.login}:${sessionId}`);
      return { handler: "checkpoints:list" };
    },
    async createCheckpoint(user, sessionId) {
      calls.push(`checkpoints:create:${user.login}:${sessionId}`);
      return { handler: "checkpoints:create" };
    },
    async restoreCheckpoint(user, sessionId, checkpointId) {
      calls.push(`checkpoints:restore:${user.login}:${sessionId}:${checkpointId}`);
      return { handler: "checkpoints:restore" };
    },
    async readDiagnostics(user, sessionId) {
      calls.push(`diagnostics:${user.login}:${sessionId}`);
      return { handler: "diagnostics" };
    },
    async openVnc(user, sessionId) {
      calls.push(`vnc:${user.login}:${sessionId}`);
      return response("vnc");
    },
    async uploadClipboard(_request, user, sessionId) {
      calls.push(`clipboard:${user.login}:${sessionId}`);
      return { handler: "clipboard" };
    },
    async listGrants(user, sessionId) {
      calls.push(`grants:list:${user.login}:${sessionId}`);
      return { handler: "grants:list" };
    },
    async grantAccess(user, sessionId, input) {
      calls.push(`grants:create:${user.login}:${sessionId}:${input.principal}:${input.role}`);
      return { handler: "grants:create" };
    },
    async revokeAccess(user, sessionId, subject) {
      calls.push(`grants:revoke:${user.login}:${sessionId}:${subject}`);
      return { handler: "grants:revoke" };
    },
  };
}

function request(method: string, path: string, body?: Record<string, unknown>): Request {
  return new Request(`https://fleet.example${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function dispatch(
  value: Request,
  user: User,
  calls: string[],
  overrides?: Partial<BrowserSessionRouteDependencies>,
): Promise<Response | null> {
  return handleBrowserSessionRoute(value, new URL(value.url), user, {
    ...dependencies(calls),
    ...overrides,
  });
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("browser session collection routes enforce create and cleanup roles", async () => {
  const createCalls: string[] = [];
  assert.equal(
    (await dispatch(request("POST", "/api/interactive-sessions", {}), maintainer, createCalls))
      ?.status,
    201,
  );
  assert.deepEqual(createCalls, ["create:maintainer"]);

  await assert.rejects(
    dispatch(request("POST", "/api/interactive-sessions", {}), viewer, []),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );

  const cleanupCalls: string[] = [];
  assert.equal(
    (await dispatch(request("POST", "/api/interactive-sessions/cleanup", {}), viewer, cleanupCalls))
      ?.status,
    200,
  );
  assert.deepEqual(cleanupCalls, ["cleanup:viewer"]);
});

test("browser session routes dispatch all JSON resources with decoded identities", async () => {
  const cases: Array<[Request, number, string[]]> = [
    [
      request("GET", "/api/interactive-sessions/IS%2F2"),
      200,
      ["read:viewer:IS/2", "present:IS/2:viewer"],
    ],
    [request("GET", "/api/interactive-sessions/IS%2F2/logs"), 200, ["logs:viewer:IS/2"]],
    [request("POST", "/api/interactive-sessions/IS%2F2/summary", {}), 200, ["summary:viewer:IS/2"]],
    [
      request("POST", "/api/interactive-sessions/IS%2F2/actions", { action: "stop" }),
      200,
      ["mutate:viewer:IS/2:stop"],
    ],
    [
      request("GET", "/api/interactive-sessions/IS%2F2/checkpoints"),
      200,
      ["checkpoints:list:viewer:IS/2"],
    ],
    [
      request("POST", "/api/interactive-sessions/IS%2F2/checkpoints", {}),
      201,
      ["checkpoints:create:viewer:IS/2"],
    ],
    [
      request("POST", "/api/interactive-sessions/IS%2F2/checkpoints/checkpoint%2F1/restore", {}),
      200,
      ["checkpoints:restore:viewer:IS/2:checkpoint/1"],
    ],
    [
      request("GET", "/api/interactive-sessions/IS%2F2/diagnostics"),
      200,
      ["diagnostics:viewer:IS/2"],
    ],
    [
      request("POST", "/api/interactive-sessions/IS%2F2/clipboard", {}),
      201,
      ["clipboard:viewer:IS/2"],
    ],
    [request("GET", "/api/interactive-sessions/IS%2F2/grants"), 200, ["grants:list:viewer:IS/2"]],
    [
      request("POST", "/api/interactive-sessions/IS%2F2/grants", {
        principal: "collaborator@example.test",
        role: "viewer",
      }),
      201,
      ["grants:create:viewer:IS/2:collaborator@example.test:viewer"],
    ],
    [
      request(
        "DELETE",
        "/api/interactive-sessions/IS%2F2/grants/proxy%3Acollaborator%40example.test",
      ),
      200,
      ["grants:revoke:viewer:IS/2:proxy:collaborator@example.test"],
    ],
  ];

  for (const [value, expectedStatus, expectedCalls] of cases) {
    const calls: string[] = [];
    assert.equal((await dispatch(value, viewer, calls))?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
  }
});

test("browser session routes preserve raw transcript and VNC responses", async () => {
  for (const [resource, handler] of [
    ["transcript", "transcript"],
    ["vnc", "vnc"],
  ] as const) {
    const calls: string[] = [];
    const result = await dispatch(
      request("GET", `/api/interactive-sessions/IS%2F2/${resource}`),
      viewer,
      calls,
    );
    assert.equal(result?.headers.get("x-handler"), handler);
    assert.deepEqual(calls, [`${resource}:viewer:IS/2`]);
  }
});

test("browser session resources report missing sessions and exact fallthrough", async () => {
  const missingCalls: string[] = [];
  await assert.rejects(
    dispatch(request("GET", "/api/interactive-sessions/IS-404"), viewer, missingCalls, {
      readFreshSession: async (user, sessionId) => {
        missingCalls.push(`read:${user.login}:${sessionId}`);
        return null;
      },
    }),
    (error) => {
      assert.equal(status(error), 404);
      return true;
    },
  );
  assert.deepEqual(missingCalls, ["read:viewer:IS-404"]);

  const calls: string[] = [];
  for (const value of [
    request("GET", "/api/interactive-sessions"),
    request("DELETE", "/api/interactive-sessions/IS-2"),
    request("GET", "/api/interactive-sessions/IS-2/unknown"),
    request("GET", "/api/interactive-sessions/IS-2/"),
  ]) {
    assert.equal(await dispatch(value, viewer, calls), null);
  }
  assert.deepEqual(calls, []);
});
