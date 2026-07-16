import assert from "node:assert/strict";
import test from "node:test";

import {
  attachDesktopRelayPeer,
  closeDesktopRelayPeers,
  desktopRelayMaximumBufferedBytes,
  desktopRelayMaximumMessageBytes,
  desktopRelayRole,
  desktopRelayShouldPropagateClose,
  flushDesktopRelayBuffer,
  relayDesktopMessage,
  replaceDesktopRelayPeer,
  type DesktopRelaySocket,
} from "../src/desktop-relay.ts";
import type {
  DesktopHostRow,
  DesktopRelayRegistration,
  DesktopRelayRegistrationStore,
} from "../src/worker/desktop-host-repository.ts";
import { desktopHostOwnershipHeader } from "../src/worker/desktop-host-service.ts";
import {
  DesktopRelayService,
  matchDesktopRelayRoute,
} from "../src/worker/desktop-relay-service.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { User } from "../src/worker/models.ts";

const alice: User = {
  subject: "github:1",
  login: "alice",
  email: null,
  name: "Alice",
  role: "viewer",
  allowed: true,
  teams: [],
};

const bob: User = { ...alice, subject: "github:2", login: "bob" };
const relayToken = "test-token-placeholder";

const registration: DesktopHostRow = {
  ownerSubject: alice.subject,
  id: "studio",
  owner: "alice",
  name: "Studio",
  address: "100.64.1.2",
  port: 5901,
  ownershipToken: relayToken,
  publicationID: "publication-id",
  createdAt: 1,
  updatedAt: 2,
};

class MemoryRegistrations implements DesktopRelayRegistrationStore {
  async findOwnedTokenRegistration(
    ownerSubject: string,
    id: string,
  ): Promise<DesktopRelayRegistration | null> {
    return ownerSubject === registration.ownerSubject && id === registration.id
      ? registration
      : null;
  }

  async findTokenRegistration(
    id: string,
    ownershipToken: string,
  ): Promise<DesktopRelayRegistration | null> {
    return id === registration.id && ownershipToken === registration.ownershipToken
      ? registration
      : null;
  }
}

function socket(readyState = 1): DesktopRelaySocket & {
  closed: Array<[number | undefined, string | undefined]>;
  sent: Array<string | ArrayBuffer>;
  attachment: unknown;
} {
  return {
    readyState,
    closed: [],
    sent: [],
    attachment: null,
    send(message) {
      this.sent.push(message);
    },
    close(code, reason) {
      this.closed.push([code, reason]);
      this.readyState = 3;
    },
    serializeAttachment(attachment) {
      this.attachment = attachment;
    },
    deserializeAttachment() {
      return this.attachment;
    },
  };
}

function relayEnvironment(calls: string[]): RuntimeEnv {
  return {
    DESKTOP_RELAY: {
      idFromName(name: string) {
        calls.push(`id:${name}`);
        return "relay-id";
      },
      get(id: string) {
        calls.push(`get:${id}`);
        return {
          async fetch(input: RequestInfo | URL, init?: RequestInit) {
            const request = new Request(input, init);
            calls.push(`fetch:${new URL(request.url).pathname}:${request.headers.get("upgrade")}`);
            return new Response(null, { status: 204 });
          },
        };
      },
    } as unknown as DurableObjectNamespace,
  } as RuntimeEnv;
}

function upgradeRequest(path: string, token?: string): Request {
  const headers = new Headers({ upgrade: "websocket" });
  if (token) headers.set(desktopHostOwnershipHeader, token);
  return new Request(`https://fleet.example${path}`, { headers });
}

function errorStatus(error: unknown): number | undefined {
  return typeof error === "object" && error && "status" in error ? Number(error.status) : undefined;
}

test("desktop relay replaces one peer per role and closes the other role on disconnect", () => {
  const oldHost = socket();
  attachDesktopRelayPeer(oldHost, "host");
  const stoppedHost = socket(3);
  assert.equal(replaceDesktopRelayPeer([oldHost, stoppedHost], "host"), 1);
  assert.deepEqual(oldHost.closed, [[1000, "host replaced"]]);
  assert.equal(desktopRelayShouldPropagateClose(oldHost), false);

  const viewer = socket();
  attachDesktopRelayPeer(viewer, "viewer");
  assert.equal(closeDesktopRelayPeers([viewer], "host"), 1);
  assert.deepEqual(viewer.closed, [[1000, "host disconnected"]]);
  assert.equal(desktopRelayShouldPropagateClose(viewer), false);
  assert.equal(desktopRelayRole(["desktop-relay-host"]), "host");
  assert.equal(desktopRelayRole(["desktop-relay-viewer"]), "viewer");
  assert.equal(desktopRelayRole([]), null);
});

