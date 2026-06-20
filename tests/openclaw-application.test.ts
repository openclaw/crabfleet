import assert from "node:assert/strict";
import test from "node:test";

import { openClawAuthorizedUser, openClawCreateUser } from "../src/worker/openclaw-application.ts";
import type { User } from "../src/worker/models.ts";
import { canManageInteractiveSession } from "../src/worker/session-access.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

test("validated OpenClaw descendants retain explicit service lifecycle authority", () => {
  const serviceUser: User = {
    subject: "service:openclaw",
    login: "openclaw",
    email: null,
    name: "OpenClaw",
    role: "owner",
    allowed: true,
    teams: [],
  };
  const child = interactiveSession(
    sessionRow({
      id: "IS-child",
      parent_session_id: "IS-root",
      root_session_id: "IS-root",
      created_by: "session:IS-root",
      owner: "operator",
      owner_subject: "",
    }),
    [],
  );

  const authorized = openClawAuthorizedUser(serviceUser, child);
  assert.equal(authorized.subject, "service:openclaw");
  assert.equal(canManageInteractiveSession(authorized, child, { mode: "private" }), true);
  assert.equal(canManageInteractiveSession(serviceUser, child, { mode: "private" }), false);
});

test("OpenClaw creation scopes service authority to a validated parent", async () => {
  const serviceUser: User = {
    subject: "service:openclaw",
    login: "openclaw",
    email: null,
    name: "OpenClaw",
    role: "owner",
    allowed: true,
    teams: [],
  };
  const parent = interactiveSession(
    sessionRow({
      id: "IS-child",
      parent_session_id: "IS-root",
      root_session_id: "IS-root",
      created_by: "session:IS-root",
      owner_subject: "github:42",
    }),
    [],
  );
  const calls: string[] = [];
  const authorized = await openClawCreateUser(
    serviceUser,
    { parentSessionId: parent.id },
    async (sessionId) => {
      calls.push(`read:${sessionId}`);
      return parent;
    },
    async (sessionId, rootSessionId) => {
      calls.push(`scope:${sessionId}:${rootSessionId}`);
      return parent;
    },
  );

  assert.deepEqual(calls, ["read:IS-child", "scope:IS-child:IS-root"]);
  assert.equal(canManageInteractiveSession(authorized, parent, { mode: "private" }), true);
});
