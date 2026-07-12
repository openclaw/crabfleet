import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  GitHubActionsApplication,
  gitHubActionsRelayRunnerUrl,
  structuredEventRequestMaxBytes,
} from "../src/worker/github-actions-application.ts";
import { terminalAgentEventGraceMs } from "../src/worker/session-agent-auth.ts";
import {
  handleServiceSessionRoute,
  type ServiceSessionRouteDependencies,
} from "../src/worker/routes/service-sessions.ts";
import { sessionRow } from "./helpers/session-row.ts";

function eventRequest(sessionId: string, token: string): Request {
  return new Request(`https://fleet.example/api/agent/interactive-sessions/${sessionId}/events`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      eventKey: "run:1",
      type: "clawsweeper.action",
      message: "updated pull request",
      payload: { version: 1, number: 42 },
    }),
  });
}

async function authEnvironment(
  targetStatus: "ready" | "stopped" | "failed" = "ready",
  stoppedAt: number | null = targetStatus === "ready" ? null : Date.now(),
) {
  const rows = new Map([
    [
      "IS-source",
      sessionRow({
        id: "IS-source",
        runtime: "github_actions",
        work_key: "source",
        agent_token_hash: await sha256("source-token"),
      }),
    ],
    [
      "IS-target",
      sessionRow({
        id: "IS-target",
        runtime: "github_actions",
        work_key: "target",
        agent_token_hash: await sha256("target-token"),
        status: targetStatus,
        stopped_at: stoppedAt,
      }),
    ],
  ]);
  const credentialReads: string[] = [];
  let mutations = 0;
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...parameters: unknown[]) {
            return {
              async all() {
                if (!/from "interactive_sessions"/i.test(sql)) {
                  mutations += 1;
                  throw new Error(`unexpected query: ${sql}`);
                }
                const id = parameters.find(
                  (parameter): parameter is string =>
                    typeof parameter === "string" && rows.has(parameter),
                );
                if (!id) throw new Error("credential lookup did not bind a session id");
                credentialReads.push(id);
                return { results: [rows.get(id)], meta: { changes: 0 } };
              },
              async run() {
                mutations += 1;
                throw new Error(`unexpected mutation: ${sql}`);
              },
            };
          },
        };
      },
      async batch() {
        mutations += 1;
        throw new Error("unexpected event persistence");
      },
    } as unknown as D1Database,
  } as RuntimeEnv;
  return { env, credentialReads, mutationCount: () => mutations };
}

function hasStatus(expected: number) {
  return (error: unknown) => {
    assert.equal(
      typeof error === "object" && error && "status" in error ? error.status : undefined,
      expected,
    );
    return true;
  };
}

function routeDependencies(application: GitHubActionsApplication): ServiceSessionRouteDependencies {
  const unused = async (): Promise<never> => {
    throw new Error("unexpected route dependency");
  };
  return {
    sshAuth: unused,
    sshState: unused,
    agentState: unused,
    createSshSession: unused,
    createAgentSession: unused,
    updateAgentWorkState: unused,
    appendAgentEvent: (request, sessionId) => application.appendStructuredEvent(request, sessionId),
    openAgentRunnerPty: unused,
    requireSshViewer: unused,
    requireAgentUser: unused,
    readFreshSession: unused,
    presentSession: unused,
    mutateSession: unused,
    listCheckpoints: unused,
    createCheckpoint: unused,
    restoreCheckpoint: unused,
    readLogs: unused,
    readTranscript: unused,
    updateSummary: unused,
  };
}

test("GitHub Actions application rejects an event token issued to another session", async () => {
  const subject = await authEnvironment();
  const application = new GitHubActionsApplication(subject.env, { audit: async () => undefined });

  await assert.rejects(
    application.appendStructuredEvent(eventRequest("IS-target", "source-token"), "IS-target"),
    hasStatus(401),
  );
  assert.deepEqual(subject.credentialReads, ["IS-target"]);
  assert.equal(subject.mutationCount(), 0);
});

