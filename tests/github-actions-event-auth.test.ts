import assert from "node:assert/strict";
import test from "node:test";

import { sha256 } from "../src/worker/crypto.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import { GitHubActionsApplication } from "../src/worker/github-actions-application.ts";
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

async function authEnvironment() {
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
