import { runtimeProfileCapabilities } from "../runtime-profiles.ts";
import { deploymentConfig, selectedRuntimeProfile } from "./deployment.ts";
import type { RuntimeEnv } from "./env.ts";
import { badRequest } from "./http.ts";
import { normalizeRepo } from "./repositories.ts";
import { requireRuntimeAdapterCreatePreflight } from "./runtime-adapter-preflight.ts";
import {
  containerCapabilities,
  crabboxCapabilities,
  type RuntimeCapabilities,
} from "./session-model.ts";

const defaultInteractiveCommand = "codex --yolo";

export type InteractiveSessionCreateRequest = {
  repo?: string;
  branch?: string;
  runtime?: string;
  profile?: string;
  command?: string;
  prompt?: string;
  parentSessionId?: string;
  rootSessionId?: string;
  purpose?: string;
  summary?: string;
};

export type ResolvedInteractiveSessionCreateRequest = {
  repo: string;
  branch: string;
  runtime: "crabbox" | "container";
  profile: string;
  requestedCapabilities: RuntimeCapabilities;
  command: string;
  prompt: string;
  purpose: string;
  summary: string;
  owner: string;
  createdBy: string;
};

export function resolveInteractiveSessionCreateRequest(
  env: RuntimeEnv,
  body: InteractiveSessionCreateRequest,
  identity: { owner: string; createdBy: string },
): ResolvedInteractiveSessionCreateRequest {
  const repo = normalizeRepo(body.repo);
  if (!repo) throw badRequest("repo is required");
  const branch = clean(body.branch, 120) || "main";
  const deployment = deploymentConfig(env);
  const runtime = oneOf(body.runtime, ["crabbox", "container"] as const, deployment.defaultRuntime);
  const { profile, descriptor: runtimeProfile } = selectedRuntimeProfile(deployment, body.profile);
  requireRuntimeAdapterCreatePreflight(env, runtime, profile);
  const requestedCapabilities = runtimeProfileCapabilities(
    runtime === "crabbox" ? runtimeProfile : undefined,
    runtime === "crabbox" ? crabboxCapabilities : containerCapabilities,
  );
  const command = interactiveCommand(body.command);
  const prompt = clean(body.prompt, 4000);
  const purpose = interactiveSessionPurpose(body.purpose, prompt, repo, branch, command);
  const summary = interactiveSessionSummary(body.summary, purpose, prompt);
  return {
    repo,
    branch,
    runtime,
    profile,
    requestedCapabilities,
    command,
    prompt,
    purpose,
    summary,
    owner: identity.owner,
    createdBy: identity.createdBy,
  };
}

export function interactiveCommand(value: unknown): string {
  return (
    clean(value, 240)
      .replace(/\s+/g, " ")
      .replace(/--yolosandbox\b/g, "--yolo")
      .trim() || defaultInteractiveCommand
  );
}

export function interactiveSessionPurpose(
  value: unknown,
  prompt: string,
  repo: string,
  branch: string,
  command: string,
): string {
  const explicit = clean(value, 500);
  if (explicit) return explicit;
  if (prompt) return clean(prompt, 500);
  return clean(`${command} in ${repo}@${branch}`, 500);
}

export function interactiveSessionSummary(value: unknown, purpose: string, prompt: string): string {
  const explicit = clean(value, 500);
  if (explicit) return explicit;
  return clean(purpose || prompt || "interactive Codex session", 500);
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return options.includes(value as T) ? (value as T) : fallback;
}
