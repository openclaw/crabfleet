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
  attachUrl: "/api/terminal/ws",
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
      sandboxAvailable: true,
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
  assert.equal(fleet.totals.byRuntime.github_actions, 0);
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

test("GitHub Actions sessions are attachable through the Worker relay", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "github_actions",
        leaseId: "github-actions:s1",
        attachUrl: null,
        workKey: "openclaw/crabfleet:pr:42",
        workKind: "pr_repair",
        workState: "running",
        workPhase: "fixing",
        sourceUrl: "https://github.com/openclaw/crabfleet/pull/42",
        githubRunUrl: "https://github.com/openclaw/crabfleet/actions/runs/123",
        lastHeartbeatAt: 25,
      },
    ],
    [],
    {
      canonicalUrl: "https://crabfleet.openclaw.ai",
      defaultEgressHosts: [],
      generatedAt: 100,
      productUrl: "https://clawfleet.ai",
    },
  );

  assert.equal(fleet.totals.byRuntime.github_actions, 1);
  assert.equal(fleet.totals.attachable, 1);
  assert.equal(fleet.sessions[0]?.workState, "running");
  assert.equal(fleet.sessions[0]?.workPhase, "fixing");
});

test("sandbox lease parser ignores non-sandbox leases", () => {
  assert.equal(
    sandboxIdFromLeaseId("sandbox:crabbox-s1-abcd1234:terminal-s1-abcd1234:autostart-v4"),
    "crabbox-s1-abcd1234",
  );
  assert.equal(sandboxIdFromLeaseId("crabbox:external"), null);
  assert.equal(sandboxIdFromLeaseId(null), null);
});

test("fleet VNC availability follows adapter capabilities without persisting a URL", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: "runtime-v1",
        leaseId: "provider/resource",
        vncUrl: null,
        capabilities: { terminal: true, desktop: true, vnc: true },
      },
    ],
    [],
    {
      canonicalUrl: "https://fleet.example",
      defaultEgressHosts: [],
      generatedAt: 100,
      productUrl: "https://product.example",
    },
  );

  assert.equal(fleet.totals.vnc, 1);
  assert.equal(fleet.sessions[0]?.vnc, true);
});

test("stopping sessions are inactive and not attachable", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        status: "stopping",
        attachUrl: "wss://terminal.example/session",
        capabilities: { desktop: true, vnc: true },
      },
    ],
    [],
    {
      canonicalUrl: "https://fleet.example",
      defaultEgressHosts: [],
      generatedAt: 100,
      productUrl: "https://product.example",
    },
  );

  assert.equal(fleet.totals.active, 0);
  assert.equal(fleet.totals.attachable, 0);
  assert.equal(fleet.totals.vnc, 0);
  assert.equal(fleet.sessions[0]?.active, false);
});

test("withdrawn terminal capability suppresses fleet attachability", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        adapter: "runtime-v1",
        attachUrl: "wss://terminal.example/session",
        capabilities: { terminal: false },
      },
    ],
    [],
    {
      canonicalUrl: "https://fleet.example",
      defaultEgressHosts: [],
      generatedAt: 100,
      productUrl: "https://product.example",
    },
  );

  assert.equal(fleet.totals.attachable, 0);
  assert.equal(fleet.sessions[0]?.attachable, false);
});

test("fleet attachability follows resolvable PTY routes", () => {
  const options = {
    canonicalUrl: "https://fleet.example",
    defaultEgressHosts: [],
    generatedAt: 100,
    productUrl: "https://product.example",
  };
  const summary = (
    session: Parameters<typeof buildFleetState>[0][number],
    routing: Partial<Parameters<typeof buildFleetState>[2]> = {},
  ) => buildFleetState([session], [], { ...options, ...routing }).sessions[0]?.attachable;

  assert.equal(
    summary({ ...baseSession, leaseId: null, attachUrl: "wss://terminal.example/session" }),
    true,
  );
  assert.equal(
    summary({
      ...baseSession,
      status: "provisioning",
      leaseId: null,
      attachUrl: "wss://terminal.example/session",
    }),
    false,
  );
  assert.equal(
    summary({ ...baseSession, leaseId: null, attachUrl: "https://terminal.example/console" }),
    false,
  );
  assert.equal(
    summary({ ...baseSession, leaseId: null, attachUrl: "ws://terminal.example/session" }),
    false,
  );
  assert.equal(
    summary({ ...baseSession, leaseId: null, attachUrl: "ws://127.0.0.1:9000/session" }),
    true,
  );
  assert.equal(
    summary({ ...baseSession, leaseId: null, attachUrl: "ws://127.1:9000/session" }),
    false,
  );
  assert.equal(
    summary(
      { ...baseSession, leaseId: null, attachUrl: null },
      { ptyBridgeUrl: "https://bridge.example/pty/{id}" },
    ),
    true,
  );
  assert.equal(
    summary(
      { ...baseSession, leaseId: null, attachUrl: null, canControl: false },
      { ptyBridgeUrl: "https://bridge.example/pty/{id}" },
    ),
    false,
  );
});

test("legacy sessions require an actual VNC URL", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: null,
        vncUrl: null,
        capabilities: { desktop: true, vnc: true },
      },
    ],
    [],
    {
      canonicalUrl: "https://fleet.example",
      defaultEgressHosts: [],
      generatedAt: 100,
      productUrl: "https://product.example",
    },
  );

  assert.equal(fleet.totals.vnc, 0);
  assert.equal(fleet.sessions[0]?.vnc, false);
});
