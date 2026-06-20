import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import { userServiceSessionAuthority, userTenantSubject } from "../src/worker/models.ts";
import {
  canChangeInteractiveSessionMultiplayer,
  canControlInteractiveSession,
  canManageInteractiveSession,
  canReadInteractiveSessionTerminal,
  canViewInteractiveSession,
  delegatedInteractiveSessionControlAvailable,
  interactiveSessionAccess,
  interactiveSessionActorCandidates,
} from "../src/worker/session-access.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
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

test("session actor candidates include canonical and fallback identities", () => {
  assert.deepEqual(
    [...interactiveSessionActorCandidates(user())],
    ["operator", "github:42", "operator@example.test"],
  );
  assert.deepEqual(
    [...interactiveSessionActorCandidates(user({ login: null }))],
    ["operator@example.test", "github:42"],
  );
});

test("owners and elevated roles can manage sessions", () => {
  const owned = interactiveSession(sessionRow({ owner: "operator@example.test" }), []);
  assert.equal(canManageInteractiveSession(user(), owned), true);

  const foreign = interactiveSession(sessionRow({ owner: "someone-else" }), []);
  assert.equal(canManageInteractiveSession(user(), foreign), false);
  assert.equal(canManageInteractiveSession(user({ role: "maintainer" }), foreign), true);
  assert.equal(canManageInteractiveSession(user({ role: "owner" }), foreign), true);
});

test("only the recorded creator identity can change multiplayer", () => {
  const owned = interactiveSession(sessionRow({ owner: "github:42" }), []);
  assert.equal(canChangeInteractiveSessionMultiplayer(user(), owned), true);

  const foreign = interactiveSession(sessionRow({ owner: "someone-else" }), []);
  assert.equal(canChangeInteractiveSessionMultiplayer(user({ role: "owner" }), foreign), false);
});

test("session managers always retain terminal control", () => {
  const session = interactiveSession(sessionRow({ owner: "operator" }), []);
  assert.equal(canControlInteractiveSession(user(), session, 100, false), true);
});

test("delegated terminal control requires the canonical actor and a live lease", () => {
  const session = interactiveSession(
    sessionRow({
      owner: "someone-else",
      controller: "operator",
      control_expires_at: 200,
    }),
    [],
  );
  assert.equal(canControlInteractiveSession(user(), session, 100, true), true);
  assert.equal(canControlInteractiveSession(user(), session, 200, true), false);
  assert.equal(canControlInteractiveSession(user(), session, 100, false), false);

  const emailController = interactiveSession(
    sessionRow({
      owner: "someone-else",
      controller: "operator@example.test",
      control_expires_at: 200,
    }),
    [],
  );
  assert.equal(canControlInteractiveSession(user(), emailController, 100, true), false);
});

test("delegated terminal control requires a configured Sandbox for Sandbox sessions", () => {
  const sandbox = interactiveSession(sessionRow({ lease_id: "sandbox:box-1:terminal-1" }), []);
  const adapter = interactiveSession(
    sessionRow({ adapter: "runtime-v1", adapter_workspace_id: "workspace-1" }),
    [],
  );
  assert.equal(delegatedInteractiveSessionControlAvailable(false, sandbox), false);
  assert.equal(delegatedInteractiveSessionControlAvailable(true, sandbox), true);
  assert.equal(delegatedInteractiveSessionControlAvailable(false, adapter), true);
});

test("private tenancy hides foreign sessions from every global role", () => {
  const foreign = interactiveSession(
    sessionRow({ owner: "other", owner_subject: "proxy:other@example.test" }),
    [],
  );
  for (const role of ["viewer", "maintainer", "owner"] as const) {
    const current = user({ role });
    assert.equal(canViewInteractiveSession(current, foreign, 100, { mode: "private" }), false);
    assert.equal(canManageInteractiveSession(current, foreign, { mode: "private" }), false);
    assert.equal(
      canControlInteractiveSession(current, foreign, 100, true, { mode: "private" }),
      false,
    );
  }
});

test("private tenancy fails closed for legacy owners without a stable subject", () => {
  const legacy = interactiveSession(sessionRow({ owner: "operator", owner_subject: "" }), []);
  assert.equal(canViewInteractiveSession(user(), legacy, 100, { mode: "private" }), false);
  assert.equal(canManageInteractiveSession(user(), legacy, { mode: "private" }), false);
  assert.equal(canViewInteractiveSession(user(), legacy, 100, { mode: "shared" }), true);
});

test("private tenancy fails closed for legacy controllers without a stable subject", () => {
  const legacy = interactiveSession(
    sessionRow({
      owner: "other",
      owner_subject: "github:99",
      controller: "operator",
      controller_subject: null,
      control_expires_at: 200,
    }),
    [],
  );
  assert.equal(canControlInteractiveSession(user(), legacy, 100, true, { mode: "private" }), false);
  assert.equal(canControlInteractiveSession(user(), legacy, 100, true, { mode: "shared" }), true);
});

test("private tenancy grants bounded view or control without management", () => {
  const foreign = interactiveSession(
    sessionRow({ owner: "other", owner_subject: "proxy:other@example.test" }),
    [],
  );
  const viewer = interactiveSessionAccess(user(), foreign, 100, true, {
    mode: "private",
    grant: { subject: "github:42", role: "viewer", expiresAt: 200 },
  });
  assert.deepEqual(viewer, {
    visible: true,
    manage: false,
    control: false,
    changeMultiplayer: false,
    role: "viewer",
  });

  const controller = interactiveSessionAccess(user(), foreign, 100, true, {
    mode: "private",
    grant: { subject: "github:42", role: "controller", expiresAt: 200 },
  });
  assert.deepEqual(controller, {
    visible: true,
    manage: false,
    control: true,
    changeMultiplayer: false,
    role: "controller",
  });

  for (const grant of [
    { subject: "github:42", role: "controller" as const, expiresAt: 100 },
    { subject: "github:99", role: "controller" as const, expiresAt: 200 },
  ]) {
    assert.equal(
      interactiveSessionAccess(user(), foreign, 100, true, { mode: "private", grant }).visible,
      false,
    );
  }
});

