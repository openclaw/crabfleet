import type { RuntimeEnv } from "./env.ts";
import { sandboxCredentialPolicyHasDurableOwner } from "./sandbox-credential-policy-repository.ts";
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
  const response = await stub.fetch(policyUrl);
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
