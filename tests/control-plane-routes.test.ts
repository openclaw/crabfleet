import assert from "node:assert/strict";
import test from "node:test";

import type { User } from "../src/worker/models.ts";
import {
  handleControlPlaneRoute,
  type ControlPlaneRouteDependencies,
} from "../src/worker/routes/control-plane.ts";

const viewer: User = {
  subject: "github:1",
  login: "viewer",
  email: null,
  name: "Viewer",
  role: "viewer",
  allowed: true,
  teams: [],
};

const maintainer: User = {
  ...viewer,
  subject: "github:2",
  login: "maintainer",
  role: "maintainer",
};

const owner: User = {
  ...maintainer,
  subject: "github:3",
  login: "owner",
  role: "owner",
};

function dependencies(calls: string[]): ControlPlaneRouteDependencies {
  return {
    async readState(_request, user) {
      calls.push(`state:${user.login}`);
      return { handler: "state" };
    },
    async readFleet(user) {
      calls.push(`fleet:${user.login}`);
      return { handler: "fleet" };
    },
    async registerDesktopHost(user, id, input) {
      calls.push(`desktop-host:register:${user.login}:${id}:${input.name}`);
      return {
        host: {
          id,
          owner: user.login ?? user.subject,
          name: String(input.name),
          address: String(input.address),
          port: Number(input.port),
          createdAt: 1,
          updatedAt: 1,
        },
        ownershipToken: "ownership-token",
      };
    },
    async removeDesktopHost(user, id, ownershipToken) {
      calls.push(`desktop-host:remove:${user.login}:${id}:${ownershipToken ?? "legacy"}`);
    },
    async searchGitHubRefs(number) {
      calls.push(`github-refs:${number}`);
      return { handler: "github-refs" };
    },
    async createCard(_request, user) {
      calls.push(`card:create:${user.login}`);
      return { handler: "card:create" };
    },
    async readCardRuns(user, cardId) {
      calls.push(`card:runs:${user.login}:${cardId}`);
      return [{ id: "run-1" }];
    },
    async mutateCard(user, cardId, action) {
      calls.push(`card:mutate:${user.login}:${cardId}:${action}`);
      return { handler: "card:mutate" };
    },
    async runRecurringCardScheduler() {
      calls.push("scheduler:tick");
      return { status: "ok" };
    },
    async updatePolicy(input, user) {
      calls.push(`policy:${user.login}:${input.cap}`);
    },
    async evaluateWorkflow(input, user) {
      calls.push(`workflow:${user.login}:${input.repo}`);
    },
    async addAllowEntry(input, user) {
      calls.push(`allow:add:${user.login}:${input.value}:${input.role}`);
    },
    async removeAllowEntry(user, entry) {
      calls.push(`allow:remove:${user.login}:${entry}`);
    },
    async addRepo(input, user) {
      calls.push(`repo:add:${user.login}:${input.repo}`);
    },
    async removeRepo(user, repo) {
      calls.push(`repo:remove:${user.login}:${repo}`);
    },
  };
}

