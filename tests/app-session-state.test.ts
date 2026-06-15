import assert from "node:assert/strict";
import test from "node:test";

import {
  canCleanInteractiveSession,
  isLocalInteractiveSession,
  isSessionGridItem,
  isTerminalKeyTarget,
  sessionFooterSummary,
  sessionStatus,
  sessionTerminalStatusLabel,
  terminalMountKey,
  terminalProvisioningDetail,
} from "../src/app/session-state.js";

test("session workspace keys terminals by interactive runtime identity", () => {
  assert.equal(terminalMountKey({ id: "CY-1", kind: "card" }), "CY-1");
  assert.equal(
    terminalMountKey({
      id: "IS-1",
      kind: "interactive",
      command: "codex --yolo",
      leaseId: "sandbox:one",
    }),
    "IS-1:codex --yolo:sandbox:one",
  );
  assert.equal(isLocalInteractiveSession({ id: "LOCAL-1", kind: "interactive" }), true);
  assert.equal(isLocalInteractiveSession({ id: "LOCAL-1", kind: "card" }), false);
});

test("session workspace includes interactive and active card terminals", () => {
  assert.equal(isSessionGridItem({ kind: "interactive", status: "failed" }), true);
  assert.equal(
    isSessionGridItem({ kind: "card", lane: "Running", run: { status: "running" } }),
    true,
  );
  assert.equal(
    isSessionGridItem({ kind: "card", lane: "Done", run: { status: "succeeded" } }),
    false,
  );
});

test("session workspace derives status, footer, and terminal presentation", () => {
  const failed = {
    id: "IS-1",
    kind: "interactive",
    status: "failed",
    repo: "openclaw/crabfleet",
    workState: "blocked",
    multiplayerMode: true,
  };
  assert.deepEqual(sessionStatus(failed), { label: "Blocked", tone: "failed" });
  assert.match(sessionFooterSummary(failed), /^IS-1 · Blocked · Failed · multiplayer$/);
  assert.equal(sessionTerminalStatusLabel(failed, { "IS-1": "PTY error" }), "Log replay");
  assert.equal(
    sessionTerminalStatusLabel(
      { id: "IS-2", kind: "interactive", status: "ready", capabilities: { vnc: true } },
      {},
    ),
    "VNC eligible",
  );
  assert.equal(
    terminalProvisioningDetail({ status: "pending_adapter" }),
    "Runtime adapter pending",
  );
  assert.equal(
    terminalProvisioningDetail({
      id: "LOCAL-1",
      kind: "interactive",
      status: "provisioning",
      lastEvent: "Creating",
    }),
    "Creating",
  );
});

test("session cleanup and escape handling respect authorization and terminal focus", () => {
  const dead = { kind: "interactive", status: "stopped" };
  assert.equal(canCleanInteractiveSession(dead, { role: "viewer" }), false);
  assert.equal(canCleanInteractiveSession({ ...dead, canManage: true }, { role: "viewer" }), true);
  assert.equal(canCleanInteractiveSession(dead, { role: "maintainer" }), true);

  const terminal = {
    closest: (selector: string) => (selector === ".ghostty-terminal" ? {} : null),
  };
  const outside = { closest: () => null };
  assert.equal(isTerminalKeyTarget({ target: terminal }, outside), true);
  assert.equal(isTerminalKeyTarget({ target: outside }, terminal), true);
  assert.equal(isTerminalKeyTarget({ target: outside }, outside), false);
});
