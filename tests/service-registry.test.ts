import assert from "node:assert/strict";
import test from "node:test";

import { ServiceRegistry } from "../src/worker/service-registry.ts";

test("service registry creates each request-scoped owner once", () => {
  const registry = new ServiceRegistry();
  const runtime = Symbol("runtime");
  const sessions = Symbol("sessions");
  let creations = 0;
  const create = () => ({ creation: ++creations });

  assert.strictEqual(registry.get(runtime, create), registry.get(runtime, create));
  assert.notStrictEqual(registry.get(runtime, create), registry.get(sessions, create));
  assert.equal(creations, 2);
});
