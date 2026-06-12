import assert from "node:assert/strict";
import { test } from "node:test";
import { buildFleetState, sandboxIdFromLeaseId } from "../src/fleet-state.ts";

const baseSession = {
  id: "s1",
  parentSessionId: null,
  rootSessionId: "s1",
  repo: "openclaw/crabfleet",
  branch: "main",
  runtime: "container" as const,
  owner: "github:steipete",
  createdBy: "github:steipete",
  purpose: "supervise Crabfleet",
  summary: "tracking fleet visibility",
  status: "ready" as const,
  leaseId: "sandbox:crabbox-s1-abcd1234:terminal-s1-abcd1234:autostart-v4",
  attachUrl: "/api/interactive-sessions/s1/pty",
  vncUrl: null,
  lastEvent: "Cloudflare Sandbox ready",
  createdAt: 10,
  updatedAt: 20,
  lastSeenAt: 20,
  stoppedAt: null,
  logs: ["ready"],
  logArchive: { eventCount: 42 },
};

test("fleet state aggregates sessions and redacted sandbox policies", () => {
  const fleet = buildFleetState(
    [
      baseSession,
      {
        ...baseSession,
        id: "s2",
        runtime: "crabbox",
        status: "failed",
        leaseId: "crabbox:external-lease",
        attachUrl: null,
        vncUrl: "https://example.invalid/vnc",
        updatedAt: 30,
        logArchive: null,
      },
    ],
    [
      {
        allowedHostCount: 3,
        githubCredentialSource: "worker",
        githubRepo: "openclaw/crabfleet",
        hasGithubRepoNodeId: true,
        hasGithubToken: true,
        openAIBaseUrlHost: "api.openai.com",
        openAIOrgConfigured: false,
        owner: "github:steipete",
        sandboxId: "crabbox-s1-abcd1234",
        sessionId: "s1",
      },
    ],
    {
      canonicalUrl: "https://crabfleet.openclaw.ai",
      defaultEgressHosts: ["github.com", "api.github.com"],
      generatedAt: 100,
      productUrl: "https://crabfleet.ai",
    },
  );

  assert.equal(fleet.totals.sessions, 2);
  assert.equal(fleet.totals.active, 1);
  assert.equal(fleet.totals.failed, 1);
  assert.equal(fleet.totals.ready, 1);
  assert.equal(fleet.totals.archived, 1);
  assert.equal(fleet.totals.attachable, 1);
  assert.equal(fleet.totals.byRuntime.container, 1);
  assert.equal(fleet.totals.byRuntime.crabbox, 1);
  assert.equal(fleet.egress.defaultHostCount, 2);
  assert.equal(fleet.egress.policyCount, 1);
  assert.equal(fleet.egress.sessionsWithPolicy, 1);
  assert.equal(fleet.sessions[0]?.id, "s2");
  assert.equal(fleet.sessions[1]?.sandboxId, "crabbox-s1-abcd1234");
  assert.equal(fleet.sessions[1]?.rootSessionId, "s1");
  assert.equal(fleet.sessions[1]?.createdBy, "github:steipete");
  assert.equal(fleet.sessions[1]?.purpose, "supervise Crabfleet");
  assert.equal(fleet.sessions[1]?.summary, "tracking fleet visibility");
  assert.equal(fleet.sessions[1]?.policy.present, true);
  assert.equal(fleet.sessions[1]?.policy.hasGithubToken, true);
  assert.equal(fleet.sessions[1]?.policy.githubCredentialSource, "worker");
  assert.equal(fleet.sessions[1]?.policy.allowedHostCount, 3);
});

test("sandbox lease parser ignores non-sandbox leases", () => {
  assert.equal(
    sandboxIdFromLeaseId("sandbox:crabbox-s1-abcd1234:terminal-s1-abcd1234:autostart-v4"),
    "crabbox-s1-abcd1234",
  );
  assert.equal(sandboxIdFromLeaseId("crabbox:external"), null);
  assert.equal(sandboxIdFromLeaseId(null), null);
});
