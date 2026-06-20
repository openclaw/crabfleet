import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  InteractiveSessionGrantService,
  type InteractiveSessionGrantServiceStore,
} from "../src/worker/session-grant-service.ts";
import type { InteractiveSessionGrant } from "../src/worker/session-grant-repository.ts";
import { interactiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const owner: User = {
  subject: "proxy:owner@example.test",
  login: null,
  email: "owner@example.test",
  name: "Owner",
  role: "maintainer",
  allowed: true,
  teams: [],
};

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

function fixture(
  options: {
    canManage?: boolean;
    status?: "ready" | "stopping";
    upsertAccepted?: boolean;
    failCommittedBookkeeping?: boolean;
  } = {},
) {
  const grants: InteractiveSessionGrant[] = [];
  const calls: string[] = [];
  const session = interactiveSession(
    sessionRow({
      id: "IS-42",
      owner: "owner@example.test",
      owner_subject: owner.subject,
      status: options.status ?? "ready",
    }),
    [],
  );
  const store: InteractiveSessionGrantServiceStore = {
    async readSession(sessionId) {
      calls.push(`read:${sessionId}`);
      return session;
    },
    async canManage(user, current) {
      calls.push(`manage:${user.subject}:${current.id}`);
      return options.canManage ?? true;
    },
    async resolvePrincipal(value) {
      calls.push(`resolve:${value}`);
      if (value === "owner@example.test") {
        return { subject: owner.subject, principal: "owner@example.test", actor: "owner" };
      }
      return value === "collaborator@example.test"
        ? {
            subject: "proxy:collaborator@example.test",
            principal: "collaborator@example.test",
            actor: "collaborator@example.test",
          }
        : null;
    },
    async list(sessionId) {
      calls.push(`list:${sessionId}`);
      if (options.failCommittedBookkeeping && grants.length) throw new Error("list failed");
      return [...grants];
    },
    async upsert(input) {
      calls.push(`upsert:${input.subject}:${input.role}:${input.expiresAt}`);
      if (options.upsertAccepted === false) return false;
      const next: InteractiveSessionGrant = {
        sessionId: input.sessionId,
        subject: input.subject,
        principal: input.principal,
        role: input.role,
        createdBySubject: input.createdBySubject,
        expiresAt: input.expiresAt,
        createdAt: input.now,
        updatedAt: input.now,
      };
      const existing = grants.findIndex((grant) => grant.subject === input.subject);
      if (existing >= 0) grants[existing] = next;
      else grants.push(next);
      return true;
    },
    async revoke(sessionId, subject) {
      calls.push(`revoke:${sessionId}:${subject}`);
      const index = grants.findIndex((grant) => grant.subject === subject);
      if (index < 0) return false;
      grants.splice(index, 1);
      return true;
    },
    async appendEvent(sessionId, actorName, message, now) {
      calls.push(`event:${sessionId}:${actorName}:${message}:${now}`);
      if (options.failCommittedBookkeeping) throw new Error("event failed");
    },
    async audit(user, message, now) {
      calls.push(`audit:${user.subject}:${message}:${now}`);
      if (options.failCommittedBookkeeping) throw new Error("audit failed");
    },
    warn(event) {
      calls.push(`warn:${event.operation}:${event.stage}`);
    },
    now: () => 1_000,
  };
  return { service: new InteractiveSessionGrantService(store), grants, calls };
}

test("session owners grant bounded viewer or controller access", async () => {
  const { service, grants, calls } = fixture();
  const result = await service.grant(owner, "IS-42", {
    principal: " collaborator@example.test ",
    role: "controller",
    expiresInSeconds: 600,
  });

  assert.equal(result.grants.length, 1);
  assert.deepEqual(grants[0], {
    sessionId: "IS-42",
    subject: "proxy:collaborator@example.test",
    principal: "collaborator@example.test",
    role: "controller",
    createdBySubject: owner.subject,
    expiresAt: 601_000,
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  assert.deepEqual(calls, [
    "read:IS-42",
    `manage:${owner.subject}:IS-42`,
    "resolve:collaborator@example.test",
    "upsert:proxy:collaborator@example.test:controller:601000",
    "event:IS-42:owner@example.test:named controller access granted:1000",
    `audit:${owner.subject}:interactive session access granted IS-42 to proxy:collaborator@example.test role=controller:1000`,
    "list:IS-42",
  ]);
});

test("grant creation fails when teardown wins the repository fence", async () => {
  const { service, calls, grants } = fixture({ upsertAccepted: false });
  await assert.rejects(
    service.grant(owner, "IS-42", {
      principal: "collaborator@example.test",
      role: "viewer",
    }),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );
  assert.deepEqual(grants, []);
  assert.deepEqual(calls, [
    "read:IS-42",
    `manage:${owner.subject}:IS-42`,
    "resolve:collaborator@example.test",
    "upsert:proxy:collaborator@example.test:viewer:86401000",
  ]);
});

test("committed access remains a reported success when bookkeeping fails", async () => {
  const { service, grants, calls } = fixture({ failCommittedBookkeeping: true });
  const result = await service.grant(owner, "IS-42", {
    principal: "collaborator@example.test",
    role: "viewer",
  });

  assert.equal(grants.length, 1);
  assert.deepEqual(result.grants, grants);
  assert.ok(calls.includes("warn:grant:event"));
  assert.ok(calls.includes("warn:grant:audit"));
  assert.ok(calls.includes("warn:grant:list"));
});

test("grant management is concealed from non-owners and new grants stop during teardown", async () => {
  const hidden = fixture({ canManage: false });
  await assert.rejects(hidden.service.list(owner, "IS-42"), (error) => {
    assert.equal(status(error), 404);
    return true;
  });
  assert.deepEqual(hidden.calls, ["read:IS-42", `manage:${owner.subject}:IS-42`]);

  const stopping = fixture({ status: "stopping" });
  await assert.rejects(
    stopping.service.grant(owner, "IS-42", {
      principal: "collaborator@example.test",
      role: "viewer",
    }),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );
  assert.deepEqual(await stopping.service.list(owner, "IS-42"), { grants: [] });
});

test("session owners can revoke existing access during teardown", async () => {
  const stopping = fixture({ status: "stopping" });
  const longSubject = `proxy:${"a".repeat(320)}`;
  stopping.grants.push({
    sessionId: "IS-42",
    subject: longSubject,
    principal: "collaborator@example.test",
    role: "viewer",
    createdBySubject: owner.subject,
    expiresAt: 10_000,
    createdAt: 1_000,
    updatedAt: 1_000,
  });

  assert.deepEqual(await stopping.service.revoke(owner, "IS-42", longSubject), { grants: [] });
  assert.deepEqual(stopping.grants, []);
});

test("grant validation rejects ambiguous principals, self-access, roles, and durations", async () => {
  for (const input of [
    { principal: "missing@example.test", role: "viewer" },
    { principal: "collaborator@example.test", role: "owner" },
    { principal: "collaborator@example.test", role: "viewer", expiresInSeconds: 299 },
    { principal: "collaborator@example.test", role: "viewer", expiresInSeconds: 2_592_001 },
  ]) {
    await assert.rejects(fixture().service.grant(owner, "IS-42", input), (error) => {
      assert.equal(status(error), 400);
      return true;
    });
  }

  const self = fixture();
  await assert.rejects(
    self.service.grant(owner, "IS-42", { principal: "owner@example.test", role: "viewer" }),
    (error) => {
      assert.equal(status(error), 400);
      return true;
    },
  );
});

test("revocation removes access and records an audit trail", async () => {
  const { service, grants, calls } = fixture();
  await service.grant(owner, "IS-42", {
    principal: "collaborator@example.test",
    role: "viewer",
  });
  calls.length = 0;
  const result = await service.revoke(owner, "IS-42", "proxy:collaborator@example.test");

  assert.deepEqual(result, { grants: [] });
  assert.deepEqual(grants, []);
  assert.deepEqual(calls, [
    "read:IS-42",
    `manage:${owner.subject}:IS-42`,
    "revoke:IS-42:proxy:collaborator@example.test",
    "event:IS-42:owner@example.test:named access revoked:1000",
    `audit:${owner.subject}:interactive session access revoked IS-42 from proxy:collaborator@example.test:1000`,
    "list:IS-42",
  ]);

  await assert.rejects(
    service.revoke(owner, "IS-42", "proxy:collaborator@example.test"),
    (error) => {
      assert.equal(status(error), 404);
      return true;
    },
  );
});
