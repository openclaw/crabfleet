import { appCanonicalOrigin } from "../canonical-host.ts";
import { trustedProxyPublicOrigin, type TrustedProxyEnv } from "../trusted-proxy-auth.ts";
import { configuredHttpOrigin } from "../url-security.ts";

export type PublicDeploymentConfig = {
  label: string;
  canonicalUrl: string;
  productUrl: string;
};

export type DeploymentEnv = TrustedProxyEnv & {
  CRABFLEET_LABEL?: string;
  CRABFLEET_CANONICAL_URL?: string;
  CRABFLEET_PRODUCT_URL?: string;
};

export function publicDeploymentConfig(env: DeploymentEnv): PublicDeploymentConfig {
  return {
    label: env.CRABFLEET_LABEL?.trim().slice(0, 80) || "Crabfleet",
    canonicalUrl: browserAppOrigin(env),
    productUrl: configuredHttpOrigin(env.CRABFLEET_PRODUCT_URL, "https://crabfleet.ai"),
  };
}

export function browserAppOrigin(env: DeploymentEnv): string {
  return (
    trustedProxyPublicOrigin(env) ??
    configuredHttpOrigin(env.CRABFLEET_CANONICAL_URL, appCanonicalOrigin)
  );
}

export function browserRequestOrigin(request: Request, env: DeploymentEnv): string {
  return trustedProxyPublicOrigin(env) ?? new URL(request.url).origin;
}
