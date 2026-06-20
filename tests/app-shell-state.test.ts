import assert from "node:assert/strict";
import test from "node:test";

import { appShellMetrics, appUserPresentation } from "../src/app/app-shell-state.js";

test("app shell metrics prefer fleet attachability totals", () => {
  assert.deepEqual(
    appShellMetrics({
      cards: [{ lane: "Running" }, { lane: "Todo" }, { lane: "Human Review" }],
      fleet: { totals: { attachable: 7 } },
      interactiveSessions: [],
    }),
    { active: 1, queue: 1, review: 1, cli: 7 },
  );
});

test("app shell metrics include token-backed sessions missing from fleet state", () => {
  assert.equal(
    appShellMetrics({
      cards: [],
      fleet: {
        totals: { attachable: 1 },
        sessions: [{ id: "IS-owned" }],
      },
      interactiveSessions: [
        {
          id: "IS-owned",
          status: "ready",
          capabilities: { terminal: true },
          attachUrl: "wss://terminal.example/owned",
        },
        {
          id: "IS-shared",
          status: "ready",
          capabilities: { terminal: true },
          attachUrl: null,
          ptyAvailable: false,
          sharedLinkOnly: true,
          sharedReadOnly: true,
        },
      ],
    }).cli,
    2,
  );
});

test("trusted proxy users cannot be presented with local logout", () => {
  assert.deepEqual(
    appUserPresentation({
      signedIn: true,
      user: { subject: "proxy:alice", login: "alice", role: "maintainer" },
    }),
    { trustedProxyUser: true, userLabel: "alice / maintainer" },
  );
  assert.deepEqual(
    appUserPresentation({
      signedIn: false,
      user: { subject: "shared", login: "shared link", role: "viewer" },
    }),
    { trustedProxyUser: false, userLabel: "Sign in for control" },
  );
});
