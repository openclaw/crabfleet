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
      {
        allowedHostCount: 99,
        githubCredentialSource: "session",
        githubRepo: "private/foreign",
        hasGithubRepoNodeId: true,
        hasGithubToken: true,
        openAIBaseUrlHost: "foreign.example",
        openAIOrgConfigured: true,
        owner: "foreign",
        sandboxId: "foreign-sandbox",
        sessionId: "foreign-session",
      },
    ],
    {
      canonicalUrl: "https://crabfleet.openclaw.ai",
      defaultEgressHosts: ["github.com", "api.github.com"],
      generatedAt: 100,
      productUrl: "https://crabfleet.ai",
      sandboxAvailable: true,
      desktopHosts: [
        {
          id: "studio",
          owner: "steipete",
          name: "Studio",
          address: "100.64.1.2",
          port: 5901,
          relayCapable: true,
          createdAt: 10,
          updatedAt: 50,
        },
      ],
    },
  );

  assert.equal(fleet.totals.sessions, 2);
  assert.equal(fleet.totals.active, 1);
  assert.equal(fleet.totals.failed, 1);
  assert.equal(fleet.totals.attention, 1);
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
  assert.deepEqual(fleet.desktopHosts, [
    {
      id: "studio",
      owner: "steipete",
      name: "Studio",
      address: "100.64.1.2",
      port: 5901,
      relayCapable: true,
      createdAt: 10,
      updatedAt: 50,
    },
  ]);
});

test("fleet state separates healthy provisioning from sessions needing attention", () => {
  const generatedAt = 20 * 60_000;
  const sessions = [
    {
      ...baseSession,
      id: "healthy",
      status: "provisioning" as const,
      createdAt: generatedAt - 10_000,
      updatedAt: generatedAt - 5_000,
      reconcileError: "runtime adapter create pending",
    },
    {
      ...baseSession,
      id: "error",
      status: "provisioning" as const,
      reconcileError: "runtime adapter control plane differs from workspace registration",
    },
    {
      ...baseSession,
      id: "stale",
      status: "provisioning" as const,
      createdAt: 0,
      updatedAt: 1,
    },
    {
      ...baseSession,
      id: "expired",
      status: "provisioning" as const,
      expiresAt: generatedAt,
    },
    {
      ...baseSession,
      id: "pending",
      status: "pending_adapter" as const,
    },
    {
      ...baseSession,
      id: "stopping",
      status: "stopping" as const,
    },
    {
      ...baseSession,
      id: "redacted-error",
      status: "provisioning" as const,
      reconcileError: null,
      reconciliationNeedsAttention: true,
    },
  ];
  const fleet = buildFleetState(sessions, [], {
    canonicalUrl: "https://fleet.example",
    defaultEgressHosts: [],
    generatedAt,
    productUrl: "https://product.example",
  });
  const byId = new Map(fleet.sessions.map((session) => [session.id, session]));

  assert.equal(fleet.totals.provisioning, 1);
  assert.equal(fleet.totals.attention, 6);
  assert.equal(fleet.totals.byStatus.provisioning, 5);
  assert.equal(fleet.totals.byStatus.pending_adapter, 1);
  assert.equal(byId.get("healthy")?.attention, false);
  assert.equal(byId.get("error")?.attentionReason, sessions[1]?.reconcileError);
  assert.match(byId.get("stale")?.attentionReason ?? "", /15 minutes/);
  assert.equal(byId.get("expired")?.attentionReason, "Provisioning lease expired");
  assert.equal(byId.get("pending")?.attention, true);
  assert.equal(byId.get("stopping")?.attention, true);
  assert.equal(
    byId.get("redacted-error")?.attentionReason,
    "Provisioning needs operator attention",
  );
});

test("GitHub Actions sessions are attachable through the Worker relay", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "github_actions",
        leaseId: "github-actions:s1",
        attachUrl: null,
        ptyAvailable: true,
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

test("GitHub Actions sessions require an available Worker relay", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "github_actions",
        leaseId: "github-actions:s1",
        attachUrl: null,
        ptyAvailable: false,
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

  assert.equal(fleet.totals.attachable, 0);
  assert.equal(fleet.sessions[0]?.attachable, false);
});

test("sandbox lease parser ignores non-sandbox leases", () => {
  assert.equal(
    sandboxIdFromLeaseId("sandbox:crabbox-s1-abcd1234:terminal-s1-abcd1234:autostart-v4"),
    "crabbox-s1-abcd1234",
  );
  assert.equal(sandboxIdFromLeaseId("crabbox:external"), null);
  assert.equal(sandboxIdFromLeaseId(null), null);
});

test("fleet exposes native VNC identity separately from browser VNC", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: "runtime-v1",
        providerResourceId: "cbx_native123",
        canControl: true,
        leaseId: "provider/resource",
        vncUrl: null,
        capabilities: { terminal: true, desktop: false, vnc: false, nativeVnc: true },
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
  assert.equal(fleet.sessions[0]?.nativeVncSessionId, "s1");
});

test("fleet omits native VNC identity for non-Crabbox runtimes", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "container",
        adapter: "runtime-v1",
        providerResourceId: "container-native123",
        canControl: true,
        capabilities: { terminal: true, desktop: false, vnc: false, nativeVnc: true },
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

  assert.equal(fleet.sessions[0]?.nativeVncSessionId, null);
});

test("fleet omits native VNC lease identity without control", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: "runtime-v1",
        providerResourceId: "cbx_hidden",
        canControl: false,
        leaseId: null,
        vncUrl: null,
        capabilities: { terminal: true, desktop: false, vnc: false, nativeVnc: true },
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

  assert.equal(fleet.sessions[0]?.nativeVncSessionId, null);
});

test("fleet omits stale native VNC lease identity after stop", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: "runtime-v1",
        providerResourceId: "cbx_stopped",
        canControl: true,
        status: "stopped",
        capabilities: { terminal: true, desktop: false, vnc: false, nativeVnc: true },
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

  assert.equal(fleet.sessions[0]?.nativeVncSessionId, null);
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

test("named read-only viewers remain Fleet-attachable", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        canControl: false,
        ptyAvailable: true,
        attachUrl: null,
        capabilities: { terminal: true },
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

  assert.equal(fleet.sessions[0]?.attachable, true);
  assert.equal(fleet.totals.attachable, 1);
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
  assert.equal(summary({ ...baseSession, leaseId: null, attachUrl: null }), false);
});

test("non-adapter sessions never advertise legacy VNC URLs", () => {
  const fleet = buildFleetState(
    [
      {
        ...baseSession,
        runtime: "crabbox",
        adapter: null,
        vncUrl: "https://legacy.example/vnc",
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
