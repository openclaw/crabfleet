import assert from "node:assert/strict";
import { test } from "node:test";

import {
  browserAppOrigin,
  clientDeploymentConfig,
  deploymentConfig,
  publicDeploymentConfig,
  selectedRuntimeProfile,
  type DeploymentEnv,
} from "../src/worker/deployment.ts";

const runtimeProfiles = JSON.stringify([
  {
    id: "linux",
    label: "Linux",
    target: "linux",
    capabilities: { terminal: true, desktop: true },
    codexSsh: {
      aliasTemplate: "codex-{providerResourceId}",
      setupCommand: ["fleet-connect", "{providerResourceId}"],
    },
  },
]);

test("deployment configuration validates defaults and normalizes public values", () => {
  const deployment = deploymentConfig({
    CRABFLEET_LABEL: " Tenant Fleet ",
    CRABFLEET_CANONICAL_URL: "https://fleet.example/app",
    CRABFLEET_PRODUCT_URL: "http://product.example",
    CRABFLEET_SSH_HOST: " ssh.example ",
    CRABFLEET_PREFERRED_REPO: "https://github.com/OpenClaw/Crabfleet.git",
    CRABFLEET_DEFAULT_RUNTIME: "crabbox",
    CRABFLEET_DEFAULT_PROFILE: "linux",
    CRABFLEET_RUNTIME_PROFILES_JSON: runtimeProfiles,
  });

  assert.equal(deployment.label, "Tenant Fleet");
  assert.equal(deployment.canonicalUrl, "https://fleet.example");
  assert.equal(deployment.productUrl, "https://crabfleet.ai");
  assert.equal(deployment.sshHost, "ssh.example");
  assert.equal(deployment.preferredRepo, "openclaw/crabfleet");
  assert.equal(deployment.defaultRuntime, "crabbox");
  assert.equal(deployment.defaultProfile, "linux");
  assert.equal(deployment.runtimeProfiles[0]?.target, "linux");
});

test("configured runtime profiles are allowlisted behaviorally", () => {
  const deployment = deploymentConfig({
    CRABFLEET_DEFAULT_PROFILE: "linux",
    CRABFLEET_RUNTIME_PROFILES_JSON: runtimeProfiles,
  });

  assert.equal(selectedRuntimeProfile(deployment, undefined).profile, "linux");
  assert.equal(selectedRuntimeProfile(deployment, "linux").descriptor?.label, "Linux");
  assert.throws(
    () => selectedRuntimeProfile(deployment, "unknown"),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "profile is not configured" &&
      "status" in error &&
      error.status === 400,
  );
  assert.throws(
    () =>
      deploymentConfig({
        CRABFLEET_DEFAULT_PROFILE: "unknown",
        CRABFLEET_RUNTIME_PROFILES_JSON: runtimeProfiles,
      }),
    /must name a configured runtime profile/,
  );
});

test("public and client deployment views exclude server-only routing data", () => {
  const env: DeploymentEnv = {
    CRABFLEET_CANONICAL_URL: "https://backend.example",
    CRABFLEET_TRUSTED_PROXY_ORIGIN: "https://backend.example",
    CRABFLEET_TRUSTED_PROXY_PUBLIC_ORIGIN: "https://fleet.example",
    CRABFLEET_TRUSTED_PROXY_SECRET: "edge-secret",
    CRABFLEET_DEFAULT_PROFILE: "linux",
    CRABFLEET_RUNTIME_PROFILES_JSON: runtimeProfiles,
  };

  assert.deepEqual(publicDeploymentConfig(env), {
    label: "Crabfleet",
    canonicalUrl: "https://fleet.example",
    productUrl: "https://crabfleet.ai",
    sshHost: "crabd.sh",
  });
  assert.equal(browserAppOrigin(env), "https://fleet.example");

  const client = clientDeploymentConfig(env);
  assert.equal(client.preferredRepo, "openclaw/crabfleet");
  assert.equal(client.runtimeProfiles[0]?.codexSsh, undefined);
  assert.equal("CRABBOX_RUNTIME_ADAPTER_URL" in client, false);
});
