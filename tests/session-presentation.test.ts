import assert from "node:assert/strict";
import test from "node:test";

import { runtimeAdapterBrowserVncUrl, runtimeAdapterName } from "../src/runtime-adapter.ts";
import { parseRuntimeProfiles } from "../src/runtime-profiles.ts";
import type { User } from "../src/worker/models.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import {
  presentInteractiveSession,
  type InteractiveSessionPresentationContext,
} from "../src/worker/session-presentation.ts";
import { sessionRow } from "./helpers/session-row.ts";

function user(values: Partial<User> = {}): User {
  return {
    subject: "github:42",
    login: "operator",
    email: "operator@example.test",
    name: "Operator",
    role: "viewer",
    allowed: true,
    teams: [],
    ...values,
  };
}

function context(
  values: Partial<InteractiveSessionPresentationContext> = {},
): InteractiveSessionPresentationContext {
  return {
    now: 100,
    delegatedControlAvailable: true,
    terminalRouteAvailable: true,
    runtimeProfiles: [],
    configuredRuntimeAdapterControlPlane: () => "https://adapter.example",
    browserVncUrl: (sessionId) =>
      runtimeAdapterBrowserVncUrl("https://crabfleet.example", sessionId),
    ...values,
  };
}

test("session presentation exposes managed adapter routes and Codex SSH only to managers", () => {
  const [profile] = parseRuntimeProfiles(
    JSON.stringify([
      {
        id: "linux",
        label: "Linux",
        codexSsh: {
          aliasTemplate: "codex-{providerResourceId}",
          setupCommand: ["fleet-connect", "{workspaceId}"],
        },
      },
    ]),
  );
  const session = interactiveSession(
    sessionRow({
      id: "IS-1",
      owner: "operator",
      runtime: "crabbox",
      adapter: runtimeAdapterName,
      profile: "linux",
      adapter_workspace_id: "workspace-1",
      adapter_control_plane: "https://adapter.example",
      provider_resource_id: "box-1",
      lease_id: "runtime-v1:legacy",
      status: "ready",
    }),
    [],
  );

  const presented = presentInteractiveSession(
    session,
    user(),
    context({ runtimeProfiles: profile ? [profile] : [] }),
  );

  assert.equal(presented.canManage, true);
  assert.equal(presented.canControl, true);
  assert.equal(presented.ptyAvailable, true);
  assert.equal(presented.attachUrl, "/api/terminal/ws");
  assert.equal(presented.vncUrl, "https://crabfleet.example/api/interactive-sessions/IS-1/vnc");
  assert.equal(presented.leaseId, null);
  assert.deepEqual(presented.codexSsh, {
    alias: "codex-box-1",
    setupCommand: "fleet-connect 'workspace-1'",
  });
});

test("session presentation hides provider authority from viewers without control", () => {
  const session = interactiveSession(
    sessionRow({
      owner: "someone-else",
      runtime: "crabbox",
      adapter: runtimeAdapterName,
      profile: "linux",
      adapter_workspace_id: "workspace-1",
      adapter_control_plane: "https://adapter.example",
      provider_resource_id: "box-1",
      last_reconciled_at: 90,
      reconcile_error: "private provider state",
      status: "ready",
    }),
    [],
  );

  const presented = presentInteractiveSession(session, user(), context());

  assert.equal(presented.adapter, null);
  assert.equal(presented.profile, "");
  assert.equal(presented.adapterWorkspaceId, null);
  assert.equal(presented.providerResourceId, null);
  assert.equal(presented.lastReconciledAt, null);
  assert.equal(presented.reconcileError, null);
  assert.equal(presented.attachUrl, null);
  assert.equal(presented.vncUrl, null);
  assert.equal(presented.codexSsh, null);
  assert.equal(presented.canRequestControl, true);
});

test("delegated control expires atomically in presented state", () => {
  const session = interactiveSession(
    sessionRow({
      owner: "someone-else",
      controller: "operator",
      control_granted_at: 50,
      control_expires_at: 200,
      status: "ready",
    }),
    [],
  );

  const active = presentInteractiveSession(session, user(), context({ now: 100 }));
  assert.equal(active.canManage, false);
  assert.equal(active.canControl, true);
  assert.equal(active.controller, "operator");
  assert.equal(active.controlGrantedAt, 50);
  assert.equal(active.canRequestControl, false);
  assert.equal(active.attachUrl, "/api/terminal/ws");

  const expired = presentInteractiveSession(session, user(), context({ now: 200 }));
  assert.equal(expired.canControl, false);
  assert.equal(expired.controller, null);
  assert.equal(expired.controlGrantedAt, null);
  assert.equal(expired.controlExpiresAt, null);
  assert.equal(expired.canRequestControl, true);
  assert.equal(expired.attachUrl, null);
});

test("terminal and Codex SSH projections fail closed when routing or adapter identity changes", () => {
  const [profile] = parseRuntimeProfiles(
    JSON.stringify([
      {
        id: "linux",
        label: "Linux",
        codexSsh: { aliasTemplate: "codex-{workspaceId}" },
      },
    ]),
  );
  const session = interactiveSession(
    sessionRow({
      owner: "operator",
      runtime: "crabbox",
      adapter: runtimeAdapterName,
      profile: "linux",
      adapter_workspace_id: "workspace-1",
      adapter_control_plane: "https://adapter.example",
      status: "ready",
    }),
    [],
  );
  const presented = presentInteractiveSession(
    session,
    user(),
    context({
      terminalRouteAvailable: false,
      runtimeProfiles: profile ? [profile] : [],
      configuredRuntimeAdapterControlPlane: () => "https://other.example",
    }),
  );

  assert.equal(presented.ptyAvailable, false);
  assert.equal(presented.attachUrl, null);
  assert.equal(presented.codexSsh, null);

  const withoutTerminal = presentInteractiveSession(
    interactiveSession(
      sessionRow({
        owner: "operator",
        runtime: "crabbox",
        adapter: runtimeAdapterName,
        profile: "linux",
        adapter_workspace_id: "workspace-1",
        adapter_control_plane: "https://adapter.example",
        capabilities_json: JSON.stringify({ terminal: false, vnc: true }),
        status: "ready",
      }),
      [],
    ),
    user(),
    context({ runtimeProfiles: profile ? [profile] : [] }),
  );
  assert.equal(withoutTerminal.ptyAvailable, false);
  assert.equal(withoutTerminal.attachUrl, null);
  assert.equal(withoutTerminal.codexSsh, null);
});
