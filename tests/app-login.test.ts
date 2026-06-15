import assert from "node:assert/strict";
import test from "node:test";

import { developmentIdentityDefaults, isLoginScreenHidden } from "../src/app/login-state.js";

test("login visibility distinguishes authenticated and shared-link access", () => {
  const signedOut = {
    signedIn: false,
    sharedSessionId: null,
    sharedToken: null,
    loginMessage: "",
    user: null,
  };
  assert.equal(isLoginScreenHidden(signedOut), false);
  assert.equal(isLoginScreenHidden({ ...signedOut, signedIn: true }), true);
  assert.equal(
    isLoginScreenHidden({
      ...signedOut,
      sharedSessionId: "IS-1",
      sharedToken: "share",
    }),
    true,
  );
  assert.equal(
    isLoginScreenHidden({
      ...signedOut,
      user: { subject: "shared" },
      loginMessage: "expired",
    }),
    false,
  );
});

test("development identity defaults preserve explicit development subjects", () => {
  assert.deepEqual(
    developmentIdentityDefaults({
      subject: "dev:user-2",
      login: "fallback",
      name: "User Two",
      role: "viewer",
    }),
    { id: "user-2", name: "User Two", role: "viewer" },
  );
  assert.deepEqual(developmentIdentityDefaults(null), {
    id: "admin-1",
    name: "Admin 1",
    role: "owner",
  });
});
