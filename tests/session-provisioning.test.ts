import assert from "node:assert/strict";
import test from "node:test";

import {
  managedInteractiveProvisionBackend,
  standaloneInteractiveProvisionSupported,
} from "../src/worker/session-provisioning.ts";

test("managed provisioning prefers built-in Sandbox for container sessions", () => {
  assert.equal(
    managedInteractiveProvisionBackend("container", {
      sandbox: true,
      runtimeAdapter: true,
    }),
    "sandbox",
  );
  assert.equal(
    managedInteractiveProvisionBackend("crabbox", {
      sandbox: true,
      runtimeAdapter: true,
    }),
    "runtime-adapter",
  );
});

test("managed provisioning has one external lifecycle protocol", () => {
  assert.equal(
    managedInteractiveProvisionBackend("container", {
      sandbox: false,
      runtimeAdapter: true,
    }),
    "runtime-adapter",
  );
  assert.equal(
    managedInteractiveProvisionBackend("crabbox", {
      sandbox: false,
      runtimeAdapter: true,
    }),
    "runtime-adapter",
  );
  assert.equal(
    managedInteractiveProvisionBackend("container", {
      sandbox: false,
      runtimeAdapter: false,
    }),
    null,
  );
  assert.equal(
    managedInteractiveProvisionBackend("crabbox", {
      sandbox: true,
      runtimeAdapter: false,
    }),
    null,
  );
});

test("standalone provisioning is built-in Sandbox only", () => {
  assert.equal(standaloneInteractiveProvisionSupported("container", true), true);
  assert.equal(standaloneInteractiveProvisionSupported("container", false), false);
  assert.equal(standaloneInteractiveProvisionSupported("crabbox", true), false);
});
