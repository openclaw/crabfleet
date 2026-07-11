import type { RuntimeEnv } from "./env.ts";

export function githubActionsRelayStub(env: RuntimeEnv, sessionId: string) {
  if (!env.SESSION_CONTROL) return null;
  const id = env.SESSION_CONTROL.idFromName(`github-actions:${sessionId}`);
  return env.SESSION_CONTROL.get(id);
}