test("desktop relay tears down pairings retained during closing handshakes", () => {
  const closingHost = socket(2);
  attachDesktopRelayPeer(closingHost, "host");
  assert.equal(replaceDesktopRelayPeer([closingHost], "host"), 1);
  assert.deepEqual(closingHost.closed, []);
  assert.equal(desktopRelayShouldPropagateClose(closingHost), false);

  const closingViewer = socket(2);
  attachDesktopRelayPeer(closingViewer, "viewer");
  assert.equal(closeDesktopRelayPeers([closingViewer], "host"), 1);
  assert.deepEqual(closingViewer.closed, []);
  assert.equal(desktopRelayShouldPropagateClose(closingViewer), false);

  const closedHost = socket(3);
  attachDesktopRelayPeer(closedHost, "host");
  assert.equal(replaceDesktopRelayPeer([closedHost], "host"), 0);
  assert.equal(desktopRelayShouldPropagateClose(closedHost), true);
});

test("desktop relay passes binary messages verbatim in either direction", () => {
  const host = socket();
  const viewer = socket();
  attachDesktopRelayPeer(host, "host");
  attachDesktopRelayPeer(viewer, "viewer");
  const hostBytes = new Uint8Array([0, 1, 2, 255]).buffer;
  const viewerBytes = new Uint8Array([9, 8, 7]).buffer;

  assert.equal(relayDesktopMessage(host, hostBytes, [viewer]), 1);
  assert.equal(relayDesktopMessage(viewer, viewerBytes, [host]), 1);
  assert.equal(viewer.sent[0], hostBytes);
  assert.equal(host.sent[0], viewerBytes);
});

test("desktop relay buffers the server-first banner until a viewer connects", () => {
  const host = socket();
  attachDesktopRelayPeer(host, "host");
  const banner = new TextEncoder().encode("RFB 003.008\n").buffer;

  assert.equal(relayDesktopMessage(host, banner, []), 0);
  const viewer = socket();
  attachDesktopRelayPeer(viewer, "viewer");
  assert.equal(flushDesktopRelayBuffer(host, viewer), 1);
  assert.deepEqual(new Uint8Array(viewer.sent[0] as ArrayBuffer), new Uint8Array(banner));
  assert.equal(flushDesktopRelayBuffer(host, viewer), 0);
});

test("desktop relay rejects text and messages over 512 KiB", () => {
  const textSender = socket();
  attachDesktopRelayPeer(textSender, "host");
  assert.equal(relayDesktopMessage(textSender, "not-rfb", [socket()]), 0);
  assert.deepEqual(textSender.closed, [[1003, "binary messages required"]]);

  const oversizedSender = socket();
  attachDesktopRelayPeer(oversizedSender, "host");
  const oversized = new ArrayBuffer(desktopRelayMaximumMessageBytes + 1);
  assert.equal(relayDesktopMessage(oversizedSender, oversized, [socket()]), 0);
  assert.deepEqual(oversizedSender.closed, [[1009, "relay message exceeds 512 KiB"]]);

  const bufferedSender = socket();
  attachDesktopRelayPeer(bufferedSender, "host");
  assert.equal(
    relayDesktopMessage(bufferedSender, new ArrayBuffer(desktopRelayMaximumBufferedBytes), []),
    0,
  );
  assert.equal(relayDesktopMessage(bufferedSender, new ArrayBuffer(1), []), 0);
  assert.deepEqual(bufferedSender.closed, [[1009, "relay pre-peer buffer exceeded"]]);
});

test("desktop relay host requires the current token-aware registration", async () => {
  const calls: string[] = [];
  const service = new DesktopRelayService(relayEnvironment(calls), new MemoryRegistrations());
  const path = "/api/desktop-hosts/studio/relay/host";

  await assert.rejects(service.openHost(upgradeRequest(path), "studio"), (error) => {
    assert.equal(errorStatus(error), 401);
    return true;
  });
  await assert.rejects(service.openHost(upgradeRequest(path, "wrong-token"), "studio"), (error) => {
    assert.equal(errorStatus(error), 403);
    return true;
  });

  assert.equal(
    (await service.openHost(upgradeRequest(path, registration.ownershipToken), "studio")).status,
    204,
  );
  assert.deepEqual(calls, [
    "id:github:1:studio",
    "get:relay-id",
    "fetch:/api/desktop-relay/host:websocket",
  ]);
});

test("desktop relay viewer is scoped to the authenticated tenant", async () => {
  const calls: string[] = [];
  const service = new DesktopRelayService(relayEnvironment(calls), new MemoryRegistrations());
  const request = upgradeRequest("/api/desktop-hosts/studio/relay/viewer");

  await assert.rejects(service.openViewer(request, bob, "studio"), (error) => {
    assert.equal(errorStatus(error), 404);
    return true;
  });
  assert.equal((await service.openViewer(request, alice, "studio")).status, 204);
  assert.deepEqual(calls, [
    "id:github:1:studio",
    "get:relay-id",
    "fetch:/api/desktop-relay/viewer:websocket",
  ]);
});

test("desktop relay route parsing preserves encoded host identifiers", () => {
  assert.deepEqual(
    matchDesktopRelayRoute(
      new URL("https://fleet.example/api/desktop-hosts/studio%2Done/relay/viewer"),
    ),
    { hostID: "studio-one", role: "viewer" },
  );
  assert.equal(
    matchDesktopRelayRoute(new URL("https://fleet.example/api/desktop-hosts/studio")),
    null,
  );
});
