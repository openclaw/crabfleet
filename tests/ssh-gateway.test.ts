import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import { SshGateway, sshGatewayFingerprint } from "../src/worker/ssh-gateway.ts";

const dependencies = {
  async readState() {
    return {};
  },
  async createSession() {
    throw new Error("not used");
  },
  async audit() {},
};

test("SSH gateway accepts canonical and legacy bearer configuration", () => {
  const gateway = new SshGateway(
    { CRABFLEET_SSH_GATEWAY_TOKEN: "canonical-token" } as RuntimeEnv,
    dependencies,
  );
  assert.equal(
    gateway.isRequest(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { authorization: "Bearer canonical-token" },
      }),
    ),
    true,
  );
  assert.equal(
    gateway.isRequest(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { authorization: "Bearer old-token" },
      }),
    ),
    false,
  );

  const oldConfig = new SshGateway(
    { CRABBOX_SSH_GATEWAY_TOKEN: "old-token" } as RuntimeEnv,
    dependencies,
  );
  assert.equal(
    oldConfig.isRequest(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { authorization: "Bearer old-token" },
      }),
    ),
    true,
  );

  const migratingConfig = new SshGateway(
    {
      CRABFLEET_SSH_GATEWAY_TOKEN: "canonical-token",
      CRABBOX_SSH_GATEWAY_TOKEN: "old-token",
    } as RuntimeEnv,
    dependencies,
  );
  assert.equal(
    migratingConfig.isRequest(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { authorization: "Bearer canonical-token" },
      }),
    ),
    true,
  );
  assert.equal(
    migratingConfig.isRequest(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { authorization: "Bearer old-token" },
      }),
    ),
    true,
  );
});

test("SSH gateway accepts only the canonical fingerprint header", () => {
  assert.equal(
    sshGatewayFingerprint(
      new Request("https://fleet.example/api/ssh/state", {
        headers: { "x-crabfleet-ssh-fingerprint": " SHA256:canonical " },
      }),
    ),
    "SHA256:canonical",
  );
  assert.equal(
    sshGatewayFingerprint(
      new Request("https://fleet.example/api/ssh/state?fingerprint=query-value", {
        headers: { "x-crabbox-ssh-fingerprint": "old-header" },
      }),
    ),
    "",
  );
});
