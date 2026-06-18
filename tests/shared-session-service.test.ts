import assert from "node:assert/strict";
import test from "node:test";

import { interactiveSession } from "../src/worker/session-model.ts";
import {
  SharedSessionService,
  type SharedSessionServiceStore,
} from "../src/worker/shared-session-service.ts";
import { sessionRow } from "./helpers/session-row.ts";

function store(overrides: Partial<SharedSessionServiceStore> = {}): SharedSessionServiceStore {
  return {
    now: () => 100,
    readCredential: async () => ({
      session: interactiveSession(
        sessionRow({
          id: "IS-2",
          status: "ready",
          share_mode: "link_read",
          attach_url: "wss://terminal.example/pty",
        }),
        ["ready"],
      ),
      tokenHash: "share-hash",
    }),
    hashToken: async (token) => `${token}-hash`,
    isEmbedToken: async () => false,
    terminalRouteAvailable: () => true,
    ...overrides,
  };
}

test("shared session service keeps ordinary links read-only", async () => {
  const result = await new SharedSessionService(store()).read("IS-2", "share");
  assert.equal(result.session.id, "IS-2");
  assert.equal(result.session.canControl, false);
  assert.equal(result.session.sharedReadOnly, true);
  assert.equal(result.session.ptyAvailable, false);
  assert.equal(result.session.attachUrl, null);
  assert.deepEqual(result.session.logs, ["ready"]);
});

test("shared session service grants terminal readiness only to signed embeds", async () => {
  const result = await new SharedSessionService(
    store({
      readCredential: async () => ({
        session: interactiveSession(
          sessionRow({
            id: "IS-2",
            status: "ready",
            share_mode: "private",
            attach_url: "wss://terminal.example/pty",
          }),
          [],
        ),
        tokenHash: null,
      }),
      isEmbedToken: async (sessionId, token) => sessionId === "IS-2" && token === "embed",
    }),
  ).read("IS-2", "embed");

  assert.equal(result.session.canControl, true);
  assert.equal(result.session.sharedReadOnly, false);
  assert.equal(result.session.ptyAvailable, true);
  assert.equal(result.session.attachUrl, null);
  assert.equal(result.session.adapter, null);
});

test("shared session service masks missing and invalid credentials", async () => {
  const service = new SharedSessionService(store());
  await assert.rejects(service.read("IS-2", "wrong"), /shared session not found/);
  await assert.rejects(
    new SharedSessionService(store({ readCredential: async () => null })).read("missing", "share"),
    /shared session not found/,
  );
});