test("private tenancy uses stable subjects for ownership and delegated control", () => {
  const current = user();
  current[userTenantSubject] = "proxy:operator@example.test";
  const owned = interactiveSession(
    sessionRow({ owner: "legacy", owner_subject: "proxy:operator@example.test" }),
    [],
  );
  assert.deepEqual(interactiveSessionAccess(current, owned, 100, true, { mode: "private" }), {
    visible: true,
    manage: true,
    control: true,
    changeMultiplayer: true,
    role: "owner",
  });

  const delegated = interactiveSession(
    sessionRow({
      owner: "other",
      owner_subject: "proxy:other@example.test",
      controller: "legacy-controller",
      controller_subject: "proxy:operator@example.test",
      control_expires_at: 200,
    }),
    [],
  );
  const access = interactiveSessionAccess(current, delegated, 100, true, { mode: "private" });
  assert.equal(access.visible, true);
  assert.equal(access.control, true);
  assert.equal(access.manage, false);
});

test("agent authority is limited to its session and direct children", () => {
  const agent = user({ subject: "agent:IS-agent", login: "owner" });
  agent[userServiceSessionAuthority] = "IS-agent";
  const ownSession = interactiveSession(
    sessionRow({ id: "IS-agent", owner: "owner", owner_subject: "github:42" }),
    [],
  );
  const child = interactiveSession(
    sessionRow({
      id: "IS-child",
      owner_subject: "github:42",
      parent_session_id: "IS-agent",
      created_by: "session:IS-agent",
    }),
    [],
  );
  const sibling = interactiveSession(
    sessionRow({ id: "IS-sibling", owner: "owner", owner_subject: "github:42" }),
    [],
  );
  const forgedChild = interactiveSession(
    sessionRow({
      id: "IS-forged",
      owner_subject: "github:42",
      parent_session_id: "IS-sibling",
      created_by: "session:IS-agent",
    }),
    [],
  );
  assert.equal(canManageInteractiveSession(agent, ownSession, { mode: "private" }), true);
  assert.equal(canManageInteractiveSession(agent, child, { mode: "private" }), true);
  assert.equal(canManageInteractiveSession(agent, sibling, { mode: "private" }), false);
  assert.equal(canManageInteractiveSession(agent, forgedChild, { mode: "private" }), false);

  const foreign = interactiveSession(
    sessionRow({
      owner: "collaborator",
      owner_subject: "github:99",
      controller_subject: "github:42",
      control_expires_at: 200,
    }),
    [],
  );
  const inherited = interactiveSessionAccess(agent, foreign, 100, true, {
    mode: "private",
    grant: { subject: "github:42", role: "controller", expiresAt: 200 },
  });
  assert.equal(inherited.visible, false);
  assert.equal(inherited.control, false);

  const explicit = interactiveSessionAccess(agent, foreign, 100, true, {
    mode: "private",
    grant: { subject: "agent:IS-agent", role: "controller", expiresAt: 200 },
  });
  assert.equal(explicit.visible, true);
  assert.equal(explicit.control, true);
  assert.equal(explicit.manage, false);
});

test("shared tenancy honors named controller grants without granting management", () => {
  const foreign = interactiveSession(sessionRow({ owner: "other" }), []);
  assert.deepEqual(
    interactiveSessionAccess(user(), foreign, 100, true, {
      mode: "shared",
      grant: { subject: "github:42", role: "controller", expiresAt: 200 },
    }),
    {
      visible: true,
      manage: false,
      control: true,
      changeMultiplayer: false,
      role: "controller",
    },
  );
});

test("shared tenancy requires control or a named grant for live terminal reads", () => {
  const foreign = interactiveSession(sessionRow({ owner: "other" }), []);
  assert.equal(
    canReadInteractiveSessionTerminal(user(), foreign, 100, true, { mode: "shared" }),
    false,
  );
  assert.equal(
    canReadInteractiveSessionTerminal(user({ role: "maintainer" }), foreign, 100, true, {
      mode: "shared",
    }),
    true,
  );
  assert.equal(
    canReadInteractiveSessionTerminal(user(), foreign, 100, true, {
      mode: "shared",
      grant: { subject: "github:42", role: "viewer", expiresAt: 200 },
    }),
    true,
  );
});

test("private tenancy gives exact service creators lifecycle authority", () => {
  const created = interactiveSession(
    sessionRow({
      owner: "operator",
      owner_subject: "github:42",
      created_by: "service:openclaw",
    }),
    [],
  );
  const service = user({
    subject: "service:openclaw",
    login: "openclaw",
    email: null,
    role: "owner",
  });
  assert.deepEqual(interactiveSessionAccess(service, created, 100, true, { mode: "private" }), {
    visible: true,
    manage: true,
    control: true,
    changeMultiplayer: false,
    role: "owner",
  });
  assert.equal(
    interactiveSessionAccess(
      user({ subject: "service:other", login: "other", role: "owner" }),
      created,
      100,
      true,
      { mode: "private" },
    ).visible,
    false,
  );
});
