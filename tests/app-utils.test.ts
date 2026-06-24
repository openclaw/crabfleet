import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canDeleteInteractiveWorkspace,
  humanStatus,
  isActiveRun,
  isDeadInteractiveSession,
  isFleetSessionAttachable,
  isTerminalReadyInteractiveSession,
  interactiveSessionStatus,
  isFleetSessionAttention,
  interactiveCommand,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  runCapabilities,
  runtimeCapabilityLabel,
  runtimeProfileOptionLabel,
  runtimeLabel,
  sessionItems,
  terminalText,
} from "../src/app/utils.js";

test("interactive session ordering ignores passive terminal last-seen refreshes", () => {
  const state = {
    cards: [],
    interactiveSessions: [
      {
        id: "IS-1",
        repo: "openclaw/crabfleet",
        branch: "main",
        status: "attached",
        updatedAt: 2000,
        createdAt: 1000,
        lastSeenAt: 100_000,
      },
      {
        id: "IS-2",
        repo: "openclaw/crabfleet",
        branch: "main",
        status: "attached",
        updatedAt: 3000,
        createdAt: 1000,
        lastSeenAt: 10_000,
      },
    ],
  };

  assert.deepEqual(
    sessionItems(state).map((session) => session.id),
    ["IS-2", "IS-1"],
  );
});

test("card ordering falls back to created time when no run has started", () => {
  const state = {
    interactiveSessions: [],
    cards: [
      { id: "CY-1", lane: "Todo", createdAt: 1000, updatedAt: 0, startedAt: null, run: null },
      { id: "CY-2", lane: "Todo", createdAt: 2000, updatedAt: 0, startedAt: null, run: null },
    ],
  };

  assert.deepEqual(
    sessionItems(state).map((session) => session.id),
    ["CY-2", "CY-1"],
  );
});

test("card ordering keeps updated cards ahead of older start times", () => {
  const state = {
    interactiveSessions: [],
    cards: [
      { id: "CY-1", lane: "Todo", createdAt: 1000, updatedAt: 9000, startedAt: 1000, run: null },
      { id: "CY-2", lane: "Todo", createdAt: 2000, updatedAt: 3000, startedAt: 8000, run: null },
    ],
  };

  assert.deepEqual(
    sessionItems(state).map((session) => session.id),
    ["CY-1", "CY-2"],
  );
});

test("optimistic interactive sessions use runtime-specific pending copy", () => {
  const data = new FormData();
  data.set("repo", "openclaw/crabfleet");
  data.set("runtime", "crabbox");

  const session = optimisticInteractiveSession(data, "steipete");

  assert.equal(session.runtime, "crabbox");
  assert.equal(session.lastEvent, "Requesting Crabbox...");
  assert.deepEqual(session.logs, ["Requesting Crabbox...", "Waiting for session id..."]);
});

test("optimistic interactive sessions use configured profile capabilities", () => {
  const data = new FormData();
  data.set("repo", "openclaw/crabfleet");
  data.set("runtime", "crabbox");
  data.set("profile", "terminal-only");

  const session = optimisticInteractiveSession(data, "operator", [
    {
      id: "terminal-only",
      label: "Terminal only",
      capabilities: { desktop: false, vnc: false },
    },
  ]);

  assert.equal(session.profile, "terminal-only");
  assert.equal(session.capabilities.terminal, true);
  assert.equal(session.capabilities.desktop, false);
  assert.equal(session.capabilities.vnc, false);
});

test("runtime profile options expose target and enabled capabilities", () => {
  assert.equal(
    runtimeProfileOptionLabel({
      id: "desktop-a",
      label: "Desktop A",
      target: "platform-a",
      capabilities: { terminal: true, desktop: true, vnc: true },
    }),
    "Desktop A — platform-a · terminal, desktop, VNC",
  );
  assert.equal(
    runtimeProfileOptionLabel({
      id: "linux",
      label: "Linux",
      target: "linux",
      capabilities: {},
    }),
    "Linux — terminal, desktop, VNC",
  );
});

test("interactive command defaults to yolo without sandbox suffix", () => {
  const data = new FormData();
  data.set("repo", "openclaw/crabfleet");

  const session = optimisticInteractiveSession(data, "steipete");

  assert.equal(session.runtime, "container");
  assert.equal(session.command, "codex --yolo");
  assert.equal(interactiveCommand(" codex   --yolosandbox "), "codex --yolo");
  assert.match(terminalText({ ...session, kind: "interactive" }), /^Preparing Codex\r\n/);
  assert.doesNotMatch(terminalText({ ...session, kind: "interactive" }), /Requesting/);
});

