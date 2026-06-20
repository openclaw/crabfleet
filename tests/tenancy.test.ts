import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { userTenantSubject, type User } from "../src/worker/models.ts";
import {
  bootstrapTenantSubject,
  stableTenantSubject,
  tenancyMode,
  tenantSubject,
} from "../src/worker/tenancy.ts";

function user(values: Partial<User> = {}): User {
  return {
    subject: "github:42",
    login: "operator",
    email: "operator@example.test",
    name: "Operator",
    role: "maintainer",
    allowed: true,
    teams: [],
    ...values,
  };
}

test("tenancy defaults private and requires an exact shared-mode opt-in", () => {
  assert.equal(tenancyMode({ CRABFLEET_TENANCY_MODE: "shared" } as RuntimeEnv), "shared");
  for (const value of [undefined, "", "private", "SHARED", " shared "]) {
    assert.equal(tenancyMode({ CRABFLEET_TENANCY_MODE: value } as RuntimeEnv), "private");
  }
});

test("tenant subject can inherit the authenticated parent identity", () => {
  const current = user();
  assert.equal(tenantSubject(current), "github:42");
  current[userTenantSubject] = "proxy:operator@example.test";
  assert.equal(tenantSubject(current), "proxy:operator@example.test");
});

test("bootstrap tenancy stays stable across credential rotation", () => {
  assert.equal(stableTenantSubject("bootstrap:first-hash"), bootstrapTenantSubject);
  assert.equal(stableTenantSubject("bootstrap:second-hash"), bootstrapTenantSubject);
  assert.equal(tenantSubject(user({ subject: "bootstrap:first-hash" })), bootstrapTenantSubject);
});
