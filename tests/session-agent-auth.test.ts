import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/worker/crypto.ts";
import { userServiceSessionAuthority, userSessionOwnerSubject } from "../src/worker/models.ts";
import {
  AgentSessionAuthenticator,
  agentSessionId,
  agentSessionToken,
  terminalAgentEventGraceMs,
} from "../src/worker/session-agent-auth.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

function authenticator(
  values: Parameters<typeof sessionRow>[0] = {},
  now: () => number = () => 10_000,
): AgentSessionAuthenticator {
  const session = interactiveSession(
    sessionRow({
      id: "IS-agent",
      owner: "session-owner",
      agent_token_hash: "agent-token-hash",
      ...values,
    }),
    [],
  );
  return new AgentSessionAuthenticator(
    {
      readCredential: async (id) =>
        id === session.id ? { session, tokenHash: "agent-token-hash" } : null,
      hashToken: async (token) => (token === "agent-token" ? "agent-token-hash" : sha256(token)),
    },
    now,
  );
}

test("agent session credentials use the canonical Crabfleet protocol", () => {
  const request = new Request(
    "https://fleet.example/api/terminal/ws?sessionId=query-session&agentToken=query-token",
    {
      headers: {
        authorization: "Bearer bearer-token",
        "x-crabfleet-session-id": "header-session",
        "x-crabfleet-agent-token": "header-token",
        "x-crabbox-session-id": "legacy-session",
      },
    },
  );

  assert.equal(agentSessionId(request), "header-session");
  assert.equal(agentSessionToken(request, { allowQueryToken: true }), "bearer-token");
  assert.equal(
    agentSessionId(
      new Request("https://fleet.example/api/terminal/ws", {
        headers: { "x-crabbox-session-id": "legacy-session" },
      }),
    ),
    "",
  );
});

test("query agent tokens require an explicit endpoint exception", () => {
  const request = new Request(
    "https://fleet.example/api/agent/interactive-sessions/IS-agent/runner-pty?agentToken=query-token",
  );
  assert.equal(agentSessionToken(request), "");
  assert.equal(agentSessionToken(request, { allowQueryToken: true }), "query-token");
});

test("path-bound sessions can opt into query credentials without a session header", async () => {
  const request = new Request(
    "https://fleet.example/api/agent/interactive-sessions/IS-agent/runner-pty?agentToken=agent-token",
  );
  await assert.doesNotReject(() =>
    authenticator().require(request, "IS-agent", { allowQueryToken: true }),
  );
  await assert.rejects(() => authenticator().require(request, "IS-agent"), {
    message: "unauthorized",
  });
});

test("agent authentication binds request identity and token to one active session", async () => {
  const auth = authenticator();
  const request = new Request("https://fleet.example/api/agent/state", {
    headers: {
      authorization: "Bearer agent-token",
      "x-crabfleet-session-id": "IS-agent",
    },
  });

  const result = await auth.require(request);
  assert.equal(result.session.id, "IS-agent");
  assert.deepEqual(result.user, {
    [userServiceSessionAuthority]: "IS-agent",
    subject: "agent:IS-agent",
    login: "session-owner",
    email: null,
    name: "Codex IS-agent",
    role: "viewer",
    allowed: true,
    teams: [],
  });
  await assert.rejects(() => auth.require(request, "IS-other"), { message: "unauthorized" });
});

test("agent authentication retains only its exact session authority", async () => {
  const request = new Request("https://fleet.example/api/agent/state", {
    headers: {
      authorization: "Bearer agent-token",
      "x-crabfleet-session-id": "IS-agent",
    },
  });
  const result = await authenticator({ owner_subject: "github:42" }).require(request);

  assert.equal(result.user.subject, "agent:IS-agent");
  assert.equal(result.user[userServiceSessionAuthority], "IS-agent");
  assert.equal(result.user[userSessionOwnerSubject], undefined);
});

test("agent authentication rejects missing, invalid, and inactive credentials", async () => {
  const request = new Request("https://fleet.example/api/agent/state", {
    headers: {
      authorization: "Bearer agent-token",
      "x-crabfleet-session-id": "IS-agent",
    },
  });

  await assert.rejects(
    () =>
      authenticator().require(
        new Request("https://fleet.example/api/agent/state", {
          headers: { "x-crabfleet-session-id": "IS-agent" },
        }),
      ),
    { message: "unauthorized" },
  );
  await assert.rejects(
    () =>
      authenticator().require(
        new Request(request, {
          headers: {
            ...Object.fromEntries(request.headers),
            authorization: "Bearer wrong",
          },
        }),
      ),
    { message: "unauthorized" },
  );
  await assert.rejects(() => authenticator({ status: "stopping" }).require(request), {
    message: "agent session is not active",
  });
  await assert.rejects(() => authenticator({ status: "stopped" }).require(request), {
    message: "agent session is not active",
  });
});

test("terminal event authentication is limited to the stopped-at retry window", async () => {
  const request = new Request("https://fleet.example/api/agent/state", {
    headers: {
      authorization: "Bearer agent-token",
      "x-crabfleet-session-id": "IS-agent",
    },
  });
  const now = 1_000_000;

  for (const status of ["stopped", "failed"] as const) {
    await assert.doesNotReject(() =>
      authenticator({ status, stopped_at: now - terminalAgentEventGraceMs }, () => now).require(
        request,
        "IS-agent",
        {
          allowTerminalEventReplay: true,
        },
      ),
    );
  }
  for (const status of ["stopping", "expired"] as const) {
    await assert.rejects(
      () =>
        authenticator({ status, stopped_at: now }, () => now).require(request, "IS-agent", {
          allowTerminalEventReplay: true,
        }),
      { message: "agent session is not active" },
    );
  }
  for (const stoppedAt of [null, now + 1, now - terminalAgentEventGraceMs - 1]) {
    await assert.rejects(
      () =>
        authenticator({ status: "stopped", stopped_at: stoppedAt }, () => now).require(
          request,
          "IS-agent",
          { allowTerminalEventReplay: true },
        ),
      { message: "agent session is not active" },
    );
  }
});
