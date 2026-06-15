import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  canChangeInteractiveSessionMultiplayer,
  canControlInteractiveSession,
  canManageInteractiveSession,
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
