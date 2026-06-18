import assert from "node:assert/strict";
import test from "node:test";

import {
  openAIRequestMatchesPolicy,
  routeSandboxOutbound,
  sandboxPlaceholderGitHubToken,
} from "../src/worker/sandbox-outbound.ts";
import type { RuntimeEnv } from "../src/worker/env.ts";
import type { SandboxCredentialPolicy } from "../src/worker/session-control-policy.ts";

const policy: SandboxCredentialPolicy = {
  allowedHosts: [],
  githubRepo: "openclaw/crabfleet",
  owner: "operator",
  sandboxId: "sandbox-1",
  sessionId: "IS-1",
};

test("Sandbox outbound blocks unapproved and expired requests before transport", async () => {
  let fetchCount = 0;
  const fetcher = async () => {
    fetchCount += 1;
    return new Response("unexpected");
  };
  const env = {} as RuntimeEnv;

  const blocked = await routeSandboxOutbound(
    new Request("https://example.test/private"),
    env,
    { containerId: "sandbox-1" },
    {
      fetcher,
      readCredentialPolicy: async () => null,
    },
  );
  assert.equal(blocked.status, 403);
  assert.match(await blocked.text(), /blocked sandbox outbound access/);

  const expired = await routeSandboxOutbound(
    new Request("https://api.openai.com/v1/responses"),
    env,
    { containerId: "sandbox-1" },
    {
      fetcher,
      now: () => 200,
      readCredentialPolicy: async () => ({ ...policy, expiresAt: 200 }),
    },
  );
  assert.equal(expired.status, 403);
  assert.match(await expired.text(), /credentials expired/);
  assert.equal(fetchCount, 0);
});

test("Sandbox outbound injects OpenAI credentials only under the configured base path", async () => {
  const requests: Request[] = [];
  const fetcher = async (request: Request) => {
    requests.push(request);
    return new Response("ok");
  };
  const openAIPolicy: SandboxCredentialPolicy = {
    ...policy,
    openAIBaseUrl: "https://model.example.test/v1",
    openAIOrgId: "org-example",
  };
  const env = { OPENAI_API_KEY: "openai-secret" } as RuntimeEnv;

  assert.equal(
    openAIRequestMatchesPolicy(new URL("https://model.example.test/v1/responses"), openAIPolicy),
    true,
  );
  assert.equal(
    openAIRequestMatchesPolicy(new URL("https://model.example.test/v11/responses"), openAIPolicy),
    false,
  );

  await routeSandboxOutbound(
    new Request("https://model.example.test/v1/responses", {
      headers: { authorization: "Bearer placeholder" },
    }),
    env,
    { containerId: "sandbox-1" },
    {
      fetcher,
      readCredentialPolicy: async () => openAIPolicy,
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer openai-secret");
  assert.equal(requests[0]?.headers.get("openai-organization"), "org-example");
});

test("Sandbox outbound scopes GitHub credentials and strips placeholders elsewhere", async () => {
  const requests: Request[] = [];
  const fetcher = async (request: Request) => {
    requests.push(request);
    return new Response("ok");
  };
  const githubPolicy: SandboxCredentialPolicy = {
    ...policy,
    githubTokenCiphertext: "sealed-token",
  };
  const env = {} as RuntimeEnv;

  await routeSandboxOutbound(
    new Request("https://api.github.com/repos/openclaw/crabfleet/pulls", { method: "POST" }),
    env,
    { containerId: "sandbox-1" },
    {
      decryptSecret: async () => "github-secret",
      fetcher,
      readCredentialPolicy: async () => githubPolicy,
    },
  );
  assert.equal(requests[0]?.headers.get("authorization"), "Bearer github-secret");

  await routeSandboxOutbound(
    new Request("https://api.github.com/user", {
      headers: { authorization: `Bearer ${sandboxPlaceholderGitHubToken}` },
    }),
    env,
    { containerId: "sandbox-1" },
    {
      decryptSecret: async () => "github-secret",
      fetcher,
      readCredentialPolicy: async () => githubPolicy,
    },
  );
  assert.equal(requests[1]?.headers.get("authorization"), null);
});
