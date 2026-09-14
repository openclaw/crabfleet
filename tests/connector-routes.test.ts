import assert from "node:assert/strict";
import test from "node:test";
import { handleConnectorRoute } from "../src/worker/routes/connector.ts";
import { connectorAccessScope, type NativeAuthService } from "../src/worker/native-auth.ts";
import type { DesktopHostService } from "../src/worker/desktop-host-service.ts";
import type { User } from "../src/worker/models.ts";

const user: User = {
  subject: "github:1",
  login: "alice",
  email: null,
  name: "Alice",
  role: "viewer",
  allowed: true,
  teams: [],
};

test("connector routes require the publication scope and fence recovery and cleanup", async () => {
  const calls: unknown[][] = [];
  const auth = {
    async authenticate(_request: Request, scope: string) {
      assert.equal(scope, connectorAccessScope);
      return user;
    },
    async renewConnector() {
      return { expiresAt: 123 };
    },
  } as unknown as NativeAuthService;
  const hosts = {
    async register(...args: unknown[]) {
      calls.push(args);
      return { ownershipToken: "fixture" };
    },
    async recover(...args: unknown[]) {
      calls.push(args);
      return { ownershipToken: "fixture" };
    },
    async remove(...args: unknown[]) {
      calls.push(args);
    },
  } as unknown as DesktopHostService;
  const invoke = (
    path: string,
    method: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const request = new Request(`https://fleet.example${path}`, {
      method,
      headers: { authorization: "Bearer fixture", "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return handleConnectorRoute(request, new URL(request.url), { kind: "none" }, auth, hosts);
  };
  const input = { name: "Linux", relayOnly: true };
  assert.equal(
    (
      await invoke("/api/connector/v1/desktop-hosts/linux", "PUT", input, {
        "x-crabfleet-publication-id": "publication-1",
      })
    )?.status,
    200,
  );
  assert.deepEqual(calls.shift(), [user, "linux", input, "token-v1", "publication-1"]);
  await invoke("/api/connector/v1/desktop-hosts/linux/recover", "POST", undefined, {
    "x-crabfleet-publication-id": "publication-1",
  });
  assert.deepEqual(calls.shift(), [user, "linux", "publication-1"]);
  await assert.rejects(
    invoke("/api/connector/v1/desktop-hosts/linux", "DELETE"),
    /ownership token/,
  );
  await invoke("/api/connector/v1/desktop-hosts/linux", "DELETE", undefined, {
    "x-crabfleet-ownership-token": "owner-1",
  });
  assert.deepEqual(calls.shift(), [user, "linux", "owner-1"]);
  assert.deepEqual(await (await invoke("/api/connector/v1/auth/renew", "POST"))?.json(), {
    expiresAt: 123,
  });
  assert.equal(await invoke("/api/unrelated", "GET"), null);
});
