import assert from "node:assert/strict";
import { test } from "node:test";
import {
  humanStatus,
  isActiveRun,
  isDeadInteractiveSession,
  isFleetSessionAttachable,
  isTerminalReadyInteractiveSession,
  interactiveSessionStatus,
  interactiveCommand,
  linkedInteractiveSessionPlaceholder,
  optimisticInteractiveSession,
  runCapabilities,
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
  const provisioning = { kind: "interactive", status: "pending_adapter" };
  const stopping = { kind: "interactive", status: "stopping" };
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
  assert.deepEqual(interactiveSessionStatus(provisioning), {
    label: "Provisioning",
    tone: "provisioning",
  });
  assert.equal(isActiveRun(stopping), false);
  assert.deepEqual(interactiveSessionStatus(stopping), {
    label: "Stopping",
    tone: "provisioning",
  });
  assert.equal(isDeadInteractiveSession(failed), true);
  assert.deepEqual(interactiveSessionStatus(failed), { label: "Failed", tone: "failed" });
  assert.equal(humanStatus("pending_adapter"), "Pending Adapter");
});
