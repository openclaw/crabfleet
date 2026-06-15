import assert from "node:assert/strict";
import test from "node:test";

import { interactiveSession } from "../src/worker/session-model.ts";
import {
  activeDelegatedController,
  sharedInteractiveSession,
} from "../src/worker/session-sharing.ts";
import { sessionRow } from "./helpers/session-row.ts";

test("shared session policy removes provider and terminal authority", () => {
  const session = interactiveSession(
    sessionRow({
      id: "IS-2",
      adapter: "runtime-v1",
      profile: "desktop",
      adapter_workspace_id: "workspace-2",
      provider_resource_id: "provider-2",
      last_reconciled_at: 100,
      reconcile_error: "pending",
      lease_id: "sandbox:secret",
      attach_url: "wss://terminal.example.test",
      vnc_url: "https://desktop.example.test",
      controller: "operator",
      control_granted_at: 90,
      control_expires_at: 200,
      multiplayer_mode: 1,
    }),
    ["ready"],
  );
  const shared = sharedInteractiveSession(session, 150);

  assert.equal(shared.adapter, null);
  assert.equal(shared.profile, "");
  assert.equal(shared.adapterWorkspaceId, null);
  assert.equal(shared.providerResourceId, null);
  assert.equal(shared.lastReconciledAt, null);
  assert.equal(shared.reconcileError, null);
  assert.equal(shared.leaseId, null);
  assert.equal(shared.attachUrl, null);
  assert.equal(shared.vncUrl, null);
  assert.equal(shared.ptyAvailable, false);
  assert.equal(shared.controller, "operator");
  assert.equal(shared.controlGrantedAt, 90);
  assert.equal(shared.controlExpiresAt, 200);
  assert.equal(shared.multiplayerMode, true);
  assert.equal(shared.canControl, false);
  assert.equal(shared.canManage, false);
  assert.equal(shared.canRequestControl, false);
  assert.equal(shared.sharedReadOnly, true);
  assert.deepEqual(shared.logs, ["ready"]);
});

test("shared session policy removes expired delegated control", () => {
  const session = interactiveSession(
    sessionRow({
      controller: "operator",
      control_granted_at: 90,
      control_expires_at: 100,
    }),
    [],
  );

  assert.equal(activeDelegatedController(session, 100), null);
  const shared = sharedInteractiveSession(session, 100);
  assert.equal(shared.controller, null);
  assert.equal(shared.controlGrantedAt, null);
  assert.equal(shared.controlExpiresAt, null);
});
