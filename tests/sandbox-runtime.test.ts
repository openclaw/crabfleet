import assert from "node:assert/strict";
import test from "node:test";

import {
  createFreshSandboxSession,
  createSandboxSession,
  runSandboxSetupStep,
  sandboxAutostartScriptPath,
  sandboxCheckoutErrorPath,
  sandboxSessionEnv,
  sandboxSetupSessionId,
  sandboxTerminalShellPath,
  sandboxWorkdir,
  terminalSize,
} from "../src/worker/sandbox-runtime.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { InteractiveProvisionRequest } from "../src/worker/provisioning/types.ts";

const runtimeSession: InteractiveProvisionRequest = {
  id: "is-42",
  parentSessionId: "is-1",
  rootSessionId: "is-1",
  repo: "openclaw/crabfleet",
  branch: "main",
  runtime: "crabbox",
  profile: "default",
  command: "codex",
  prompt: "Fix it",
  purpose: "test",
  summary: "runtime environment test",
  owner: "octocat",
  createdBy: "octocat",
};

test("Sandbox runtime paths derive one normalized session identity", () => {
  assert.equal(sandboxSetupSessionId("IS 42"), "setup-is-42");
  assert.equal(sandboxWorkdir("IS 42"), "/workspace/crabbox-is-42");
  assert.equal(sandboxAutostartScriptPath("IS 42"), "/tmp/.crabbox-autostart-crabbox-is-42.sh");
  assert.equal(sandboxTerminalShellPath("IS 42"), "/tmp/.crabbox-terminal-crabbox-is-42.sh");
  assert.equal(sandboxCheckoutErrorPath("IS 42"), "/tmp/crabbox-checkout-error-crabbox-is-42.txt");
});

test("Sandbox terminal dimensions use bounded integer query values", () => {
  assert.equal(terminalSize(new Request("https://example.test/?cols=1"), "cols", 120), 10);
  assert.equal(terminalSize(new Request("https://example.test/?rows=999"), "rows", 34), 300);
  assert.equal(terminalSize(new Request("https://example.test/?cols=42.9"), "cols", 120), 42);
  assert.equal(terminalSize(new Request("https://example.test/?cols=nope"), "cols", 120), 120);
});

test("Sandbox session creation adopts only the exact existing session", async () => {
  const existing = { id: "terminal-is-42" };
  const sandbox = {
    createSession: async () => {
      throw {
        errorResponse: {
          code: "SESSION_ALREADY_EXISTS",
          context: { sessionId: "terminal-is-42" },
        },
      };
    },
    getSession: async (id: string) => {
      assert.equal(id, "terminal-is-42");
      return existing;
    },
  };

  assert.equal(
    await createSandboxSession(sandbox as never, "terminal-is-42", "/workspace/crabbox-is-42", {}),
    existing,
  );
  await assert.rejects(
    createSandboxSession(sandbox as never, "terminal-other", "/workspace/other", {}),
  );
});

test("Fresh Sandbox sessions tolerate an exact missing delete and compact environment values", async () => {
  let createOptions: unknown;
  const created = { id: "terminal-is-42" };
  const sandbox = {
    deleteSession: async () => {
      throw {
        errorResponse: {
          code: "SESSION_TERMINATED",
          context: { sessionId: "terminal-is-42" },
        },
      };
    },
    createSession: async (options: unknown) => {
      createOptions = options;
      return created;
    },
  };

  assert.equal(
    await createFreshSandboxSession(
      sandbox as never,
      "terminal-is-42",
      "/workspace/crabbox-is-42",
      { KEEP: "value", DROP: undefined },
    ),
    created,
  );
  assert.deepEqual(createOptions, {
    id: "terminal-is-42",
    cwd: "/workspace/crabbox-is-42",
    env: { KEEP: "value" },
    commandTimeoutMs: 300_000,
  });
});

test("Sandbox setup steps retain their operation name in failures", async () => {
  await assert.rejects(
    runSandboxSetupStep("repository checkout", async () => {
      throw new Error("clone failed");
    }),
    { message: "repository checkout: clone failed" },
  );
});

test("Sandbox session environment exposes placeholders instead of worker credentials", () => {
  const env = {
    CRABFLEET_CANONICAL_URL: "https://fleet.example.test",
    GITHUB_TOKEN: "worker-github-token",
    OPENAI_API_KEY: "worker-openai-key",
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_ORG_ID: "org-test",
  } as RuntimeEnv;

  assert.deepEqual(sandboxSessionEnv(env, runtimeSession, "agent-token"), {
    CRABBOX_SESSION_ID: "is-42",
    CRABFLEET_SESSION_ID: "is-42",
    CRABFLEET_PARENT_SESSION_ID: "is-1",
    CRABFLEET_ROOT_SESSION_ID: "is-1",
    CRABFLEET_AGENT_TOKEN: "agent-token",
    CRABFLEET_API_URL: "https://fleet.example.test",
    CRABBOX_REPO: "openclaw/crabfleet",
    CRABBOX_BRANCH: "main",
    CRABBOX_RUNTIME: "crabbox",
    TERM: "xterm-256color",
    COLORTERM: "truecolor",
    GH_TOKEN: "crabfleet-worker-injected",
    GITHUB_TOKEN: "crabfleet-worker-injected",
    TERM_PROGRAM: "ghostty",
    TERM_PROGRAM_VERSION: "web",
    OPENAI_API_KEY: "crabfleet-worker-injected",
    OPENAI_BASE_URL: "https://api.example.test/v1",
    OPENAI_ORG_ID: "org-test",
  });
});

test("Sandbox session environment omits absent optional credentials", () => {
  const sessionEnv = sandboxSessionEnv(
    { CRABFLEET_CANONICAL_URL: "https://fleet.example.test" } as RuntimeEnv,
    { ...runtimeSession, parentSessionId: null, rootSessionId: null },
  );

  assert.equal(sessionEnv.CRABFLEET_PARENT_SESSION_ID, undefined);
  assert.equal(sessionEnv.CRABFLEET_ROOT_SESSION_ID, "is-42");
  assert.equal(sessionEnv.CRABFLEET_AGENT_TOKEN, undefined);
  assert.equal(sessionEnv.GH_TOKEN, undefined);
  assert.equal(sessionEnv.GITHUB_TOKEN, undefined);
  assert.equal(sessionEnv.OPENAI_API_KEY, undefined);
});
