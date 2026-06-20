import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  SandboxSessionResourceService,
  type SandboxSessionResourceServiceDependencies,
} from "../src/worker/sandbox-session-resource-service.ts";
import type { SandboxCheckpoint } from "../src/worker/session-control-do.ts";
import { interactiveSession, type InteractiveSession } from "../src/worker/session-model.ts";
import { sessionRow } from "./helpers/session-row.ts";

const owner: User = {
  subject: "github:1",
  login: "owner",
  email: null,
  name: "Owner",
  role: "viewer",
  allowed: true,
  teams: [],
};

const backup = { id: "backup-1" } as SandboxCheckpoint["backup"];

function sandboxSession(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(
    sessionRow({
      created_by: owner.subject,
      lease_id: "sandbox:sandbox-1:terminal-1:autostart-v4",
      owner: owner.subject,
      ...values,
    }),
    [],
  );
}

function dependencies(
  calls: string[],
  session: InteractiveSession | null = sandboxSession(),
): SandboxSessionResourceServiceDependencies {
  return {
    now: () => 100,
    sandboxAvailable: true,
    async readSession(sessionId) {
      calls.push(`read:${sessionId}`);
      return session;
    },
    async presentSession(current, user) {
      calls.push(`present:${current.id}:${user.login}`);
      return { ...current, summary: "presented" };
    },
    async canView(user, current) {
      calls.push(`view:${user.login}:${current.id}`);
      return true;
    },
    async canControl(user, current) {
      calls.push(`control:${user.login}:${current.id}`);
      return true;
    },
    async canManage(user, current) {
      calls.push(`manage:${user.login}:${current.id}`);
      return true;
    },
    async runDiagnostics(current, workdir, script) {
      calls.push(`diagnostics:${current.id}:${workdir}:${script.includes("toolResults")}`);
      return { success: true, stdout: '{"available":true}', stderr: "" };
    },
    async listStoredCheckpoints(sessionId) {
      calls.push(`list:${sessionId}`);
      return [];
    },
    async storeCheckpoint(checkpoint) {
      calls.push(`store:${checkpoint.id}:${checkpoint.name}`);
    },
    async readStoredCheckpoint(sessionId, checkpointId) {
      calls.push(`checkpoint:${sessionId}:${checkpointId}`);
      return {
        backup,
        createdAt: 90,
        id: checkpointId,
        name: "checkpoint-90",
        sessionId,
        workdir: "/workspace/crabbox-is-42",
      };
    },
    async createBackup(current, workdir, name) {
      calls.push(`backup:create:${current.id}:${workdir}:${name}`);
      return backup;
    },
    async restoreBackup(current, storedBackup) {
      calls.push(`backup:restore:${current.id}:${storedBackup.id}`);
    },
    async appendEvent(sessionId, user, message, now) {
      calls.push(`event:${sessionId}:${user.login}:${message}:${now}`);
    },
  };
}

test("Sandbox checkpoint creation stores backup before durable evidence", async () => {
  const calls: string[] = [];
  const result = await new SandboxSessionResourceService(dependencies(calls)).createCheckpoint(
    owner,
    "IS-42",
  );

  assert.deepEqual(result.checkpoint, {
    createdAt: 100,
    id: "backup-1",
    name: "checkpoint-100",
    sessionId: "IS-42",
    workdir: "/workspace/crabbox-is-42",
  });
  assert.equal("backup" in result.checkpoint, false);
  assert.equal(result.session.summary, "presented");
  assert.deepEqual(calls, [
    "read:IS-42",
    "view:owner:IS-42",
    "manage:owner:IS-42",
    "backup:create:IS-42:/workspace/crabbox-is-42:checkpoint-100",
    "store:backup-1:checkpoint-100",
    "event:IS-42:owner:checkpoint created backup-1 in sandbox-1:100",
    "present:IS-42:owner",
  ]);
});

test("Sandbox checkpoint restore reads registry before provider mutation", async () => {
  const calls: string[] = [];
  const result = await new SandboxSessionResourceService(dependencies(calls)).restoreCheckpoint(
    owner,
    "IS-42",
    "backup-1",
  );

  assert.equal(result.checkpoint.id, "backup-1");
  assert.equal("backup" in result.checkpoint, false);
  assert.deepEqual(calls, [
    "read:IS-42",
    "view:owner:IS-42",
    "manage:owner:IS-42",
    "checkpoint:IS-42:backup-1",
    "backup:restore:IS-42:backup-1",
    "event:IS-42:owner:checkpoint restored backup-1:100",
    "present:IS-42:owner",
  ]);
});

test("Sandbox diagnostics parse provider output and retain invalid output evidence", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls);
  serviceDependencies.runDiagnostics = async (current, workdir, script) => {
    calls.push(`diagnostics:${current.id}:${workdir}:${script.includes("toolResults")}`);
    return { success: true, stdout: "not-json", stderr: "" };
  };
  const result = await new SandboxSessionResourceService(serviceDependencies).readDiagnostics(
    owner,
    "IS-42",
  );

  assert.deepEqual(result.diagnostics, {
    available: false,
    reason: "diagnostics returned invalid JSON",
    output: "not-json",
  });
  assert.deepEqual(calls, [
    "read:IS-42",
    "view:owner:IS-42",
    "control:owner:IS-42",
    "present:IS-42:owner",
    "diagnostics:IS-42:/workspace/crabbox-is-42:true",
  ]);
});

test("Sandbox diagnostics reject teardown states before provider work", async () => {
  for (const status of ["stopping", "stopped", "expired", "failed"] as const) {
    const calls: string[] = [];
    const service = new SandboxSessionResourceService(
      dependencies(calls, sandboxSession({ status })),
    );

    await assert.rejects(() => service.readDiagnostics(owner, "IS-42"), {
      message: `session is ${status}`,
    });
    assert.deepEqual(calls, ["read:IS-42", "view:owner:IS-42", "control:owner:IS-42"]);
  }
});

test("non-Sandbox diagnostics return unavailable without provider work", async () => {
  const calls: string[] = [];
  const session = sandboxSession({ lease_id: null });
  const result = await new SandboxSessionResourceService(
    dependencies(calls, session),
  ).readDiagnostics(owner, "IS-42");

  assert.deepEqual(result.diagnostics, {
    available: false,
    reason: "diagnostics are only available for Cloudflare Sandbox sessions",
  });
  assert.equal(
    calls.some((call) => call.startsWith("diagnostics:")),
    false,
  );
  assert.deepEqual(calls, [
    "read:IS-42",
    "view:owner:IS-42",
    "control:owner:IS-42",
    "present:IS-42:owner",
  ]);
});