function request(method: string, path: string, body?: Record<string, unknown>): Request {
  return new Request(`https://fleet.example${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

async function dispatch(
  value: Request,
  user: User,
  calls: string[],
  overrides?: Partial<ControlPlaneRouteDependencies>,
): Promise<Response | null> {
  return handleControlPlaneRoute(value, new URL(value.url), user, {
    ...dependencies(calls),
    ...overrides,
  });
}

function status(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : undefined;
}

test("control-plane read and card routes enforce their role boundaries", async () => {
  const cases: Array<[Request, User, number, string[]]> = [
    [request("GET", "/api/state"), viewer, 200, ["state:viewer"]],
    [request("GET", "/api/fleet"), viewer, 200, ["fleet:viewer"]],
    [request("GET", "/api/github/refs?number=42"), maintainer, 200, ["github-refs:42"]],
    [request("POST", "/api/cards", {}), maintainer, 201, ["card:create:maintainer"]],
    [request("GET", "/api/cards/card%2F1/runs"), viewer, 200, ["card:runs:viewer:card/1"]],
  ];

  for (const [value, user, expectedStatus, expectedCalls] of cases) {
    const calls: string[] = [];
    assert.equal((await dispatch(value, user, calls))?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
  }

  await assert.rejects(dispatch(request("GET", "/api/github/refs"), viewer, []), (error) => {
    assert.equal(status(error), 403);
    return true;
  });
  await assert.rejects(dispatch(request("POST", "/api/cards", {}), viewer, []), (error) => {
    assert.equal(status(error), 403);
    return true;
  });
});

test("desktop host routes register and remove only the authenticated user's host", async () => {
  const calls: string[] = [];
  const registered = await dispatch(
    request("PUT", "/api/desktop-hosts/mac%2Dstudio", {
      name: "Mac Studio",
      address: "100.64.1.2",
      port: 5901,
    }),
    viewer,
    calls,
  );
  assert.equal(registered?.status, 200);
  assert.deepEqual(await registered?.json(), {
    host: {
      id: "mac-studio",
      owner: "viewer",
      name: "Mac Studio",
      address: "100.64.1.2",
      port: 5901,
      createdAt: 1,
      updatedAt: 1,
    },
    ownershipToken: "ownership-token",
  });

  const removed = await dispatch(
    new Request("https://fleet.example/api/desktop-hosts/mac%2Dstudio", {
      method: "DELETE",
      headers: { "x-crabfleet-ownership-token": "ownership-token" },
    }),
    viewer,
    calls,
  );
  assert.equal(removed?.status, 200);
  assert.deepEqual(calls, [
    "desktop-host:register:viewer:mac-studio:Mac Studio",
    "desktop-host:remove:viewer:mac-studio:ownership-token",
  ]);

  const legacyCalls: string[] = [];
  const legacyRemoved = await dispatch(
    request("DELETE", "/api/desktop-hosts/legacy%2Dstudio"),
    viewer,
    legacyCalls,
  );
  assert.equal(legacyRemoved?.status, 200);
  assert.deepEqual(legacyCalls, ["desktop-host:remove:viewer:legacy-studio:legacy"]);
});

test("card actions derive viewer or maintainer authorization from the action", async () => {
  for (const action of ["attach", "watch"]) {
    const calls: string[] = [];
    assert.equal(
      (await dispatch(request("POST", "/api/cards/card%2F1/actions", { action }), viewer, calls))
        ?.status,
      200,
    );
    assert.deepEqual(calls, [`card:mutate:viewer:card/1:${action}`]);
  }

  await assert.rejects(
    dispatch(request("POST", "/api/cards/card-1/actions", { action: "start" }), viewer, []),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );

  const calls: string[] = [];
  assert.equal(
    (
      await dispatch(
        request("POST", "/api/cards/card-1/actions", { action: "start" }),
        maintainer,
        calls,
      )
    )?.status,
    200,
  );
  assert.deepEqual(calls, ["card:mutate:maintainer:card-1:start"]);
});

test("control-plane admin routes are owner-only and decode path identities", async () => {
  const cases: Array<[Request, number, string[]]> = [
    [request("POST", "/api/admin/scheduler/tick"), 200, ["scheduler:tick"]],
    [request("PUT", "/api/admin/policy", { cap: 42 }), 200, ["policy:owner:42", "state:owner"]],
    [
      request("POST", "/api/admin/workflows/evaluate", { repo: "openclaw/crabfleet" }),
      200,
      ["workflow:owner:openclaw/crabfleet", "state:owner"],
    ],
    [
      request("POST", "/api/admin/allow", { value: "team/core", role: "viewer" }),
      201,
      ["allow:add:owner:team/core:viewer", "state:owner"],
    ],
    [
      request("DELETE", "/api/admin/allow/team%2Fcore"),
      200,
      ["allow:remove:owner:team/core", "state:owner"],
    ],
    [
      request("POST", "/api/admin/repos", { repo: "openclaw/crabfleet" }),
      201,
      ["repo:add:owner:openclaw/crabfleet", "state:owner"],
    ],
    [
      request("DELETE", "/api/admin/repos/openclaw%2Fcrabfleet"),
      200,
      ["repo:remove:owner:openclaw/crabfleet", "state:owner"],
    ],
  ];

  for (const [value, expectedStatus, expectedCalls] of cases) {
    const calls: string[] = [];
    assert.equal((await dispatch(value, owner, calls))?.status, expectedStatus);
    assert.deepEqual(calls, expectedCalls);
  }

  await assert.rejects(
    dispatch(request("PUT", "/api/admin/policy", {}), maintainer, []),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );
  await assert.rejects(
    dispatch(request("POST", "/api/admin/scheduler/tick"), maintainer, []),
    (error) => {
      assert.equal(status(error), 403);
      return true;
    },
  );
});

test("control-plane routes report missing cards and exact fallthrough", async () => {
  const calls: string[] = [];
  await assert.rejects(
    dispatch(request("GET", "/api/cards/missing/runs"), viewer, calls, {
      readCardRuns: async (user, cardId) => {
        calls.push(`card:runs:${user.login}:${cardId}`);
        return null;
      },
    }),
    (error) => {
      assert.equal(status(error), 404);
      return true;
    },
  );
  assert.deepEqual(calls, ["card:runs:viewer:missing"]);

  const fallthroughCalls: string[] = [];
  for (const value of [
    request("POST", "/api/state", {}),
    request("GET", "/api/cards"),
    request("GET", "/api/cards/card-1/actions"),
    request("DELETE", "/api/admin/allow"),
    request("GET", "/api/admin/repos/openclaw/crabfleet"),
  ]) {
    assert.equal(await dispatch(value, owner, fallthroughCalls), null);
  }
  assert.deepEqual(fallthroughCalls, []);
});
