import { cardRuntimeOptions, mergePolicyOptions, type WorkflowConfig } from "./card-model.ts";
import type { RuntimeEnv } from "./env.ts";
import { githubHeaders } from "./github.ts";
import { serviceUnavailable } from "./http.ts";
import type { RepoWorkflow } from "./workflow-model.ts";
import { WorkflowRepository, type WorkflowRepositoryStore } from "./workflow-repository.ts";

type GitHubContentPayload = {
  content?: string;
  encoding?: string;
  sha?: string;
};

export type WorkflowServiceDependencies = {
  repository: WorkflowRepositoryStore;
  fetchSource(repo: string): Promise<Response>;
  cacheMs: number;
};

export class WorkflowService {
  private readonly dependencies: WorkflowServiceDependencies;

  constructor(dependencies: WorkflowServiceDependencies) {
    this.dependencies = dependencies;
  }

  async ensure(repo: string, now: number): Promise<RepoWorkflow | null> {
    const existing = await this.dependencies.repository.read(repo);
    if (existing && now - existing.evaluatedAt < this.dependencies.cacheMs) return existing;
    try {
      return await this.refresh(repo, now);
    } catch {
      return existing;
    }
  }

  async refresh(repo: string, now: number): Promise<RepoWorkflow> {
    const response = await this.dependencies.fetchSource(repo);
    if (response.status === 404) {
      return this.dependencies.repository.write({
        repo,
        status: "missing",
        sourcePath: "CRABBOX.md",
        sourceSha: null,
        config: {},
        prompt: "",
        error: "CRABBOX.md not found",
        evaluatedAt: now,
        updatedAt: now,
      });
    }
    if (response.status === 403 || response.status === 429) {
      throw serviceUnavailable("GitHub workflow lookup rate limited; retry later");
    }
    if (!response.ok) throw serviceUnavailable("GitHub workflow lookup failed; retry later");

    const payload = (await response.json()) as GitHubContentPayload;
    if (payload.encoding !== "base64" || !payload.content) {
      return this.dependencies.repository.write({
        repo,
        status: "invalid",
        sourcePath: "CRABBOX.md",
        sourceSha: payload.sha ?? null,
        config: {},
        prompt: "",
        error: "unsupported CRABBOX.md encoding",
        evaluatedAt: now,
        updatedAt: now,
      });
    }

    const parsed = parseWorkflowMarkdown(decodeBase64Text(payload.content));
    return this.dependencies.repository.write({
      repo,
      status: parsed.error ? "invalid" : "ok",
      sourcePath: "CRABBOX.md",
      sourceSha: payload.sha ?? null,
      config: parsed.error ? {} : parsed.config,
      prompt: parsed.prompt,
      error: parsed.error,
      evaluatedAt: now,
      updatedAt: now,
    });
  }

  summaries(): Promise<RepoWorkflow[]> {
    return this.dependencies.repository.summaries();
  }
}

export function createWorkflowService(env: RuntimeEnv): WorkflowService {
  return new WorkflowService({
    repository: new WorkflowRepository(env),
    cacheMs: 60 * 60 * 1000,
    fetchSource: (repo) =>
      fetch(`https://api.github.com/repos/${repo}/contents/CRABBOX.md`, {
        headers: githubHeaders(env),
      }),
  });
}

export function parseWorkflowMarkdown(markdown: string): {
  config: WorkflowConfig;
  prompt: string;
  error: string | null;
} {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return { config: {}, prompt: markdown.trim().slice(0, 8000), error: null };
  const raw = parseFrontmatter(match[1] ?? "");
  const config: WorkflowConfig = {};
  const runtime = optionalOneOf(
    raw.runtime ?? raw.runtime_default ?? raw["runtime.default"],
    cardRuntimeOptions,
  );
  const policy = optionalOneOf(
    raw.policy ??
      raw.merge_policy ??
      raw.merge_default_policy ??
      raw["merge.default_policy"] ??
      raw["merge.policy"],
    mergePolicyOptions,
  );
  const stallMs = numberConfig(raw.stall_ms ?? raw.stallMs ?? raw["runtime.stall_ms"]);
  const cap = numberConfig(raw.cap);
  const promptPrefix = raw.prompt_prefix ?? raw["prompt.prefix"];
  if (runtime) config.runtime = runtime;
  if (policy) config.policy = policy;
  if (stallMs) config.stallMs = stallMs;
  if (cap) config.cap = cap;
  if (promptPrefix) config.promptPrefix = promptPrefix.trim().slice(0, 1000);
  const errors = workflowConfigErrors(raw, { runtime, policy, stallMs, cap });
  return {
    config,
    prompt: (match[2] ?? "").trim().slice(0, 8000),
    error: errors.length ? errors.join("; ") : null,
  };
}

function parseFrontmatter(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  let section = "";
  for (const line of value.split(/\r?\n/)) {
    const match = line.match(/^(\s*)([A-Za-z][A-Za-z0-9_.-]*)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const indent = match[1] ?? "";
    const key = match[2] ?? "";
    const value = scalar(match[3] ?? "");
    if (!indent && !value) {
      section = key;
      continue;
    }
    result[indent && section ? `${section}.${key}` : key] = value;
    if (!indent) section = "";
  }
  return result;
}

function workflowConfigErrors(
  raw: Record<string, string>,
  parsed: {
    runtime: string | undefined;
    policy: string | undefined;
    stallMs: number | undefined;
    cap: number | undefined;
  },
): string[] {
  const errors: string[] = [];
  const runtime = raw.runtime ?? raw.runtime_default ?? raw["runtime.default"];
  const policy =
    raw.policy ??
    raw.merge_policy ??
    raw.merge_default_policy ??
    raw["merge.default_policy"] ??
    raw["merge.policy"];
  const stallMs = raw.stall_ms ?? raw.stallMs ?? raw["runtime.stall_ms"];
  const cap = raw.cap;
  if (runtime && !parsed.runtime) errors.push(`unsupported runtime ${runtime}`);
  if (policy && !parsed.policy) errors.push(`unsupported merge policy ${policy}`);
  if (stallMs && !parsed.stallMs) errors.push(`invalid stall_ms ${stallMs}`);
  if (cap && !parsed.cap) errors.push(`invalid cap ${cap}`);
  return errors;
}

function optionalOneOf<T extends string>(value: unknown, options: readonly T[]): T | undefined {
  return options.includes(value as T) ? (value as T) : undefined;
}

function numberConfig(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function scalar(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

function decodeBase64Text(value: string): string {
  const binary = atob(value.replace(/\s+/g, ""));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
