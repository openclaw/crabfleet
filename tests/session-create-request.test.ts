import assert from "node:assert/strict";
import test from "node:test";

import type { RuntimeEnv } from "../src/worker/env.ts";
import {
  interactiveCommand,
  resolveInteractiveSessionCreateRequest,
} from "../src/worker/session-create-request.ts";

function runtimeEnv(values: Partial<RuntimeEnv> = {}): RuntimeEnv {
  return values as RuntimeEnv;
}

test("session create requests centralize defaults and descriptive fields", () => {
  const request = resolveInteractiveSessionCreateRequest(
    runtimeEnv(),
    {
      repo: " HTTPS://github.com/OpenClaw/Crabfleet.git/ ",
      command: " codex   --yolosandbox ",
    },
    { owner: "maintainer", createdBy: "service:openclaw" },
  );

  assert.equal(request.repo, "openclaw/crabfleet");
  assert.equal(request.branch, "main");
  assert.equal(request.runtime, "container");
  assert.equal(request.profile, "default");
  assert.equal(request.command, "codex --yolo");
  assert.equal(request.purpose, "codex --yolo in openclaw/crabfleet@main");
  assert.equal(request.summary, request.purpose);
  assert.equal(request.owner, "maintainer");
  assert.equal(request.createdBy, "service:openclaw");
  assert.equal(request.requestedCapabilities.terminal, true);
  assert.equal(request.requestedCapabilities.desktop, false);
  assert.equal(interactiveCommand(undefined), "codex --yolo");
});

test("session create requests enforce configured profiles and capability overlays", () => {
  const env = runtimeEnv({
    CRABFLEET_DEFAULT_RUNTIME: "crabbox",
    CRABFLEET_DEFAULT_PROFILE: "desktop",
    CRABFLEET_RUNTIME_PROFILES_JSON: JSON.stringify([
      {
        id: "desktop",
        label: "Desktop",
        capabilities: { terminal: true, takeover: false, desktop: false, vnc: false },
      },
    ]),
  });
  const request = resolveInteractiveSessionCreateRequest(
    env,
    {
      repo: "openclaw/crabfleet",
      prompt: "investigate the failure",
    },
    { owner: "maintainer", createdBy: "maintainer" },
  );

  assert.equal(request.runtime, "crabbox");
  assert.equal(request.profile, "desktop");
  assert.equal(request.purpose, "investigate the failure");
  assert.equal(request.summary, "investigate the failure");
  assert.equal(request.requestedCapabilities.terminal, true);
  assert.equal(request.requestedCapabilities.takeover, false);
  assert.equal(request.requestedCapabilities.desktop, false);
  assert.equal(request.requestedCapabilities.vnc, false);
  assert.throws(
    () =>
      resolveInteractiveSessionCreateRequest(
        env,
        { repo: "openclaw/crabfleet", profile: "missing" },
        { owner: "maintainer", createdBy: "maintainer" },
      ),
    /profile is not configured/,
  );
});

test("session create requests fail before allocation when adapter routing is incomplete", () => {
  assert.throws(
    () =>
      resolveInteractiveSessionCreateRequest(
        runtimeEnv({
          CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example.test",
          CRABBOX_RUNTIME_ADAPTER_URL_TEMPLATE:
            "https://controller.example.test/adapters/{profile}",
          CRABBOX_RUNTIME_ADAPTER_TOKEN: "adapter-token",
          CRABBOX_RUNTIME_ADAPTER_NAMESPACE: "fleet",
        }),
        { repo: "openclaw/crabfleet" },
        { owner: "maintainer", createdBy: "maintainer" },
      ),
    /runtime adapter URL or profile route template must be valid and unambiguous/,
  );
  assert.throws(
    () =>
      resolveInteractiveSessionCreateRequest(
        runtimeEnv({
          CRABBOX_RUNTIME_ADAPTER_URL: "https://adapter.example.test",
          CRABBOX_RUNTIME_ADAPTER_NAMESPACE: "fleet",
        }),
        { repo: "openclaw/crabfleet" },
        { owner: "maintainer", createdBy: "maintainer" },
      ),
    /runtime adapter token is not configured/,
  );
});

test("session create requests reject runtimes outside deployment policy", () => {
  const env = runtimeEnv({
    CRABFLEET_INTERACTIVE_RUNTIMES: "crabbox",
    CRABFLEET_DEFAULT_RUNTIME: "crabbox",
  });
  assert.equal(
    resolveInteractiveSessionCreateRequest(
      env,
      { repo: "openclaw/crabfleet" },
      { owner: "maintainer", createdBy: "maintainer" },
    ).runtime,
    "crabbox",
  );
  assert.throws(
    () =>
      resolveInteractiveSessionCreateRequest(
        env,
        { repo: "openclaw/crabfleet", runtime: "container" },
        { owner: "maintainer", createdBy: "maintainer" },
      ),
    /runtime is not enabled for interactive sessions/,
  );
  assert.throws(
    () =>
      resolveInteractiveSessionCreateRequest(
        runtimeEnv(),
        { repo: "openclaw/crabfleet", runtime: "github_actions" },
        { owner: "maintainer", createdBy: "maintainer" },
      ),
    /runtime is not enabled for interactive sessions/,
  );
});