test("linked session placeholders render a best-effort Codex card", () => {
  const session = { ...linkedInteractiveSessionPlaceholder("IS-101"), kind: "interactive" };

  assert.equal(session.routePlaceholder, true);
  assert.equal(isActiveRun(session), true);
  assert.match(terminalText(session), /^Preparing Codex\r\n/);
  assert.match(terminalText(session), /Loading session/);
});
test("interactive lifecycle helpers keep UI and terminal state aligned", () => {
  const live = { kind: "interactive", status: "attached" };
  const rawLive = { status: "ready" };
  const terminalWithdrawn = {
    kind: "interactive",
    status: "ready",
    capabilities: { terminal: false },
  };
  const rawTerminalWithdrawn = { status: "ready", capabilities: { terminal: false } };
  const controlledWithoutPty = {
    kind: "interactive",
    status: "ready",
    capabilities: { terminal: true },
    canControl: true,
    ptyAvailable: false,
  };
  const controlledWithPty = { ...controlledWithoutPty, ptyAvailable: true };
  const sharedReadOnly = {
    ...controlledWithoutPty,
    canControl: false,
    sharedReadOnly: true,
  };
  const starting = { kind: "interactive", status: "provisioning" };
  const provisioning = { kind: "interactive", status: "pending_adapter" };
  const stopping = { kind: "interactive", status: "stopping" };
  const deleting = { ...stopping, adapter: "runtime-v1" };
  const failed = { kind: "interactive", status: "failed" };

  assert.equal(isActiveRun(live), true);
  assert.equal(isTerminalReadyInteractiveSession(live), true);
  assert.equal(isTerminalReadyInteractiveSession(rawLive), true);
  assert.equal(isTerminalReadyInteractiveSession(terminalWithdrawn), false);
  assert.equal(isTerminalReadyInteractiveSession(rawTerminalWithdrawn), false);
  assert.equal(isTerminalReadyInteractiveSession(controlledWithoutPty), false);
  assert.equal(isTerminalReadyInteractiveSession(controlledWithPty), true);
  assert.equal(isTerminalReadyInteractiveSession(sharedReadOnly), true);
  assert.equal(runCapabilities(rawTerminalWithdrawn).terminal, false);
  assert.equal(
    isFleetSessionAttachable({
      ...rawLive,
      attachUrl: "wss://terminal.example/session",
      fleet: { attachable: true },
      capabilities: { terminal: false },
    }),
    false,
  );
  assert.equal(
    isFleetSessionAttachable({
      ...rawLive,
      attachUrl: "wss://terminal.example/session",
      fleet: { attachable: false },
      capabilities: { terminal: true },
    }),
    false,
  );
  assert.deepEqual(interactiveSessionStatus(live), { label: "Live", tone: "live" });
  assert.deepEqual(interactiveSessionStatus(starting), {
    label: "Provisioning",
    tone: "provisioning",
  });
  assert.deepEqual(interactiveSessionStatus(provisioning), {
    label: "Attention",
    tone: "failed",
  });
  assert.deepEqual(interactiveSessionStatus({ ...provisioning, fleet: { attention: true } }), {
    label: "Attention",
    tone: "failed",
  });
  assert.equal(
    isFleetSessionAttention({ ...provisioning, reconciliationNeedsAttention: true }),
    true,
  );
  assert.equal(
    isFleetSessionAttention(
      {
        ...starting,
        reconcileError: "runtime adapter create pending",
        createdAt: 90_000,
        updatedAt: 95_000,
      },
      100_000,
    ),
    false,
  );
  assert.equal(
    isFleetSessionAttention({ ...starting, reconcileError: "provider unavailable" }, 100_000),
    true,
  );
  assert.equal(
    isFleetSessionAttention({ ...starting, createdAt: 1, updatedAt: 2 }, 20 * 60_000),
    true,
  );
  assert.equal(isActiveRun(stopping), false);
  assert.deepEqual(interactiveSessionStatus(stopping), {
    label: "Stopping",
    tone: "provisioning",
  });
  assert.deepEqual(interactiveSessionStatus(deleting), {
    label: "Deleting",
    tone: "provisioning",
  });
  assert.equal(canDeleteInteractiveWorkspace(deleting), true);
  assert.equal(canDeleteInteractiveWorkspace({ ...stopping, leaseId: "clawfleet:legacy" }), false);
  assert.equal(isDeadInteractiveSession(failed), true);
  assert.deepEqual(interactiveSessionStatus(failed), { label: "Failed", tone: "failed" });
  assert.equal(humanStatus("pending_adapter"), "Pending Adapter");
});

test("GitHub Actions sessions expose steerable terminal UI capabilities", () => {
  const session = { kind: "interactive", runtime: "github_actions", status: "ready" };

  assert.equal(runtimeLabel(session.runtime), "GitHub Actions");
  assert.equal(runtimeCapabilityLabel(session), "GitHub Actions terminal");
  assert.deepEqual(runCapabilities(session), {
    terminal: true,
    takeover: true,
    vnc: false,
    desktop: false,
    logs: true,
    artifacts: false,
  });
});

test("token-backed read-only sessions remain Fleet-attachable without raw URLs", () => {
  const shared = {
    kind: "interactive",
    status: "ready",
    capabilities: { terminal: true },
    attachUrl: null,
    ptyAvailable: false,
    sharedLinkOnly: true,
    sharedReadOnly: true,
  };
  assert.equal(isFleetSessionAttachable(shared), true);
});
