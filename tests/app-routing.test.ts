import assert from "node:assert/strict";
import test from "node:test";

import {
  appViewUrl,
  initialAppView,
  isGithubLoginCallback,
  loginReturnKey,
  parseSessionLink,
  restorableSessionReturnUrl,
  restoreSessionReturnUrl,
  sessionRouteUrl,
} from "../src/app/routing.js";

test("app routing parses board and shared session locations", () => {
  assert.equal(initialAppView({ pathname: "/app/board/" }), "board");
  assert.equal(initialAppView({ pathname: "/app/fleet" }), "fleet");
  assert.equal(isGithubLoginCallback({ search: "?login=github" }), true);
  assert.deepEqual(
    parseSessionLink({ pathname: "/app/sessions/IS%2F2", search: "?token=share%20token" }),
    { route: true, id: "IS/2", token: "share token" },
  );
  assert.deepEqual(parseSessionLink({ pathname: "/app/fleet", search: "" }), {
    route: false,
    id: null,
    token: null,
  });
});

test("app and session route builders preserve only owned URL state", () => {
  assert.equal(
    appViewUrl("https://fleet.example/app?old=1#anchor", "board").toString(),
    "https://fleet.example/app/board#anchor",
  );
  assert.equal(
    sessionRouteUrl("https://fleet.example/app/fleet?old=1#anchor", {
      id: "IS/2",
      sharedSessionId: "IS/2",
      sharedToken: "share token",
    }).toString(),
    "https://fleet.example/sessions/IS%2F2?token=share+token#anchor",
  );
  assert.equal(
    sessionRouteUrl("https://fleet.example/sessions/IS-2?token=old", {
      id: null,
      grid: true,
    }).toString(),
    "https://fleet.example/sessions",
  );
});

test("login return restoration accepts only same-origin session routes", () => {
  const locationLike = {
    origin: "https://fleet.example",
    pathname: "/app",
  };
  assert.equal(
    restorableSessionReturnUrl("https://fleet.example/sessions/IS-2?token=share", locationLike),
    "/sessions/IS-2?token=share",
  );
  assert.equal(
    restorableSessionReturnUrl("https://attacker.example/sessions/IS-2", locationLike),
    null,
  );
  assert.equal(restorableSessionReturnUrl("https://fleet.example/admin", locationLike), null);

  const values = new Map([[loginReturnKey, "/sessions/IS-3"]]);
  const calls: unknown[][] = [];
  restoreSessionReturnUrl({
    storage: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
    },
    historyApi: {
      replaceState: (...args: unknown[]) => calls.push(args),
    },
    locationLike,
  });
  assert.equal(values.has(loginReturnKey), false);
  assert.deepEqual(calls, [[null, "", "/sessions/IS-3"]]);
});
