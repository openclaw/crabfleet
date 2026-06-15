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
