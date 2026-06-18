import { githubRequestCanUseRepoCredential, matchesAnyHost } from "../sandbox-security.ts";
import { openSecret } from "./crypto.ts";
import type { RuntimeEnv } from "./env.ts";
import { githubNodeBelongsToRepo } from "./github.ts";
import type { SandboxCredentialPolicy } from "./session-control-policy.ts";

export const sandboxPlaceholderOpenAIKey = "crabfleet-worker-injected";
export const sandboxPlaceholderGitHubToken = "crabfleet-worker-injected";

export const defaultSandboxEgressHosts = [
  "api.github.com",
  "api.openai.com",
  "codeload.github.com",
  "github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  "uploads.github.com",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "*.githubusercontent.com",
  "*.npmjs.org",
  "*.nodejs.org",
  "*.openai.com",
  "*.yarnpkg.com",
];

export type SandboxOutboundContext = {
  containerId: string;
};

export type SandboxOutboundDependencies = {
  decryptSecret?: (env: RuntimeEnv, sealed: string) => Promise<string | null>;
  fetcher?: (request: Request) => Promise<Response>;
  nodeBelongsToRepo?: (nodeId: string, repo: string, token: string) => Promise<boolean>;
  now?: () => number;
  readCredentialPolicy: (
    env: RuntimeEnv,
    sandboxId: string,
  ) => Promise<SandboxCredentialPolicy | null>;
};

export async function routeSandboxOutbound(
  request: Request,
  env: RuntimeEnv,
  context: SandboxOutboundContext,
  dependencies: SandboxOutboundDependencies,
): Promise<Response> {
  const now = dependencies.now?.() ?? Date.now();
  const fetcher = dependencies.fetcher ?? fetch;
  const decryptSecret = dependencies.decryptSecret ?? openSecret;
  const nodeBelongsToRepo = dependencies.nodeBelongsToRepo ?? githubNodeBelongsToRepo;
  const url = new URL(request.url);
  const host = url.hostname.toLowerCase();
  const policy = await dependencies.readCredentialPolicy(env, context.containerId);
  if (policy?.expiresAt !== undefined && policy.expiresAt <= now) {
    return new Response("Crabfleet standalone Sandbox credentials expired.\n", { status: 403 });
  }
  const openAIHost = policy?.openAIBaseUrl
    ? new URL(policy.openAIBaseUrl).hostname.toLowerCase()
    : "api.openai.com";
  const allowedHosts = [
    ...defaultSandboxEgressHosts,
    ...(policy?.openAIBaseUrl ? [openAIHost] : []),
    ...(policy?.allowedHosts ?? []),
  ];
  if (!matchesAnyHost(host, allowedHosts)) {
    return new Response(`Crabfleet blocked sandbox outbound access to ${host}.\n`, {
      status: 403,
    });
  }

  if (policy && openAIRequestMatchesPolicy(url, policy)) {
    const authorization = env.OPENAI_API_KEY ? `Bearer ${env.OPENAI_API_KEY}` : undefined;
    const next = withAuthorization(request, authorization);
    if (policy.openAIOrgId) next.headers.set("openai-organization", policy.openAIOrgId);
    return fetcher(next);
  }

  const githubToken = policy?.githubTokenCiphertext
    ? await decryptSecret(env, policy.githubTokenCiphertext)
    : env.GITHUB_TOKEN;
  if (
    githubToken &&
    policy &&
    (await githubRequestCanUseRepoCredential(request, url, policy.githubRepo, {
      nodeBelongsToRepo: (nodeId) => nodeBelongsToRepo(nodeId, policy.githubRepo, githubToken),
      ...(policy.githubRepoNodeId ? { repoNodeId: policy.githubRepoNodeId } : {}),
    }))
  ) {
    const authorization =
      host === "api.github.com" || host === "uploads.github.com"
        ? `Bearer ${githubToken}`
        : githubBasicAuth(githubToken);
    return fetcher(withAuthorization(request, authorization));
  }

  if (isGitHubHost(host)) {
    return fetcher(withoutSandboxPlaceholderAuthorization(request));
  }

  return fetcher(request);
}

export function openAIRequestMatchesPolicy(url: URL, policy: SandboxCredentialPolicy): boolean {
  const baseUrl = new URL(policy.openAIBaseUrl ?? "https://api.openai.com");
  if (url.origin !== baseUrl.origin) return false;
  if (baseUrl.pathname === "/" || baseUrl.pathname === "") return true;
  const basePath = baseUrl.pathname.endsWith("/") ? baseUrl.pathname : `${baseUrl.pathname}/`;
  return url.pathname === baseUrl.pathname || url.pathname.startsWith(basePath);
}

function withAuthorization(request: Request, authorization?: string): Request {
  const next = new Request(request);
  if (authorization) {
    next.headers.set("authorization", authorization);
  } else {
    next.headers.delete("authorization");
  }
  return next;
}

function githubBasicAuth(token: string): string {
  return `Basic ${btoa(`x-access-token:${token}`)}`;
}

function isGitHubHost(host: string): boolean {
  return (
    host === "api.github.com" ||
    host === "github.com" ||
    host === "codeload.github.com" ||
    host === "raw.githubusercontent.com" ||
    host === "uploads.github.com"
  );
}

function withoutSandboxPlaceholderAuthorization(request: Request): Request {
  const authorization = request.headers.get("authorization");
  if (
    authorization !== `Bearer ${sandboxPlaceholderGitHubToken}` &&
    authorization !== `token ${sandboxPlaceholderGitHubToken}` &&
    authorization !== githubBasicAuth(sandboxPlaceholderGitHubToken)
  ) {
    return request;
  }
  return withAuthorization(request, undefined);
}