test("GitHub Actions application propagates only the exact runner protocol opt-in", () => {
  const base =
    "https://fleet.example/api/agent/interactive-sessions/IS-target/runner-pty?agentToken=secret";
  assert.equal(
    gitHubActionsRelayRunnerUrl(new Request(base)),
    "https://crabfleet.internal/api/session-control/github-actions/runner",
  );
  assert.equal(
    gitHubActionsRelayRunnerUrl(new Request(`${base}&runnerProtocol=cfr1-framed-io-v1`)),
    "https://crabfleet.internal/api/session-control/github-actions/runner?runnerProtocol=cfr1-framed-io-v1",
  );
  assert.equal(
    gitHubActionsRelayRunnerUrl(new Request(`${base}&runnerProtocol=cfr1-framed-io-v2`)),
    "https://crabfleet.internal/api/session-control/github-actions/runner?runnerProtocol=cfr1-framed-io-v2",
  );
  assert.equal(
    gitHubActionsRelayRunnerUrl(new Request(`${base}&runnerProtocol=cfr1-framed-io-v3`)),
    "https://crabfleet.internal/api/session-control/github-actions/runner",
  );
});

test("agent event endpoint rejects a wrong-session token before persistence", async () => {
  const subject = await authEnvironment();
  const application = new GitHubActionsApplication(subject.env, { audit: async () => undefined });
  const request = eventRequest("IS-target", "source-token");

  await assert.rejects(
    handleServiceSessionRoute(request, new URL(request.url), routeDependencies(application)),
    hasStatus(401),
  );
  assert.deepEqual(subject.credentialReads, ["IS-target"]);
  assert.equal(subject.mutationCount(), 0);
});

test("agent event endpoint retains exact-token authentication after terminal work state", async () => {
  for (const status of ["stopped", "failed"] as const) {
    const subject = await authEnvironment(status);
    const application = new GitHubActionsApplication(subject.env, {
      audit: async () => undefined,
    });
    const request = new Request(
      "https://fleet.example/api/agent/interactive-sessions/IS-target/events",
      {
        method: "POST",
        headers: {
          authorization: "Bearer target-token",
          "content-type": "application/json",
        },
        body: "[]",
      },
    );

    await assert.rejects(application.appendStructuredEvent(request, "IS-target"), hasStatus(400));
    assert.deepEqual(subject.credentialReads, ["IS-target"]);
    assert.equal(subject.mutationCount(), 0);
  }
});

test("agent event endpoint rejects terminal credentials after the retry window", async () => {
  const subject = await authEnvironment("stopped", Date.now() - terminalAgentEventGraceMs - 60_000);
  const application = new GitHubActionsApplication(subject.env, {
    audit: async () => undefined,
  });

  await assert.rejects(
    application.appendStructuredEvent(eventRequest("IS-target", "target-token"), "IS-target"),
    hasStatus(403),
  );
  assert.deepEqual(subject.credentialReads, ["IS-target"]);
  assert.equal(subject.mutationCount(), 0);
});

test("authenticated event ingress rejects oversized chunked bodies before persistence", async () => {
  const subject = await authEnvironment();
  const application = new GitHubActionsApplication(subject.env, { audit: async () => undefined });
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(structuredEventRequestMaxBytes));
      controller.enqueue(new Uint8Array([123]));
      controller.close();
    },
  });
  const request = new Request(
    "https://fleet.example/api/agent/interactive-sessions/IS-target/events",
    {
      method: "POST",
      headers: {
        authorization: "Bearer target-token",
        "content-type": "application/json",
      },
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" },
  );

  await assert.rejects(application.appendStructuredEvent(request, "IS-target"), hasStatus(413));
  assert.deepEqual(subject.credentialReads, ["IS-target"]);
  assert.equal(subject.mutationCount(), 0);
});
