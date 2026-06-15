import type { Sandbox as CloudflareSandbox } from "@cloudflare/sandbox";

import type { InteractiveProvisionRequest } from "./provisioning/types.ts";
import { sandboxIdForSession } from "./sandbox-lease.ts";
import {
  isSandboxSessionAlreadyExists,
  isSandboxSessionAlreadyGone,
} from "./sandbox-session-errors.ts";
import type { InteractiveSession } from "./session-model.ts";

export type SandboxExecutionSession = Awaited<ReturnType<CloudflareSandbox["createSession"]>>;
export type SandboxSessionTarget = Pick<SandboxExecutionSession, "exec" | "mkdir" | "setEnvVars">;

export function sandboxSetupSessionId(id: string): string {
  return clean(`setup-${id}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-"), 80);
}

export function sandboxWorkdir(id: string): string {
  return `/workspace/${sandboxIdForSession(id)}`;
}

export function sandboxAutostartScriptPath(id: string): string {
  return `/tmp/.crabbox-autostart-${sandboxIdForSession(id)}.sh`;
}

export function sandboxTerminalShellPath(id: string): string {
  return `/tmp/.crabbox-terminal-${sandboxIdForSession(id)}.sh`;
}

export function sandboxCheckoutErrorPath(id: string): string {
  return `/tmp/crabbox-checkout-error-${sandboxIdForSession(id)}.txt`;
}

export function sandboxBashrcMarker(
  session: Pick<InteractiveSession | InteractiveProvisionRequest, "id">,
): string {
  return `# crabbox session ${session.id} autostart-v4`;
}

export function terminalSize(request: Request, name: "cols" | "rows", fallback: number): number {
  const url = new URL(request.url);
  const value = Number(url.searchParams.get(name));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(300, Math.max(10, Math.trunc(value)));
}

export async function createSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    return sandbox.getSession(id);
  }
}

export async function createFreshSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  try {
    await sandbox.deleteSession(id);
  } catch (error) {
    if (!isSandboxSessionAlreadyGone(error, id)) throw error;
  }
  try {
    return await createNewSandboxSession(sandbox, id, cwd, env);
  } catch (error) {
    if (!isSandboxSessionAlreadyExists(error, id)) throw error;
    throw new Error(`fresh sandbox session ${id} still exists after delete`, { cause: error });
  }
}

export async function runSandboxSetupStep(
  step: string,
  operation: () => Promise<unknown>,
): Promise<void> {
  try {
    await operation();
  } catch (error) {
    const message = clean(error instanceof Error ? error.message : String(error), 500);
    throw new Error(`${step}: ${message || "failed"}`);
  }
}

async function createNewSandboxSession(
  sandbox: CloudflareSandbox,
  id: string,
  cwd: string,
  env: Record<string, string | undefined>,
): Promise<SandboxExecutionSession> {
  return sandbox.createSession({
    id,
    cwd,
    env: compactEnvVars(env),
    commandTimeoutMs: 300_000,
  });
}

function compactEnvVars(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function clean(value: unknown, maximum: number): string {
  return String(value ?? "")
    .trim()
    .slice(0, maximum);
}
