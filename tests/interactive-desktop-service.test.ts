import assert from "node:assert/strict";
import test from "node:test";

import { runtimeAdapterName } from "../src/runtime-adapter.ts";
import {
  InteractiveDesktopService,
  type InteractiveDesktopServiceDependencies,
} from "../src/worker/interactive-desktop-service.ts";
import type { User } from "../src/worker/models.ts";
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

function desktopSession(values: Parameters<typeof sessionRow>[0] = {}): InteractiveSession {
  return interactiveSession(
    sessionRow({
      adapter: runtimeAdapterName,
      adapter_workspace_id: "workspace-1",
      capabilities_json: JSON.stringify({ desktop: true, vnc: true }),
      created_by: owner.subject,
      owner: owner.subject,
      profile: "desktop",
      runtime: "crabbox",
      ...values,
    }),
    [],
  );
}

function dependencies(
  calls: string[],
  session: InteractiveSession | null = desktopSession(),
): InteractiveDesktopServiceDependencies {
  return {
    now: () => 100,
    async readFreshSession(sessionId) {
      calls.push(`read:${sessionId}`);
      return session;
    },
    delegatedControlAvailable(current) {
      calls.push(`delegate:${current.id}`);
      return true;
    },
    async resolveControlPlane(sessionId, workspaceId) {
      calls.push(`resolve:${sessionId}:${workspaceId}`);
      return "https://controller.example";
    },
    async mintConnection(current, controlPlane) {
      calls.push(`mint:${current.id}:${controlPlane}`);
      return {
        ok: true,
        status: 200,
        body: {
          url: "https://desktop.example/session?ticket=short-lived",
          expiresAt: 500,
        },
      };
    },
    async hasCurrentAccess(user, current, controlPlane) {
      calls.push(`revalidate:${user.login}:${current.id}:${controlPlane}`);
      return true;
    },
  };
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("desktop access mints then revalidates before redirect", async () => {
  const calls: string[] = [];
  const response = await new InteractiveDesktopService(dependencies(calls)).open(owner, "IS-42");

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("location"),
    "https://desktop.example/session?ticket=short-lived",
  );
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.deepEqual(calls, [
    "read:IS-42",
    "delegate:IS-42",
    "resolve:IS-42:workspace-1",
    "mint:IS-42:https://controller.example",
    "revalidate:owner:IS-42:https://controller.example",
  ]);
});

test("desktop access rejects non-adapter sessions without legacy URL fallback", async () => {
  const calls: string[] = [];
  const session = desktopSession({
    adapter: null,
    adapter_workspace_id: null,
    vnc_url: "https://legacy.example/vnc",
  });

  await assert.rejects(
    () => new InteractiveDesktopService(dependencies(calls, session)).open(owner, "IS-42"),
    (error) => {
      assert.equal(status(error), 400);
      assert.match(String(error), /requires a runtime adapter session/);
      return true;
    },
  );
  assert.deepEqual(calls, ["read:IS-42", "delegate:IS-42"]);
});

test("desktop access fails closed when authorization changes after mint", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls);
  serviceDependencies.hasCurrentAccess = async (user, current, controlPlane) => {
    calls.push(`revalidate:${user.login}:${current.id}:${controlPlane}`);
    return false;
  };

  await assert.rejects(
    () => new InteractiveDesktopService(serviceDependencies).open(owner, "IS-42"),
    (error) => {
      assert.equal(status(error), 403);
      assert.match(String(error), /authorization changed/);
      return true;
    },
  );
  assert.equal(calls.at(-1), "revalidate:owner:IS-42:https://controller.example");
});

test("desktop access rejects invalid connection expiry before revalidation", async () => {
  const calls: string[] = [];
  const serviceDependencies = dependencies(calls);
  serviceDependencies.mintConnection = async (current, controlPlane) => {
    calls.push(`mint:${current.id}:${controlPlane}`);
    return {
      ok: true,
      status: 200,
      body: {
        url: "https://desktop.example/session",
        expiresAt: 0,
      },
    };
  };

  await assert.rejects(
    () => new InteractiveDesktopService(serviceDependencies).open(owner, "IS-42"),
    (error) => {
      assert.equal(status(error), 503);
      assert.match(String(error), /invalid expiry/);
      return true;
    },
  );
  assert.equal(
    calls.some((call) => call.startsWith("revalidate:")),
    false,
  );
});
