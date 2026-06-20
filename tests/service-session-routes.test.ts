import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  handleServiceSessionRoute,
  type ServiceSessionRouteDependencies,
} from "../src/worker/routes/service-sessions.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const sshUser: User = {
  subject: "github:1",
  login: "ssh-user",
  email: null,
  name: "SSH User",
  role: "viewer",
  allowed: true,
  teams: [],
};

const agentUser: User = {
  ...sshUser,
  subject: "session:IS-parent",
  login: "agent-user",
  name: "Agent User",
};

function response(name: string): Response {
  return new Response(name, { headers: { "x-handler": name } });
}

function dependencies(calls: string[]): ServiceSessionRouteDependencies {
  return {
    async sshAuth() {
      calls.push("ssh-auth");
      return { handler: "ssh-auth" };
    },
    async sshState() {
      calls.push("ssh-state");
      return { handler: "ssh-state" };
    },
    async agentState() {
      calls.push("agent-state");
      return { handler: "agent-state" };
    },
    async createSshSession() {
      calls.push("create:ssh");
      return { handler: "create:ssh" };
    },
    async createAgentSession() {
      calls.push("create:agent");
      return { handler: "create:agent" };
    },
    async updateAgentWorkState(_request: Request, sessionId: string) {
      calls.push(`work-state:${sessionId}`);
      return { handler: "work-state" };
    },
    async openAgentRunnerPty(_request: Request, sessionId: string) {
      calls.push(`runner-pty:${sessionId}`);
      return response("runner-pty");
    },
    async requireSshViewer() {
      calls.push("auth:ssh");
      return sshUser;
    },
    async requireAgentUser() {
      calls.push("auth:agent");
      return agentUser;
    },
    async readFreshSession(user: User, sessionId: string) {
      calls.push(`read:${user.login}:${sessionId}`);
      return interactiveSession(sessionRow({ id: sessionId }), []);
    },
    presentSession(session: ReturnType<typeof interactiveSession>, user: User) {
      calls.push(`present:${session.id}:${user.login}`);
      return { ...session, owner: user.login };
    },
    async mutateSession(_request: Request, user: User, sessionId: string, action: string) {
      calls.push(`mutate:${user.login}:${sessionId}:${action}`);
      return { handler: "mutate" };
    },
    async listCheckpoints(user: User, sessionId: string) {
      calls.push(`checkpoints:list:${user.login}:${sessionId}`);
      return { handler: "checkpoints:list" };
    },
    async createCheckpoint(user: User, sessionId: string) {
      calls.push(`checkpoints:create:${user.login}:${sessionId}`);
      return { handler: "checkpoints:create" };
    },
    async restoreCheckpoint(user: User, sessionId: string, checkpointId: string) {
      calls.push(`checkpoints:restore:${user.login}:${sessionId}:${checkpointId}`);
      return { handler: "checkpoints:restore" };
    },
    async readLogs(user: User, sessionId: string) {
      calls.push(`logs:${user.login}:${sessionId}`);
      return { handler: "logs" };
    },
    async readTranscript(user: User, sessionId: string) {
      calls.push(`transcript:${user.login}:${sessionId}`);
      return response("transcript");
    },
    async updateSummary(user: User, sessionId: string) {
      calls.push(`summary:${user.login}:${sessionId}`);
      return { handler: "summary" };
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

async function dispatch(value: Request, calls: string[]): Promise<Response | null> {
  return handleServiceSessionRoute(value, new URL(value.url), dependencies(calls));
}

test("service-session routes dispatch collection and agent-specialized endpoints", async () => {
  const cases: Array<[Request, number, string[]]> = [
    [request("POST", "/api/ssh/auth", {}), 200, ["ssh-auth"]],
    [request("GET", "/api/ssh/state"), 200, ["ssh-state"]],
    [request("GET", "/api/agent/state"), 200, ["agent-state"]],
    [request("POST", "/api/ssh/interactive-sessions", {}), 201, ["create:ssh"]],
    [request("POST", "/api/agent/interactive-sessions", {}), 201, ["create:agent"]],
    [
      request("POST", "/api/agent/interactive-sessions/IS%2F2/work-state", {}),
      200,
      ["work-state:IS/2"],
    ],
  ];

  for (const [value, expectedStatus, expectedCalls] of cases) {
    const calls: string[] = [];
    const result = await dispatch(value, calls);
    assert.equal(result?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
  }

  const runnerCalls: string[] = [];
  const runner = await dispatch(
    request("GET", "/api/agent/interactive-sessions/IS%2F2/runner-pty"),
    runnerCalls,
  );
  assert.equal(runner?.headers.get("x-handler"), "runner-pty");
  assert.deepEqual(runnerCalls, ["runner-pty:IS/2"]);
});

test("service-session routes share read, log, transcript, and summary behavior by principal", async () => {
  const cases: Array<[Request, string[]]> = [
    [
      request("GET", "/api/ssh/interactive-sessions/IS%2F2"),
      ["auth:ssh", "read:ssh-user:IS/2", "present:IS/2:ssh-user"],
    ],
    [
      request("GET", "/api/agent/interactive-sessions/IS%2F2"),
      ["auth:agent", "read:agent-user:IS/2", "present:IS/2:agent-user"],
    ],
    [
      request("GET", "/api/ssh/interactive-sessions/IS%2F2/logs"),
      ["auth:ssh", "logs:ssh-user:IS/2"],
    ],
    [
      request("GET", "/api/agent/interactive-sessions/IS%2F2/logs"),
      ["auth:agent", "logs:agent-user:IS/2"],
    ],
    [
      request("POST", "/api/ssh/interactive-sessions/IS%2F2/summary", {}),
      ["auth:ssh", "summary:ssh-user:IS/2"],
    ],
    [
      request("POST", "/api/agent/interactive-sessions/IS%2F2/summary", {}),
      ["auth:agent", "summary:agent-user:IS/2"],
    ],
  ];

  for (const [value, expectedCalls] of cases) {
    const calls: string[] = [];
    assert.equal((await dispatch(value, calls))?.status, 200);
    assert.deepEqual(calls, expectedCalls);
  }

  for (const principal of ["ssh", "agent"] as const) {
    const calls: string[] = [];
    const result = await dispatch(
      request("GET", `/api/${principal}/interactive-sessions/IS%2F2/transcript`),
      calls,
    );
    assert.equal(result?.headers.get("x-handler"), "transcript");
    assert.deepEqual(calls, [
      `auth:${principal}`,
      `transcript:${principal === "ssh" ? "ssh-user" : "agent-user"}:IS/2`,
    ]);
  }
});

test("service-session routes keep actions and checkpoints SSH-only", async () => {
  const cases: Array<[Request, number, string[]]> = [
    [
      request("POST", "/api/ssh/interactive-sessions/IS%2F2/actions", { action: "stop" }),
      200,
      ["auth:ssh", "mutate:ssh-user:IS/2:stop"],
    ],
    [
      request("GET", "/api/ssh/interactive-sessions/IS%2F2/checkpoints"),
      200,
      ["auth:ssh", "checkpoints:list:ssh-user:IS/2"],
    ],
    [
      request("POST", "/api/ssh/interactive-sessions/IS%2F2/checkpoints", {}),
      201,
      ["auth:ssh", "checkpoints:create:ssh-user:IS/2"],
    ],
    [
      request(
        "POST",
        "/api/ssh/interactive-sessions/IS%2F2/checkpoints/checkpoint%2F1/restore",
        {},
      ),
      200,
      ["auth:ssh", "checkpoints:restore:ssh-user:IS/2:checkpoint/1"],
    ],
  ];

  for (const [value, expectedStatus, expectedCalls] of cases) {
    const calls: string[] = [];
    assert.equal((await dispatch(value, calls))?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
  }

  const calls: string[] = [];
  assert.equal(
    await dispatch(
      request("POST", "/api/agent/interactive-sessions/IS-2/actions", { action: "stop" }),
      calls,
    ),
    null,
  );
  assert.deepEqual(calls, []);
});

test("service-session routes report missing reads and fall through on inexact resources", async () => {
  const missingCalls: string[] = [];
  const missingDependencies = dependencies(missingCalls);
  missingDependencies.readFreshSession = async (user: User, sessionId: string) => {
    missingCalls.push(`read:${user.login}:${sessionId}`);
    return null;
  };
  await assert.rejects(
    handleServiceSessionRoute(
      request("GET", "/api/ssh/interactive-sessions/IS-404"),
      new URL("https://fleet.example/api/ssh/interactive-sessions/IS-404"),
      missingDependencies,
    ),
    (error) => {
      assert.equal(
        typeof error === "object" && error !== null && "status" in error
          ? Number(error.status)
          : undefined,
        404,
      );
      return true;
    },
  );
  assert.deepEqual(missingCalls, ["auth:ssh", "read:ssh-user:IS-404"]);

  const calls: string[] = [];
  for (const value of [
    request("GET", "/api/ssh/auth"),
    request("POST", "/api/agent/state", {}),
    request("GET", "/api/agent/interactive-sessions/IS-2/actions"),
    request("GET", "/api/ssh/interactive-sessions/IS-2/unknown"),
  ]) {
    assert.equal(await dispatch(value, calls), null);
  }
  assert.deepEqual(calls, []);
});
