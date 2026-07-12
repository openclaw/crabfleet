import assert from "node:assert/strict";
import test from "node:test";

import {
  appNavigationLocationState,
  normalizedAppView,
  sessionOpenTarget,
  shouldDisposeTerminalsForNavigation,
  topOpenDrawer,
} from "../src/app/app-navigation.js";

test("navigation normalizes app views and closes the topmost drawer", () => {
  assert.equal(normalizedAppView("board"), "board");
  assert.equal(normalizedAppView("sessions"), "fleet");
  assert.equal(topOpenDrawer({ card: true, run: true, sessions: true }), "sessions");
  assert.equal(topOpenDrawer({}), null);
});

test("session navigation derives focus and durable route targets", () => {
  const sessions = new Map([
    ["IS-1", { id: "IS-1", kind: "interactive" }],
    ["CY-1", { id: "CY-1", kind: "card" }],
    ["LOCAL-1", { id: "LOCAL-1", kind: "interactive" }],
  ]);

  assert.deepEqual(sessionOpenTarget(undefined, "IS-1", sessions), {
    targetId: "IS-1",
    clearFocus: false,
    urlSessionId: "IS-1",
    grid: false,
  });
  assert.deepEqual(sessionOpenTarget("CY-1", null, sessions), {
    targetId: "CY-1",
    clearFocus: false,
    urlSessionId: null,
    grid: true,
  });
  assert.deepEqual(sessionOpenTarget("CY-1", null, sessions, { deepLink: true }), {
    targetId: "CY-1",
    clearFocus: false,
    urlSessionId: "CY-1",
    grid: false,
  });
  assert.deepEqual(sessionOpenTarget("LOCAL-1", null, sessions), {
    targetId: "LOCAL-1",
    clearFocus: false,
    urlSessionId: null,
    grid: true,
  });
  assert.deepEqual(sessionOpenTarget(null, "IS-1", sessions), {
    targetId: null,
    clearFocus: true,
    urlSessionId: null,
    grid: true,
  });
});

test("browser history locations reconcile view, drawers, and session focus", () => {
  const focusedSession = appNavigationLocationState({
    pathname: "/sessions/IS-2",
    search: "?token=shared",
  });
  assert.deepEqual(focusedSession, {
    appView: "fleet",
    drawers: { sessions: true },
    focusedSessionId: "IS-2",
    sharedSessionId: "IS-2",
    sharedToken: "shared",
  });
  assert.equal(shouldDisposeTerminalsForNavigation(focusedSession), false);

  const sessionGrid = appNavigationLocationState({ pathname: "/sessions", search: "" });
  assert.deepEqual(sessionGrid, {
    appView: "fleet",
    drawers: { sessions: true },
    focusedSessionId: null,
    sharedSessionId: null,
    sharedToken: null,
  });
  assert.equal(shouldDisposeTerminalsForNavigation(sessionGrid), false);

  const board = appNavigationLocationState({ pathname: "/app/board", search: "" });
  assert.deepEqual(board, {
    appView: "board",
    drawers: {},
    focusedSessionId: null,
    sharedSessionId: null,
    sharedToken: null,
  });
  assert.equal(shouldDisposeTerminalsForNavigation(board), true);
});
