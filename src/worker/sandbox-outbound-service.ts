import type { RuntimeEnv } from "./env.ts";
import { sandboxCredentialPolicyHasDurableOwner } from "./sandbox-credential-policy-repository.ts";
import { repairLegacySandboxCredentialPolicyBatch } from "./sandbox-credential-policy-cleanup-service.ts";
import { routeSandboxOutbound, type SandboxOutboundContext } from "./sandbox-outbound.ts";
import { sandboxControlStub } from "./session-control-do.ts";
import type { SandboxCredentialPolicy } from "./session-control-policy.ts";

export async function sandboxCredentialPolicy(
  env: RuntimeEnv,
  sandboxId: string,
): Promise<SandboxCredentialPolicy | null> {
  const stub = sandboxControlStub(env);
  if (!stub) return null;
  const policyUrl = `https://crabfleet.internal/api/session-control/egress/${encodeURIComponent(sandboxId)}`;
  let response = await stub.fetch(policyUrl);
  if (response.status === 409) {
    const legacy = (await response.json().catch(() => null)) as { sessionId?: unknown } | null;
    const legacySessionId = clean(legacy?.sessionId, 120);
    if (legacySessionId) {
      await repairLegacySandboxCredentialPolicyBatch(env, Date.now(), legacySessionId);
      response = await stub.fetch(policyUrl);
    }
  }
  if (!response.ok) return null;
  const generation = response.headers.get("x-crabfleet-policy-generation");
  const policy = (await response.json().catch(() => null)) as SandboxCredentialPolicy | null;
  if (
    !generation ||
    !policy ||
    !(await sandboxCredentialPolicyHasDurableOwner(env, sandboxId, generation, policy, Date.now()))
  ) {
    return null;
  }
  return policy;
}

export function sandboxOutbound(
  request: Request,
  env: RuntimeEnv,
  context: SandboxOutboundContext,
): Promise<Response> {
  return routeSandboxOutbound(request, env, context, {
    readCredentialPolicy: sandboxCredentialPolicy,
  });
}

function clean(value: unknown, maximum: number): string {
  return typeof value === "string" ? value.trim().slice(0, maximum) : "";
}
